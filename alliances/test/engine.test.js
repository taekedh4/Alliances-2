const test = require('node:test');
const assert = require('node:assert');
const E = require('../server/engine');

function game() {
  const s = E.newState(10, 10);
  const mk = (n, x, y, ap = 0) => { const p = E.addPlayer(s, n); Object.assign(p, { x, y, ap }); return p; };
  const a = mk('A', 5, 5, 5), b = mk('B', 5, 7, 4), c = mk('C', 0, 0);
  E.start(s);
  return { s, a, b, c };
}
const throwsGame = (f, re) => assert.throws(f, (e) => e instanceof E.GameError && re.test(e.message));

test('random starts never overlap', () => {
  const s = E.newState(3, 3);
  for (let i = 0; i < 9; i++) E.addPlayer(s, 'p' + i);
  assert.strictEqual(new Set(s.players.map(p => p.x + ',' + p.y)).size, 9);
});
test('move: cost, adjacency, occupancy, bounds', () => {
  const { s, a, b } = game();
  E.move(s, a.id, 5, 6); assert.strictEqual(a.ap, 4);
  throwsGame(() => E.move(s, a.id, 6, 7), /one square/);           // diagonal
  throwsGame(() => E.move(s, a.id, 5, 7), /occupied|one square/);
  a.x = 5; a.y = 6; throwsGame(() => E.move(s, a.id, 5, 7), /occupied/);
  const { s: s2, c } = game(); c.ap = 3;
  throwsGame(() => E.move(s2, c.id, -1, 0), /outside/);
});
test('move onto dead player square is blocked', () => {
  const { s, a, b } = game(); b.alive = false; a.x = 5; a.y = 6;
  throwsGame(() => E.move(s, a.id, 5, 7), /occupied/);
});
test('move with 0 AP fails and leaves state unchanged', () => {
  const { s, c } = game();
  throwsGame(() => E.move(s, c.id, 1, 0), /Not enough AP/);
  assert.deepStrictEqual([c.x, c.y], [0, 0]);
});
test('collect spawned heart', () => {
  const { s, a } = game(); s.hearts.push({ id: 1, x: 5, y: 4 });
  E.move(s, a.id, 5, 4); assert.strictEqual(a.hearts, 4); assert.strictEqual(s.hearts.length, 0);
});
test('shoot: range, self, cost', () => {
  const { s, a, b, c } = game();
  E.shoot(s, a.id, b.id); assert.strictEqual(b.hearts, 2); assert.strictEqual(a.ap, 4);
  throwsGame(() => E.shoot(s, a.id, c.id), /range/);
  throwsGame(() => E.shoot(s, a.id, a.id), /yourself/);
});
test('kill transfers all victim AP to the killer; dead cannot be shot or act', () => {
  const { s, a, b } = game(); b.hearts = 1;
  const ev = E.shoot(s, a.id, b.id);
  assert.strictEqual(b.alive, false); assert.strictEqual(b.ap, 0); assert.strictEqual(a.ap, 4 + 4);
  assert.ok(ev.some(e => e.type === 'death'));
  throwsGame(() => E.shoot(s, a.id, b.id), /already dead/);
  throwsGame(() => E.move(s, b.id, 6, 7), /Dead/);
});
test('heal costs 3, upgrade costs 2 and extends range', () => {
  const { s, a, c } = game();
  E.heal(s, a.id); assert.strictEqual(a.hearts, 4); assert.strictEqual(a.ap, 2);
  E.upgrade(s, a.id); assert.strictEqual(a.rangeLevel, 1);
  throwsGame(() => E.heal(s, a.id), /Not enough/);
  a.x = 5; a.y = 5; c.x = 5; c.y = 9; a.ap = 1; assert.doesNotThrow(() => E.shoot(s, a.id, c.id));
});
test('gifts: range, resources, keep one heart, no self-gifts', () => {
  const { s, a, b, c } = game();
  E.gift(s, a.id, b.id, 'ap', 2); assert.strictEqual(a.ap, 3); assert.strictEqual(b.ap, 6);
  throwsGame(() => E.gift(s, a.id, b.id, 'ap', 9), /Not enough/);
  throwsGame(() => E.gift(s, a.id, c.id, 'ap', 1), /range/);
  throwsGame(() => E.gift(s, a.id, b.id, 'hearts', 3), /at least 1 heart/);
  E.gift(s, a.id, b.id, 'hearts', 2); assert.strictEqual(a.hearts, 1); assert.strictEqual(b.hearts, 5);
});
test('revive: exactly 1 heart, 0 AP, keeps range and position', () => {
  const { s, a, b } = game(); b.alive = false; b.hearts = 0; b.ap = 0; b.rangeLevel = 2;
  const ev = E.gift(s, a.id, b.id, 'hearts', 2);
  assert.ok(b.alive); assert.strictEqual(b.hearts, 1); assert.strictEqual(a.hearts, 2);
  assert.strictEqual(b.rangeLevel, 2); assert.deepStrictEqual([b.x, b.y], [5, 7]); assert.strictEqual(ev[0].type, 'revive');
});
test('permanently eliminated cannot be revived', () => {
  const { s, a, b } = game(); b.alive = false; b.permanentlyEliminated = true;
  throwsGame(() => E.gift(s, a.id, b.id, 'hearts', 1), /permanently/);
});
test('dead players cannot gift', () => {
  const { s, a, b } = game(); a.alive = false;
  throwsGame(() => E.gift(s, a.id, b.id, 'ap', 1), /Dead/);
});
test('views never leak other players AP or public events leak AP', () => {
  const { s, a, b } = game();
  const v = E.viewFor(s, a.id);
  assert.strictEqual(v.players.find(p => p.id === a.id).ap, 5);
  assert.ok(!('ap' in v.players.find(p => p.id === b.id)));
  const ev = E.gift(s, a.id, b.id, 'ap', 2);
  assert.ok(!/\d/.test(ev[0].pub.replace(/[AB]/g, '')));
});
test('actions rejected outside a running game', () => {
  const s = E.newState(5, 5); const p = E.addPlayer(s, 'X'); p.ap = 5;
  throwsGame(() => E.heal(s, p.id), /not running/);
});
