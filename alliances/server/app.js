'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const E = require('./engine');
const A = require('./auth');
const S = require('./scheduler');
const Adm = require('./admin');
const EG = require('./endgame');

function createApp(store, { adminCode, secret }) {
  const loginLimit = A.makeLimiter(8, 60_000);
  const clients = new Set();
  const push = () => clients.forEach(c => c.write('data: update\n\n'));
  const safeEq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };

  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const body = (req) => new Promise((ok, no) => { let s = ''; req.on('data', d => { s += d; if (s.length > 1e5) no(new Error('Too large')); }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(new E.GameError('Invalid JSON')); } }); });
  const who = (req) => A.readToken(secret, (req.headers.authorization || '').replace('Bearer ', '')) || (new URL(req.url, 'http://x').searchParams.get('t') && A.readToken(secret, new URL(req.url, 'http://x').searchParams.get('t')));

  // Record events; private text is stored per recipient id.
  const record = (d, events) => events.forEach(e => d.events.push({ id: d.eventId++, ts: Date.now(), day: d.game.day, type: e.type, pub: e.pub, priv: e.priv }));
  const notesFor = (d, id) => d.events.slice(-100).map(e => ({ id: e.id, ts: e.ts, day: e.day, text: (e.priv && e.priv[id]) || e.pub })).filter(n => n.text);

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x'), p = url.pathname, ip = req.socket.remoteAddress;
    try {
      if (req.method === 'GET' && (p === '/' || p === '/index.html'))
        { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, '../public/index.html'))); }

      if (req.method === 'POST' && (p === '/api/login' || p === '/api/admin/login')) {
        if (!loginLimit(ip)) return send(res, 429, { error: 'Too many attempts. Wait a minute.' });
        const { code } = await body(req);
        if (p === '/api/admin/login') {
          if (!safeEq(code, adminCode)) return send(res, 401, { error: 'Wrong code' });
          return send(res, 200, { token: A.signToken(secret, { role: 'admin' }) });
        }
        if (!A.validCode(code)) return send(res, 401, { error: 'Wrong code' });
        const id = await store.withState(d => Object.keys(d.accounts).find(k => A.verifyCode(code, d.accounts[k])));
        if (!id) return send(res, 401, { error: 'Wrong code' });
        return send(res, 200, { token: A.signToken(secret, { role: 'player', id: Number(id) }) });
      }

      const me = who(req);
      if (!me) return send(res, 401, { error: 'Please log in' });

      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write('data: hello\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
      }
      if (req.method === 'GET' && p === '/api/state') {
        return send(res, 200, await store.withState(d => me.role === 'admin'
          ? { role: 'admin', game: d.game, events: d.events.slice(-200), log: (d.adminLog || []).slice(-200) }   // admin sees everything incl. AP
          : { role: 'player', me: me.id, ...E.viewFor(d.game, me.id), notes: notesFor(d, me.id) }));
      }

      if (req.method === 'GET' && p === '/api/history') {
        // Players get the public version only. The admin also sees private lines (which may name AP).
        return send(res, 200, await store.withState(d => ({ days: d.events.slice(-2000).flatMap(e => {
          const rows = e.pub ? [{ id: e.id, ts: e.ts, day: e.day, text: e.pub }] : [];
          if (me.role === 'admin') for (const t of Object.values(e.priv || {})) rows.push({ id: e.id, ts: e.ts, day: e.day, text: '(private) ' + t });
          return rows;
        }) })));
      }

      if (req.method === 'POST' && p === '/api/action') {
        if (me.role !== 'player') return send(res, 403, { error: 'Players only' });
        const a = await body(req);
        await store.withState(d => {
          const g = d.game, id = me.id;   // the acting player always comes from the session, never the request
          const evs = a.type === 'move' ? E.move(g, id, a.x, a.y) : a.type === 'shoot' ? E.shoot(g, id, a.target)
            : a.type === 'heal' ? E.heal(g, id) : a.type === 'upgrade' ? E.upgrade(g, id)
            : a.type === 'propose' ? EG.propose(g, id, a.ranking) : a.type === 'respond' ? EG.respond(g, id, a.accept === true) : a.type === 'vote' ? E.vote(g, id, a.target) : a.type === 'gift' ? E.gift(g, id, a.target, a.kind, a.amount) : (() => { throw new E.GameError('Unknown action'); })();
          record(d, evs.concat(EG.check(g)));
        });
        push(); return send(res, 200, { ok: true });
      }

      if (p.startsWith('/api/admin/')) {
        if (me.role !== 'admin') return send(res, 403, { error: 'Admin only' });
        const a = await body(req);
        await store.withState(d => {
          if (p === '/api/admin/players') Adm.run(d, 'addPlayer', a);
          else if (p === '/api/admin/start') Adm.run(d, 'start', a);
          else if (p === '/api/admin/settings') Adm.run(d, 'settings', a);
          else if (p === '/api/admin/do') Adm.run(d, a.cmd, a);
          else throw new E.GameError('Unknown admin route');
        });
        push(); return send(res, 200, { ok: true });
      }
      send(res, 404, { error: 'Not found' });
    } catch (e) { send(res, e instanceof E.GameError ? 400 : 500, { error: e instanceof E.GameError ? e.message : 'Server error' }); if (!(e instanceof E.GameError)) console.error(e); }
  }
  // Background loop: runs whether or not anyone has the site open.
  const tick = () => store.withState(d => S.runDue(d, Date.now())).then(o => o.length && push()).catch(e => console.error('scheduler', e));
  const server = http.createServer(handle);
  server.runScheduler = tick;
  return server;
}
module.exports = { createApp };
