const test = require('node:test');
const assert = require('node:assert');
const E = require('../server/engine');
const S = require('../server/scheduler');
const Z = (iso) => Date.parse(iso);
const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };

function data(n = 3, w = 8) {
  const g = E.newState(w, w); g.settings = { ...g.settings, shrinkEnabled: false, shrinkEvery: 3 };
  const ps = []; for (let i = 0; i < n; i++) { const p = E.addPlayer(g, 'P' + i); Object.assign(p, { x: i, y: 0 }); ps.push(p); }
  E.start(g); const d = { game: g, events: [], eventId: 1 };
  S.onStart(d, Z('2026-06-10T10:00:00Z'), () => 0.5);   // 12:00 Amsterdam, before the first 17:00
  return { d, g, ps };
}

test('17:00 slot is correct across both daylight-saving changes', () => {
  assert.strictEqual(S.dueSlot(Z('2026-10-24T14:59:59Z')), '2026-10-23');  // CEST: 17:00 = 15:00Z
  assert.strictEqual(S.dueSlot(Z('2026-10-24T15:00:00Z')), '2026-10-24');
  assert.strictEqual(S.dueSlot(Z('2026-10-26T15:59:59Z')), '2026-10-25');  // CET: 17:00 = 16:00Z
  assert.strictEqual(S.dueSlot(Z('2026-10-26T16:00:00Z')), '2026-10-26');
  assert.strictEqual(S.dueSlot(Z('2026-03-28T15:59:59Z')), '2026-03-27');  // spring change on 29 March
  assert.strictEqual(S.dueSlot(Z('2026-03-30T15:00:00Z')), '2026-03-30');
});
test('nothing happens before 17:00; AP once at 17:00; repeat runs do nothing', () => {
  const { d, g, ps } = data();
  S.runDue(d, Z('2026-06-10T14:59:00Z'), () => 0.5); assert.strictEqual(ps[0].ap, 0);
  S.runDue(d, Z('2026-06-10T15:00:00Z'), () => 0.5); assert.strictEqual(ps[0].ap, 1); assert.strictEqual(g.day, 1);
  for (let i = 0; i < 5; i++) S.runDue(d, Z('2026-06-10T16:00:00Z'), () => 0.5); assert.strictEqual(ps[0].ap, 1);
});
test('dead, eliminated and haunted players get no AP; haunting lasts one day', () => {
  const { d, g, ps } = data(4);
  ps[0].alive = false; ps[1].permanentlyEliminated = true; ps[1].alive = false; ps[2].haunted = true;
  S.runDue(d, Z('2026-06-10T15:00:00Z'), () => 0.5);
  assert.deepStrictEqual(ps.map(p => p.ap), [0, 0, 0, 1]);
  S.runDue(d, Z('2026-06-11T15:00:00Z'), () => 0.5); assert.strictEqual(ps[2].ap, 1);
});
test('server downtime: missed days are caught up exactly once each', () => {
  const { d, g, ps } = data(); S.runDue(d, Z('2026-06-13T15:30:00Z'), () => 0.5);
  assert.strictEqual(g.day, 4); assert.strictEqual(ps[0].ap, 4);   // 10th, 11th, 12th and 13th
});
test('heart spawns once, only on a free square, at its random time', () => {
  const { d, g } = data(2, 4);
  S.runDue(d, Z('2026-06-10T15:00:00Z'), () => 0.5);          // tick plans spawn up to 24h later (rng .5 => +12h)
  assert.strictEqual(g.hearts.length, 0);
  S.runDue(d, Z('2026-06-11T03:00:01Z'), () => 0.5);
  assert.strictEqual(g.hearts.length, 1);
  assert.ok(!g.players.some(p => p.x === g.hearts[0].x && p.y === g.hearts[0].y));
  S.runDue(d, Z('2026-06-11T04:00:00Z'), () => 0.5); assert.strictEqual(g.hearts.length, 1);
});
test('spawn is postponed while the board is full, then happens', () => {
  const { d, g } = data(2, 2);
  const [a, b] = g.players; Object.assign(a, { x: 0, y: 0 }); Object.assign(b, { x: 1, y: 0 });
  const extra = [{ id: 90, name: 'x', x: 0, y: 1 }, { id: 91, name: 'y', x: 1, y: 1 }].map(p => ({ hearts: 1, ap: 0, rangeLevel: 0, alive: true, haunted: false, ...p }));
  g.players.push(...extra);
  S.runDue(d, Z('2026-06-10T15:00:00Z'), () => 0.5);
  g.nextSpawnAt = 0; g.spawnPending = true;
  S.runDue(d, Z('2026-06-10T15:01:00Z'), () => 0.5);
  assert.strictEqual(g.hearts.length, 0); assert.ok(g.spawnPending);
  g.players.pop();
  S.runDue(d, Z('2026-06-10T15:02:00Z'), () => 0.5);
  assert.strictEqual(g.hearts.length, 1); assert.deepStrictEqual([g.hearts[0].x, g.hearts[0].y], [1, 1]);
});
test('shrinking OFF never changes the board', () => {
  const { d, g } = data(); for (let i = 0; i < 9; i++) S.runDue(d, Z(`2026-06-${11 + i}T15:00:00Z`), () => 0.5);
  assert.deepStrictEqual(g.bounds, { x0: 0, y0: 0, x1: 7, y1: 7 });
});
test('shrinking ON: warns a day early, shrinks every 3rd day, eliminates and clears hearts', () => {
  const { d, g, ps } = data(4, 8); g.settings.shrinkEnabled = true; Object.assign(ps[3], { x: 6, y: 6 });
  Object.assign(ps[0], { x: 0, y: 4 });   // left column: lost on the 1st shrink
  Object.assign(ps[1], { x: 3, y: 3 }); ps[2].alive = false; Object.assign(ps[2], { x: 4, y: 0 }); // top row, dead
  g.hearts.push({ id: 70, x: 0, y: 0 }, { id: 71, x: 5, y: 5 });
  S.runDue(d, Z('2026-06-10T15:00:00Z'), () => 0.5); S.runDue(d, Z('2026-06-11T15:00:00Z'), () => 0.5);
  assert.ok(d.events.some(e => e.type === 'warn')); assert.strictEqual(g.shrinkCount, 0);
  S.runDue(d, Z('2026-06-12T15:00:00Z'), () => 0.5);
  assert.strictEqual(g.shrinkCount, 1); assert.deepStrictEqual(g.bounds, { x0: 1, y0: 1, x1: 7, y1: 7 });
  assert.ok(!ps[0].alive && ps[0].permanentlyEliminated);
  assert.ok(ps[1].alive);
  assert.ok(!ps[2].alive && ps[2].permanentlyEliminated);
  assert.deepStrictEqual(g.hearts.map(h => h.id), [71]);
  for (let i = 3; i <= 5; i++) S.runDue(d, Z(`2026-06-${9 + i + 1}T15:00:00Z`), () => 0.5);
  assert.deepStrictEqual(g.bounds, { x0: 1, y0: 1, x1: 6, y1: 6 });
});
test('a permanently eliminated player cannot be revived', () => {
  const { g, ps } = data(2); Object.assign(ps[0], { x: 3, y: 3, hearts: 3 }); Object.assign(ps[1], { x: 3, y: 4, alive: false, permanentlyEliminated: true });
  assert.throws(() => E.gift(g, ps[0].id, ps[1].id, 'hearts', 1), /permanently/);
});
