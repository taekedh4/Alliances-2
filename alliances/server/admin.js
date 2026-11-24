'use strict';
// Admin commands. Each runs under the store lock, validates, changes state, and writes the activity log.
const E = require('./engine');
const R = require('./rules');
const S = require('./scheduler');
const EG = require('./endgame');
const A = require('./auth');
const fail = (m) => { throw new E.GameError(m); };
const int = (v, name, min = 0, max = 1e6) => { if (!Number.isInteger(v) || v < min || v > max) fail(`${name} must be a whole number from ${min} to ${max}`); return v; };

function run(d, cmd, a = {}, now = Date.now(), rng = Math.random) {
  runInner(d, cmd, a, now, rng);
  for (const e of EG.check(d.game)) d.events.push({ id: d.eventId++, ts: now, day: d.game.day, type: e.type, pub: e.pub, priv: e.priv });
}
function runInner(d, cmd, a, now, rng) {
  const g = d.game;
  d.adminLog ||= []; d.logId ||= 1;
  const log = (text) => d.adminLog.push({ id: d.logId++, ts: now, text });
  const notify = (p, text) => d.events.push({ id: d.eventId++, ts: now, day: g.day, type: 'admin', pub: null, priv: { [p.id]: text } });
  const pl = () => g.players.find(p => p.id === a.id) || fail('Unknown player');
  const confirmed = (msg) => { if (!a.confirm) fail('CONFIRM: ' + msg); };
  const note = (events) => events.forEach(e => d.events.push({ id: d.eventId++, ts: now, day: g.day, type: e.type, pub: e.pub, priv: e.priv }));
  const free = (x, y) => !g.players.some(p => p.x === x && p.y === y);

  switch (cmd) {
    case 'addPlayer': {
      if (!a.name || !String(a.name).trim()) fail('A name is required');
      if (!A.validCode(a.code)) fail('The code must be exactly 7 digits');
      if (Object.values(d.accounts).some(h => A.verifyCode(a.code, h))) fail('That code is already used');
      const p = E.addPlayer(g, String(a.name).trim().slice(0, 30), rng);
      d.accounts[p.id] = A.hashCode(a.code); log(`Added player ${p.name}`); return;
    }
    case 'rename': { const p = pl(); const n = String(a.name || '').trim().slice(0, 30); if (!n) fail('A name is required'); log(`Renamed ${p.name} to ${n}`); p.name = n; return; }
    case 'setCode': {
      const p = pl(); if (!A.validCode(a.code)) fail('The code must be exactly 7 digits');
      if (Object.entries(d.accounts).some(([id, h]) => Number(id) !== p.id && A.verifyCode(a.code, h))) fail('That code is already used');
      d.accounts[p.id] = A.hashCode(a.code); log(`Changed the code of ${p.name}`); return;
    }
    case 'removePlayer': {
      const p = pl(); confirmed(`Remove ${p.name} from the game permanently?`);
      g.players = g.players.filter(q => q !== p); delete d.accounts[p.id];
      const v = g.jury?.votes || {}; delete v[p.id]; for (const k of Object.keys(v)) if (v[k] === p.id) delete v[k];
      log(`Removed player ${p.name}`); return;
    }
    case 'addHearts': {
      const p = pl(), n = int(a.amount, 'Amount', -1000, 1000);
      if (!p.alive && n > 0) fail('This player is dead. Use Revive instead');
      if (!p.alive) fail('This player is already dead');
      p.hearts += n; log(`${n >= 0 ? 'Added' : 'Removed'} ${Math.abs(n)} heart(s) ${n >= 0 ? 'to' : 'from'} ${p.name}`);
      if (p.hearts <= 0) { p.hearts = 0; p.alive = false; log(`${p.name} died (hearts reached 0)`); }
      notify(p, `An admin changed your hearts by ${n}`); return;
    }
    case 'addAp': {
      const p = pl(), n = int(a.amount, 'Amount', -1e6, 1e6);
      p.ap = Math.max(0, p.ap + n); log(`${n >= 0 ? 'Added' : 'Removed'} ${Math.abs(n)} AP ${n >= 0 ? 'to' : 'from'} ${p.name}`);
      notify(p, `An admin changed your Action Points by ${n}`); return;
    }
    case 'setRange': { const p = pl(); p.rangeLevel = int(a.level, 'Range level', 0, 50); log(`Set the range level of ${p.name} to ${p.rangeLevel}`); return; }
    case 'move': {
      const p = pl(), x = int(a.x, 'x', -1e3, 1e3), y = int(a.y, 'y', -1e3, 1e3);
      if (!R.inBounds(g.bounds, x, y)) fail('That square is outside the grid');
      if (!free(x, y)) fail('That square is occupied');
      p.x = x; p.y = y; log(`Moved ${p.name} to (${x},${y})`);
      const i = g.hearts.findIndex(h => h.x === x && h.y === y);
      if (i >= 0) { g.hearts.splice(i, 1); p.hearts += 1; log(`${p.name} collected a heart at (${x},${y})`); }
      return;
    }
    case 'revive': {
      const p = pl();
      if (p.alive) fail('This player is alive');
      if (p.permanentlyEliminated) fail('This player is permanently eliminated and cannot be revived');
      p.alive = true; p.hearts = 1; p.ap = 0; log(`Revived ${p.name}`); notify(p, 'An admin revived you'); return;
    }
    case 'eliminate': {
      const p = pl(); confirmed(`Permanently eliminate ${p.name}? They can never be revived.`);
      p.alive = false; p.hearts = 0; p.permanentlyEliminated = true; log(`Permanently eliminated ${p.name}`); notify(p, 'An admin permanently eliminated you'); return;
    }
    case 'spawnHeart': {
      let x = a.x, y = a.y;
      if (x == null) { const was = g.spawnPending; const e = S.trySpawn(g, rng); g.spawnPending = was; if (!e) fail('There is no free square'); note([e]); log(e.pub); return; }
      int(x, 'x', -1e3, 1e3); int(y, 'y', -1e3, 1e3);
      if (!R.inBounds(g.bounds, x, y) || !free(x, y) || g.hearts.some(h => h.x === x && h.y === y)) fail('That square is not free');
      g.hearts.push({ id: g.nextId++, x, y }); note([{ type: 'spawn', pub: `A heart appeared at (${x},${y})`, priv: {} }]); log(`Spawned a heart at (${x},${y})`); return;
    }
    case 'removeHeart': {
      const i = g.hearts.findIndex(h => h.id === a.id); if (i < 0) fail('Unknown heart');
      const [h] = g.hearts.splice(i, 1); log(`Removed the heart at (${h.x},${h.y})`); return;
    }
    case 'resize': {
      const w = int(a.width, 'Width', 2, 100), h = int(a.height, 'Height', 2, 100), b = g.bounds;
      const nb = { x0: b.x0, y0: b.y0, x1: b.x0 + w - 1, y1: b.y0 + h - 1 };
      const r = R.applyShrink(nb, g.players, g.hearts);
      if (r.eliminated.length || r.unrevivable.length || r.removedHearts.length)
        confirmed(`This resize removes ${r.eliminated.length} living player(s) (permanently eliminated), makes ${r.unrevivable.length} dead player(s) unrevivable and removes ${r.removedHearts.length} heart(s).`);
      const old = `${b.x1 - b.x0 + 1}×${b.y1 - b.y0 + 1}`;
      note(S.applyBounds(g, nb, 'resize', `The board is now ${w}×${h}`)); log(`Changed the grid from ${old} to ${w}×${h}`); return;
    }
    case 'shrinkNow': {
      const nb = R.shrinkBounds(g.bounds, g.shrinkCount), r = R.applyShrink(nb, g.players, g.hearts);
      if (r.eliminated.length || r.unrevivable.length || r.removedHearts.length) confirmed(`This shrink eliminates ${r.eliminated.length} living player(s).`);
      const old = `${g.bounds.x1 - g.bounds.x0 + 1}×${g.bounds.y1 - g.bounds.y0 + 1}`;
      note(S.shrink(g)); log(`Manually shrank the grid from ${old}`); return;
    }
    case 'start': note(E.start(g)); S.onStart(d, now, rng); log('Started the game'); return;
    case 'pause': if (g.phase !== 'running') fail('The game is not running'); g.phase = 'paused'; log('Paused the game'); return;
    case 'resume': {
      if (g.phase !== 'paused') fail('The game is not paused');
      g.phase = 'running'; S.onStart(d, now, rng); log('Resumed the game. Days that passed while paused were skipped'); return;  // no catch-up flood
    }
    case 'end': confirmed('End the game now? The current standings become the final result.'); note([EG.finalize(g, 'admin')]); log('Ended the game'); return;
    case 'reset': {
      confirmed('Reset the game? Everyone goes back to the start with new random positions. Accounts are kept.');
      const old = g.players, b = g.bounds, w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1, st = g.settings;
      const fresh = E.newState(w, h); fresh.settings = st; fresh.nextId = g.nextId;
      for (const p of old) { const q = E.addPlayer(fresh, p.name, rng); q.id = p.id; }
      Object.assign(g, fresh); d.events = []; d.eventId = 1; log('Reset the game'); return;
    }
    case 'settings': {
      const st = g.settings;
      const ints = { apPerDay: [0, 100], healCost: [1, 100], upgradeCost: [1, 100], shrinkEvery: [1, 100], juryCloseMinutes: [0, 1019] };
      for (const [k, [lo, hi]] of Object.entries(ints)) if (a[k] !== undefined) st[k] = int(a[k], k, lo, hi);
      if (a.maxHearts !== undefined) st.maxHearts = a.maxHearts === null ? null : int(a.maxHearts, 'maxHearts', 1, 1000);
      if (typeof a.shrinkEnabled === 'boolean') st.shrinkEnabled = a.shrinkEnabled;
      if (a.endgameMode !== undefined) { if (!['top3', 'last'].includes(a.endgameMode)) fail('Unknown endgame mode'); st.endgameMode = a.endgameMode; }
      log('Changed settings: ' + Object.keys(a).filter(k => k !== 'confirm').join(', ')); return;
    }
    default: fail('Unknown admin command');
  }
}
module.exports = { run };
