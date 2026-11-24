'use strict';
// Pure game engine. Every action takes the whole game state and either throws
// GameError (state untouched) or mutates it and returns events.
// The server runs each action under one database lock, so actions are serialized.
const R = require('./rules');

class GameError extends Error {}
const fail = (m) => { throw new GameError(m); };

const defaultSettings = () => ({ apPerDay: 1, maxHearts: null, healCost: 3, upgradeCost: 2, moveCost: 1, shootCost: 1 });

function newState(width = 16, height = 16) {
  return { phase: 'lobby', day: 0, bounds: { x0: 0, y0: 0, x1: width - 1, y1: height - 1 },
    shrinkCount: 0, jury: { votes: {}, lastResult: null }, players: [], hearts: [], nextId: 1, settings: defaultSettings() };
}
const get = (s, id) => s.players.find(p => p.id === id) || fail('Unknown player');
const at = (s, x, y) => s.players.find(p => p.x === x && p.y === y);
const name = (s, id) => get(s, id).name;
const ev = (type, pub, priv = {}) => ({ type, pub, priv });

function addPlayer(s, playerName, rng = Math.random) {
  if (s.phase !== 'lobby') fail('Players can only be added before the game starts');
  const b = s.bounds, free = [];
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) if (!at(s, x, y)) free.push([x, y]);
  if (!free.length) fail('Grid is full');
  const [x, y] = free[Math.floor(rng() * free.length)];
  const p = { id: s.nextId++, name: playerName, x, y, hearts: 3, ap: 0, rangeLevel: 0,
    alive: true, permanentlyEliminated: false, haunted: false };
  s.players.push(p);
  return p;
}

function requireActive(s, id) {
  if (s.phase !== 'running') fail('The game is not running');
  const p = get(s, id);
  if (!p.alive) fail('Dead players cannot act');
  return p;
}
const spend = (p, cost) => { if (p.ap < cost) fail('Not enough AP'); p.ap -= cost; };

function move(s, id, x, y) {
  const p = requireActive(s, id);
  if (Math.abs(x - p.x) + Math.abs(y - p.y) !== 1) fail('You can only move one square up, down, left or right');
  if (!R.inBounds(s.bounds, x, y)) fail('That square is outside the grid');
  if (at(s, x, y)) fail('That square is occupied');
  spend(p, s.settings.moveCost);
  p.x = x; p.y = y;
  const events = [ev('move', `${p.name} moved to (${x},${y})`)];
  const i = s.hearts.findIndex(h => h.x === x && h.y === y);
  if (i >= 0) {
    s.hearts.splice(i, 1);
    giveHeart(s, p, 1);
    events.push(ev('collect', `${p.name} collected a heart`));
  }
  return events;
}

function shoot(s, id, targetId) {
  const p = requireActive(s, id);
  if (id === targetId) fail('You cannot shoot yourself');
  const t = get(s, targetId);
  if (!t.alive) fail('That player is already dead');
  if (!R.inRange(p.rangeLevel, p.x, p.y, t.x, t.y)) fail('Target is out of range');
  spend(p, s.settings.shootCost);
  t.hearts -= 1;
  const events = [ev('shoot', `${p.name} shot ${t.name}`, { [t.id]: `${p.name} shot you` })];
  if (t.hearts <= 0) {
    t.hearts = 0; t.alive = false;
    const loot = t.ap; p.ap += loot; t.ap = 0;
    events.push(ev('death', `${p.name} killed ${t.name}`,
      { [p.id]: `You killed ${t.name} and took ${loot} AP`, [t.id]: `You were killed by ${p.name}` }));
  }
  return events;
}

function giveHeart(s, p, n) {
  const max = s.settings.maxHearts;
  p.hearts = max ? Math.min(max, p.hearts + n) : p.hearts + n;
}

function heal(s, id) {
  const p = requireActive(s, id);
  spend(p, s.settings.healCost);
  giveHeart(s, p, 1);
  return [ev('heal', `${p.name} added a heart`)];
}

function upgrade(s, id) {
  const p = requireActive(s, id);
  spend(p, s.settings.upgradeCost);
  p.rangeLevel += 1;
  return [ev('upgrade', `${p.name} upgraded their shooting range`)];
}

