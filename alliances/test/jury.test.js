const test = require('node:test');
const assert = require('node:assert');
const E = require('../server/engine');
const S = require('../server/scheduler');
const Z = (iso) => Date.parse(iso), R5 = () => 0.5;
const throwsGame = (f, re) => assert.throws(f, (e) => e instanceof E.GameError && re.test(e.message));

function setup() {
  const g = E.newState(10, 10); const ps = ['A', 'B', 'C', 'D', 'E'].map((n, i) => Object.assign(E.addPlayer(g, n), { x: i * 2, y: 0 }));
  E.start(g); const d = { game: g, events: [], eventId: 1 }; S.onStart(d, Z('2026-06-10T10:00:00Z'), R5);
  const [A, B, C, D, Ee] = ps; D.alive = false; D.hearts = 0; Ee.alive = false; Ee.hearts = 0;   // D and E are the jury
  return { d, g, A, B, C, D, E: Ee };
}

test('voting rules', () => {
  const { g, A, B, D, E: Ee } = setup();
  throwsGame(() => E.vote(g, A.id, B.id), /Only dead/);
  throwsGame(() => E.vote(g, D.id, D.id), /yourself|living/);
  throwsGame(() => E.vote(g, D.id, Ee.id), /living/);
  E.vote(g, D.id, A.id);
  throwsGame(() => E.vote(g, D.id, B.id), /already voted/);
});
test('votes are secret: a juror sees only their own vote', () => {
  const { g, A, D, E: Ee } = setup(); E.vote(g, D.id, A.id);
  assert.strictEqual(E.viewFor(g, D.id).jury.me.votedFor, A.id);
  assert.strictEqual(E.viewFor(g, Ee.id).jury.me.votedFor, null);
  assert.ok(!JSON.stringify(E.viewFor(g, A.id)).includes('votes'));
  assert.strictEqual(E.viewFor(g, A.id).jury.me.eligible, false);
});
test('majority haunts: result announced at 16:55, haunted player misses exactly one AP', () => {
  const { d, g, A, B, C, D, E: Ee } = setup();
  S.runDue(d, Z('2026-06-10T15:00:00Z'), R5);              // day 1 tick, everyone alive gets 1
  E.vote(g, D.id, A.id); E.vote(g, Ee.id, A.id);
  S.runDue(d, Z('2026-06-11T14:54:00Z'), R5); assert.ok(!A.haunted);            // 16:54 summer time
  S.runDue(d, Z('2026-06-11T14:55:00Z'), R5);
  assert.ok(A.haunted); assert.ok(d.events.some(e => e.type === 'jury' && /haunted A/.test(e.pub)));
  assert.deepStrictEqual(g.jury.votes, {});
  S.runDue(d, Z('2026-06-11T15:00:00Z'), R5);
  assert.deepStrictEqual([A.ap, B.ap, C.ap], [1, 2, 2]); assert.ok(!A.haunted);
  S.runDue(d, Z('2026-06-12T15:00:00Z'), R5); assert.strictEqual(A.ap, 2);
});
test('tie haunts nobody; no votes means no event', () => {
  const { d, g, A, B, D, E: Ee } = setup();
  E.vote(g, D.id, A.id); E.vote(g, Ee.id, B.id);
  S.runDue(d, Z('2026-06-10T14:56:00Z'), R5);
  assert.ok(!A.haunted && !B.haunted); assert.ok(d.events.some(e => /could not agree/.test(e.pub)));
  const n = d.events.length; S.runDue(d, Z('2026-06-11T14:56:00Z'), R5);
  assert.ok(!d.events.slice(n).some(e => e.type === 'jury'));
});
test('a revived juror loses their vote and is not counted', () => {
  const { d, g, A, B, D, E: Ee } = setup();
  E.vote(g, D.id, A.id); E.vote(g, Ee.id, B.id);
  D.alive = true; D.hearts = 1;                              // revived before the vote closed
  S.runDue(d, Z('2026-06-10T15:00:00Z'), R5);
  assert.strictEqual(A.ap, 1);                               // D's vote for A was discarded, so A is not haunted
  assert.strictEqual(B.ap, 0);                               // E's valid vote haunted B, who misses this AP
});
test('permanently eliminated players stay on the jury', () => {
  const { g, A, D } = setup(); D.permanentlyEliminated = true;
  assert.doesNotThrow(() => E.vote(g, D.id, A.id));
});
test('closing runs once even if called repeatedly', () => {
  const { d, g, A, D } = setup(); E.vote(g, D.id, A.id);
  for (let i = 0; i < 4; i++) S.runDue(d, Z('2026-06-10T14:58:00Z'), R5);
  assert.strictEqual(d.events.filter(e => e.type === 'jury').length, 1);
});
