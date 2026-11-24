const test = require('node:test');
const assert = require('node:assert');
const E = require('../server/engine');
const EG = require('../server/endgame');
const S = require('../server/scheduler');
const Adm = require('../server/admin');
const bad = (f, re) => assert.throws(f, (e) => e instanceof E.GameError && re.test(e.message));

function game(n, mode) {
  const g = E.newState(10, 10); g.settings.endgameMode = mode;
  const ps = Array.from({ length: n }, (_, i) => Object.assign(E.addPlayer(g, 'P' + (i + 1)), { x: i, y: 0 }));
  E.start(g); EG.check(g); return { g, ps };
}
const kill = (g, p) => { p.alive = false; p.hearts = 0; return EG.check(g); };
const places = (g) => Object.fromEntries(g.result.ranking.map(r => [r.name, r.place]));

test('last standing: ends at one survivor; places follow death order', () => {
  const { g, ps } = game(4, 'last');
  kill(g, ps[3]); kill(g, ps[1]); assert.strictEqual(g.phase, 'running');
  kill(g, ps[2]);
  assert.strictEqual(g.phase, 'ended');
  assert.deepStrictEqual(places(g), { P1: 1, P3: 2, P2: 3, P4: 4 });
  assert.strictEqual(g.negotiation, null);
});
test('simultaneous deaths tie; nobody left alive ties for first', () => {
  const { g, ps } = game(3, 'last'); ps.forEach(p => { p.alive = false; }); EG.check(g);
  assert.deepStrictEqual(places(g), { P1: 1, P2: 1, P3: 1 });
});
test('a revived player is not treated as dead', () => {
  const { g, ps } = game(3, 'last'); kill(g, ps[2]);
  ps[2].alive = true; ps[2].hearts = 1; EG.check(g); assert.strictEqual(ps[2].diedSeq, undefined);
  kill(g, ps[1]); kill(g, ps[2]); assert.deepStrictEqual(places(g), { P1: 1, P3: 2, P2: 3 });
});
test('negotiation starts at 4 and 3 living players, not at 5 or 2', () => {
  const { g, ps } = game(6, 'top3'); assert.strictEqual(g.negotiation, null);
  kill(g, ps[5]); assert.strictEqual(g.negotiation, null);          // 5 alive
  kill(g, ps[4]); assert.strictEqual(g.negotiation.participants.length, 4);
  kill(g, ps[3]); assert.strictEqual(g.negotiation.participants.length, 3);
  kill(g, ps[2]); assert.strictEqual(g.negotiation, null); assert.strictEqual(g.phase, 'running');   // 2 alive
});
test('unanimous acceptance of a 4-player ranking ends the game and records places', () => {
  const { g, ps } = game(5, 'top3'); kill(g, ps[4]);
  const [a, b, c, d] = ps.slice(0, 4).map(p => p.id);
  bad(() => EG.propose(g, ps[4].id, [a, b, c, d]), /Only the remaining/);
  bad(() => EG.propose(g, a, [a, b, c]), /exactly once/);
  bad(() => EG.propose(g, a, [a, a, c, d]), /exactly once/);
  EG.propose(g, a, [b, a, c, d]);
  EG.respond(g, b, true); EG.respond(g, c, true); assert.strictEqual(g.phase, 'running');
  EG.respond(g, d, true);
  assert.strictEqual(g.phase, 'ended');
  assert.deepStrictEqual(places(g), { P2: 1, P1: 2, P3: 3, P4: 4, P5: 5 });
});
test('a rejection keeps the game going; a new proposal resets every vote', () => {
  const { g, ps } = game(4, 'top3'); const ids = ps.map(p => p.id);
  EG.propose(g, ids[0], ids); EG.respond(g, ids[1], true); EG.respond(g, ids[2], false); EG.respond(g, ids[3], true);
  assert.strictEqual(g.phase, 'running'); assert.strictEqual(g.negotiation.votes[ids[2]], false);
  EG.propose(g, ids[2], [ids[2], ...ids.filter(i => i !== ids[2])]);
  assert.deepStrictEqual(g.negotiation.votes, { [ids[2]]: true });
});
test('responding needs a proposal; a death resets the negotiation for the new group', () => {
  const { g, ps } = game(4, 'top3'); const ids = ps.map(p => p.id);
  bad(() => EG.respond(g, ids[0], true), /no proposal/);
  EG.propose(g, ids[0], ids); EG.respond(g, ids[1], true);
  kill(g, ps[3]);
  assert.strictEqual(g.negotiation.participants.length, 3); assert.strictEqual(g.negotiation.proposal, null);
});
test('three players can agree and end the game', () => {
  const { g, ps } = game(3, 'top3'); const ids = ps.map(p => p.id);
  EG.propose(g, ids[0], [ids[2], ids[1], ids[0]]); EG.respond(g, ids[1], true); EG.respond(g, ids[2], true);
  assert.deepStrictEqual(places(g), { P3: 1, P2: 2, P1: 3 });
});
test('after the game ends nothing can change: no votes, no actions', () => {
  const { g, ps } = game(3, 'top3'); const ids = ps.map(p => p.id);
  EG.propose(g, ids[0], ids); EG.respond(g, ids[1], true); EG.respond(g, ids[2], true);
  bad(() => EG.respond(g, ids[1], false), /not running/);
  bad(() => EG.propose(g, ids[1], ids), /not running/);
  ps[0].ap = 5; bad(() => E.heal(g, ids[0]), /not running/);
});
test('top-three mode still ends when one player is left', () => {
  const { g, ps } = game(3, 'top3'); kill(g, ps[2]); kill(g, ps[1]);
  assert.strictEqual(g.phase, 'ended'); assert.deepStrictEqual(places(g), { P1: 1, P2: 2, P3: 3 });
});
test('last-standing mode never opens a negotiation', () => {
  const { g, ps } = game(5, 'last'); kill(g, ps[4]); kill(g, ps[3]); assert.strictEqual(g.negotiation, null);
});
test('negotiation votes are public but AP never leaks', () => {
  const { g, ps } = game(3, 'top3'); const ids = ps.map(p => p.id); ps[1].ap = 7;
  EG.propose(g, ids[0], ids); EG.respond(g, ids[1], false);
  const v = E.viewFor(g, ids[0]);
  assert.strictEqual(v.negotiation.votes[ids[1]], false); assert.ok(!('ap' in v.players.find(p => p.id === ids[1])));
});
test('a shrink that eliminates everyone but one ends the game via the scheduler', () => {
  const { g, ps } = game(3, 'last');
  Object.assign(ps[0], { x: 5, y: 5 }); Object.assign(ps[1], { x: 0, y: 5 }); Object.assign(ps[2], { x: 5, y: 0 });
  const d = { game: g, events: [], eventId: 1 }; g.lastTickDay = '2026-06-09'; g.lastJuryDay = '2026-06-09'; g.settings.shrinkEnabled = true; g.settings.shrinkEvery = 1;
  S.runDue(d, Date.parse('2026-06-10T15:00:00Z'), () => 0.5);
  assert.strictEqual(g.phase, 'ended'); assert.strictEqual(places(g).P1, 1);
});
test('admin end freezes the current standings', () => {
  const { g, ps } = game(4, 'last'); const d = { game: g, events: [], eventId: 1, accounts: {} };
  kill(g, ps[3]);
  assert.throws(() => Adm.run(d, 'end', {}), /^CONFIRM|CONFIRM/);
  Adm.run(d, 'end', { confirm: true });
  assert.strictEqual(g.phase, 'ended'); assert.strictEqual(places(g).P4, 4);
});