function gift(s, id, targetId, kind, amount) {
  const p = requireActive(s, id);
  if (!Number.isInteger(amount) || amount < 1) fail('Amount must be a whole number of at least 1');
  if (id === targetId) fail('You cannot send resources to yourself');
  const t = get(s, targetId);
  if (t.permanentlyEliminated) fail('That player is permanently eliminated');
  if (!R.inRange(p.rangeLevel, p.x, p.y, t.x, t.y)) fail('Target is out of range');
  if (kind === 'hearts') {
    if (!t.alive) amount = 1;                       // a revival takes exactly one heart
    if (p.hearts <= amount) fail('You must keep at least 1 heart');
    p.hearts -= amount;
    if (!t.alive) {
      t.alive = true; t.hearts = 1; t.ap = 0;
      return [ev('revive', `${p.name} revived ${t.name}`, { [t.id]: `${p.name} revived you` })];
    }
    giveHeart(s, t, amount);
    return [ev('gift', `${p.name} sent ${t.name} ${amount} heart(s)`, { [t.id]: `${p.name} sent you ${amount} heart(s)` })];
  }
  if (kind === 'ap') {
    if (!t.alive) fail('You cannot send AP to a dead player');
    if (p.ap < amount) fail('Not enough AP');
    p.ap -= amount; t.ap += amount;
    // Public text never includes the amount.
    return [ev('gift', `${p.name} sent ${t.name} some Action Points`, { [t.id]: `${p.name} sent you ${amount} AP` })];
  }
  fail('Unknown gift type');
}

// Jury: dead players secretly vote once per day for a living player to haunt.
function vote(s, id, targetId) {
  if (s.phase !== 'running') fail('The game is not running');
  const v = get(s, id);
  if (v.alive) fail('Only dead players can vote');
  const t = get(s, targetId);
  if (id === targetId) fail('You cannot vote for yourself');
  if (!t.alive) fail('You can only vote for a living player');
  s.jury ||= { votes: {}, lastResult: null };
  if (s.jury.votes[id] != null) fail('You have already voted today');
  s.jury.votes[id] = targetId;
  return [];                                   // secret: nothing is announced until voting closes
}

// Close voting: most votes wins; a tie haunts nobody. Votes from revived players are discarded.
function closeVoting(s) {
  const votes = s.jury?.votes || {}, tally = {};
  for (const [vid, tid] of Object.entries(votes)) {
    const v = s.players.find(p => p.id === Number(vid)), t = s.players.find(p => p.id === tid);
    if (v && !v.alive && t && t.alive) tally[tid] = (tally[tid] || 0) + 1;
  }
  s.jury = { votes: {}, lastResult: null };
  const top = Math.max(0, ...Object.values(tally)), winners = Object.keys(tally).filter(k => tally[k] === top);
  if (!top) return [];
  if (winners.length !== 1) { s.jury.lastResult = { haunted: null }; return [ev('jury', 'The jury could not agree. Nobody is haunted')]; }
  const t = get(s, Number(winners[0])); t.haunted = true;
  s.jury.lastResult = { haunted: t.id };
  return [ev('jury', `The jury haunted ${t.name}. They get no Action Points today`, { [t.id]: 'You are haunted: you get no Action Points at 17:00' })];
}

function start(s) {
  if (s.phase !== 'lobby') fail('Game already started');
  if (s.players.length < 2) fail('Need at least 2 players');
  s.phase = 'running';
  return [ev('phase', 'The game has started')];
}

// Public view: never exposes AP (own AP only for the viewer).
function viewFor(s, viewerId) {
  return { phase: s.phase, day: s.day, bounds: s.bounds, hearts: s.hearts,
    players: s.players.map(p => {
      const o = { id: p.id, name: p.name, x: p.x, y: p.y, hearts: p.hearts, rangeLevel: p.rangeLevel,
        range: R.rangeFor(p.rangeLevel), alive: p.alive, permanentlyEliminated: p.permanentlyEliminated };
      if (p.id === viewerId) o.ap = p.ap;
      return o;
    }),
    negotiation: s.negotiation || null,      // votes are public by design: everyone sees who accepted
    result: s.result || null,
    // Jury info: a dead viewer sees only their own vote, never anyone else's.
    jury: { lastResult: s.jury?.lastResult || null,
      me: (() => { const v = s.players.find(p => p.id === viewerId); return v && !v.alive
        ? { eligible: true, votedFor: s.jury?.votes?.[viewerId] ?? null } : { eligible: false }; })() } };
}

module.exports = { GameError, newState, addPlayer, start, move, shoot, heal, upgrade, gift, vote, closeVoting, viewFor };
