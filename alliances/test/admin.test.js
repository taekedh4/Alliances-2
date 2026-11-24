const test = require('node:test');
const assert = require('node:assert');
const E = require('../server/engine');
const Adm = require('../server/admin');
const S = require('../server/scheduler');
const Z = (iso) => Date.parse(iso);
const bad = (f, re) => assert.throws(f, (e) => e instanceof E.GameError && re.test(e.message));

function setup(started = true) {
  const d = { game: E.newState(8, 8), accounts: {}, events: [], eventId: 1 };
  const run = (cmd, a = {}) => Adm.run(d, cmd, a, Z('2026-06-10T10:00:00Z'), () => 0.5);
  ['A', 'B', 'C'].forEach((n, i) => run('addPlayer', { name: n, code: '100000' + i }));
  const [A, B, C] = d.game.players; Object.assign(A, { x: 1, y: 1 }); Object.assign(B, { x: 2, y: 1 }); Object.assign(C, { x: 7, y: 7 });
  if (started) run('start');
  return { d, g: d.game, run, A, B, C };
}

test('player management and codes', () => {
  const { d, run, A } = setup(false);
  bad(() => run('addPlayer', { name: 'X', code: '12' }), /7 digits/);
  bad(() => run('addPlayer', { name: 'X', code: '1000000' }), /already used/);
  run('rename', { id: A.id, name: 'Anna' }); assert.strictEqual(A.name, 'Anna');
  bad(() => run('setCode', { id: A.id, code: '1000001' }), /already used/);
  run('setCode', { id: A.id, code: '5555555' });
  assert.ok(!JSON.stringify(d.accounts).includes('5555555'));
});
test('resources: AP never negative, hearts can kill, dead need Revive', () => {
  const { g, run, A, B } = setup(); A.ap = 2;
  run('addAp', { id: A.id, amount: -5 }); assert.strictEqual(A.ap, 0);
  run('addAp', { id: A.id, amount: 4 }); assert.strictEqual(A.ap, 4);
  run('addHearts', { id: B.id, amount: -3 }); assert.ok(!B.alive && B.hearts === 0);
  bad(() => run('addHearts', { id: B.id, amount: 1 }), /Revive/);
  run('revive', { id: B.id }); assert.ok(B.alive && B.hearts === 1 && B.ap === 0);
  run('setRange', { id: A.id, level: 2 }); assert.strictEqual(A.rangeLevel, 2);
});
test('revive rules; eliminate needs confirmation and is permanent', () => {
  const { run, A, B } = setup(); bad(() => run('revive', { id: A.id }), /alive/);
  bad(() => run('eliminate', { id: B.id }), /^CONFIRM/);
  assert.ok(B.alive);
  run('eliminate', { id: B.id, confirm: true });
  assert.ok(B.permanentlyEliminated && !B.alive);
  bad(() => run('revive', { id: B.id }), /permanently/);
});
test('admin move: bounds, occupancy, collects hearts', () => {
  const { g, run, A } = setup();
  bad(() => run('move', { id: A.id, x: 2, y: 1 }), /occupied/);
  bad(() => run('move', { id: A.id, x: 8, y: 1 }), /outside/);
  g.hearts.push({ id: 50, x: 4, y: 4 }); run('move', { id: A.id, x: 4, y: 4 });
  assert.deepStrictEqual([A.x, A.y, A.hearts, g.hearts.length], [4, 4, 4, 0]);
});
test('hearts: manual spawn on free squares, removal', () => {
  const { g, run } = setup();
  run('spawnHeart', {}); assert.strictEqual(g.hearts.length, 1);
  run('spawnHeart', { x: 5, y: 5 });
  bad(() => run('spawnHeart', { x: 1, y: 1 }), /not free/);
  run('removeHeart', { id: g.hearts[0].id }); assert.strictEqual(g.hearts.length, 1);
});
test('resize: growing is free; shrinking that would eliminate needs confirmation and changes nothing until confirmed', () => {
  const { g, run, A, B, C } = setup(); B.alive = false; Object.assign(B, { x: 6, y: 0 });
  g.hearts.push({ id: 60, x: 7, y: 0 });
  run('resize', { width: 12, height: 12 }); assert.strictEqual(g.bounds.x1, 11);
  run('resize', { width: 8, height: 8 }); assert.strictEqual(g.bounds.x1, 7);
  bad(() => run('resize', { width: 6, height: 6 }), /^CONFIRM.*1 living player/);
  assert.strictEqual(g.bounds.x1, 7); assert.ok(C.alive);
  run('resize', { width: 6, height: 6, confirm: true });
  assert.deepStrictEqual(g.bounds, { x0: 0, y0: 0, x1: 5, y1: 5 });
  assert.ok(!C.alive && C.permanentlyEliminated);
  assert.ok(B.permanentlyEliminated && !B.alive);       // dead player outside: stays dead, loses revival
  assert.ok(A.alive); assert.strictEqual(g.hearts.length, 0);
  bad(() => run('resize', { width: 1, height: 5 }), /Width/);
});
test('pause blocks actions; resume skips missed days instead of flooding AP', () => {
  const { d, g, run, A } = setup();
  run('pause'); bad(() => E.heal(g, A.id), /not running/);
  S.runDue(d, Z('2030-01-01T00:00:00Z'), () => 0.5); assert.strictEqual(g.day, 0);   // paused: nothing runs
  Adm.run(d, 'resume', {}, Z('2026-06-20T10:00:00Z'), () => 0.5);
  S.runDue(d, Z('2026-06-20T11:00:00Z'), () => 0.5); assert.strictEqual(A.ap, 0);
  S.runDue(d, Z('2026-06-20T15:00:00Z'), () => 0.5); assert.strictEqual(A.ap, 1);
});
test('reset keeps accounts and settings, restores the start state', () => {
  const { d, g, run, A } = setup(); Object.assign(A, { ap: 9, hearts: 7, rangeLevel: 3 }); g.hearts.push({ id: 1, x: 0, y: 0 });
  g.settings.apPerDay = 2; bad(() => run('reset'), /^CONFIRM/);
  run('reset', { confirm: true });
  assert.strictEqual(g.phase, 'lobby'); assert.strictEqual(g.day, 0); assert.strictEqual(g.hearts.length, 0);
  const a = g.players.find(p => p.id === A.id);
  assert.deepStrictEqual([a.ap, a.hearts, a.rangeLevel, a.alive], [0, 3, 0, true]);
  assert.strictEqual(g.settings.apPerDay, 2); assert.strictEqual(Object.keys(d.accounts).length, 3);
});
test('remove player cleans account and votes', () => {
  const { d, g, run, B, C } = setup(); C.alive = false; g.jury.votes[C.id] = B.id;
  bad(() => run('removePlayer', { id: B.id }), /^CONFIRM/);
  run('removePlayer', { id: B.id, confirm: true });
  assert.ok(!g.players.some(p => p.id === B.id)); assert.ok(!(B.id in d.accounts)); assert.deepStrictEqual(g.jury.votes, {});
});
test('settings are validated; every action is logged with a time', () => {
  const { d, run } = setup();
  bad(() => run('settings', { apPerDay: -1 }), /apPerDay/);
  bad(() => run('settings', { endgameMode: 'nope' }), /endgame/);
  run('settings', { apPerDay: 2, shrinkEnabled: true, shrinkEvery: 4, endgameMode: 'last', maxHearts: 10 });
  assert.strictEqual(d.game.settings.shrinkEvery, 4);
  assert.ok(d.adminLog.length >= 5 && d.adminLog.every(l => l.ts && l.text));
  assert.ok(d.adminLog.some(l => /Started the game/.test(l.text)));
});
