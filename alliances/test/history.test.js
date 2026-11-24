const test = require('node:test');
const assert = require('node:assert');
const E = require('../server/engine');
const S = require('../server/scheduler');
const Adm = require('../server/admin');
const EG = require('../server/endgame');
const { PgStore, MemoryStore } = require('../server/store');
const { createApp } = require('../server/app');

test('no public event text ever contains an AP amount, across a whole busy game', () => {
  const d = { game: E.newState(8, 8), accounts: {}, events: [], eventId: 1 };
  const now = Date.parse('2026-06-10T10:00:00Z'), rng = () => 0.5;
  ['Ann', 'Bob', 'Cy', 'Di'].forEach((n, i) => Adm.run(d, 'addPlayer', { name: n, code: '200000' + i }, now, rng));
  const [a, b, c] = d.game.players; Object.assign(a, { x: 1, y: 1, ap: 9 }); Object.assign(b, { x: 2, y: 2, ap: 8 }); Object.assign(c, { x: 4, y: 4, ap: 7 });
  Adm.run(d, 'start', {}, now, rng);
  const rec = (evs) => evs.forEach(e => d.events.push({ id: d.eventId++, day: d.game.day, ...e }));
  rec(E.gift(d.game, a.id, b.id, 'ap', 3)); rec(E.shoot(d.game, a.id, b.id)); rec(E.upgrade(d.game, a.id)); rec(E.heal(d.game, b.id));
  b.hearts = 1; rec(E.shoot(d.game, a.id, b.id));              // a kill: the victim's AP moves to the killer
  S.runDue(d, Date.parse('2026-06-10T15:00:00Z'), rng); Adm.run(d, 'addAp', { id: a.id, amount: 5 }, now, rng);
  const pub = d.events.map(e => e.pub).filter(Boolean);
  assert.ok(pub.length >= 6);
  for (const t of pub) assert.ok(!/\d+\s*(AP|Action Point)/i.test(t), t);
  assert.ok(d.events.some(e => Object.values(e.priv || {}).some(t => /\d+ AP/.test(t))));   // private lines do carry amounts
});

test('history endpoint: players get public lines only, admin also gets private lines', async () => {
  const store = new MemoryStore(), srv = createApp(store, { adminCode: 'adm', secret: 's' });
  await new Promise(r => srv.listen(0, r)); const base = 'http://127.0.0.1:' + srv.address().port;
  const call = async (p, body, t) => (await fetch(base + p, { method: body ? 'POST' : 'GET', body: body && JSON.stringify(body), headers: t ? { authorization: 'Bearer ' + t } : {} })).json();
  try {
    const adm = (await call('/api/admin/login', { code: 'adm' })).token;
    await call('/api/admin/players', { name: 'Ann', code: '1111111' }, adm); await call('/api/admin/players', { name: 'Bob', code: '2222222' }, adm);
    await call('/api/admin/start', {}, adm);
    await store.withState(d => { const [a, b] = d.game.players; Object.assign(a, { x: 0, y: 0, ap: 5 }); Object.assign(b, { x: 1, y: 0 }); });
    const ann = (await call('/api/login', { code: '1111111' })).token;
    await call('/api/action', { type: 'gift', kind: 'ap', target: 2, amount: 2 }, ann);
    const pl = JSON.stringify((await call('/api/history', null, ann)).days), ad = JSON.stringify((await call('/api/history', null, adm)).days);
    assert.ok(/sent Bob some Action Points/.test(pl) && !/2 AP/.test(pl));
    assert.ok(/2 AP/.test(ad));
    assert.ok(!(await call('/api/history')).days);
  } finally { srv.close(); }
});

test('PgStore: locks the row, saves on success, rolls back on error, always releases', async () => {
  const log = []; let row = JSON.stringify({ n: 1, events: [] });
  const client = { async query(sql, args) { log.push(sql.split(' ')[0] + (/FOR UPDATE/.test(sql) ? ' FOR UPDATE' : '')); if (/^SELECT/.test(sql)) return { rows: [{ data: JSON.parse(row) }] }; if (/^UPDATE/.test(sql)) row = args[0]; return { rows: [] }; }, release() { log.push('release'); } };
  const store = new PgStore({ connect: async () => client, query: async () => ({}) });
  await store.withState(d => { d.n = 2; });
  assert.deepStrictEqual(log, ['BEGIN', 'SELECT FOR UPDATE', 'UPDATE', 'COMMIT', 'release']); assert.strictEqual(JSON.parse(row).n, 2);
  log.length = 0;
  await assert.rejects(store.withState(d => { d.n = 99; throw new Error('boom'); }), /boom/);
  assert.deepStrictEqual(log, ['BEGIN', 'SELECT FOR UPDATE', 'ROLLBACK', 'release']); assert.strictEqual(JSON.parse(row).n, 2);
});
