'use strict';
// Endgame: death order, last-player-standing, and the negotiated top three.
const E = require('./engine');
const fail = (m) => { throw new E.GameError(m); };
const ev = (type, pub) => ({ type, pub, priv: {} });

// Remember who died when. Deaths found in the same sync share one number, so they tie.
function syncDeaths(g) {
  let seq = null;
  for (const p of g.players) {
    if (p.alive) delete p.diedSeq;                       // a revived player is no longer "dead"
    else if (p.diedSeq === undefined) { if (seq === null) seq = g.deathSeq = (g.deathSeq || 0) + 1; p.diedSeq = seq; }
  }
}

// Final places: the agreed order first (if any), then living players (tied), then the dead, latest death first.
function ranking(g, agreed = null) {
  const out = []; let place = 1;
  for (const id of agreed || []) out.push({ id, place: place++ });
  const rest = g.players.filter(p => !(agreed || []).includes(p.id));
  const k = (p) => (p.alive ? Infinity : p.diedSeq ?? 0);
  rest.sort((a, b) => k(b) - k(a));
  for (let i = 0; i < rest.length;) {
    let j = i; while (j < rest.length && k(rest[j]) === k(rest[i])) j++;
    for (let m = i; m < j; m++) out.push({ id: rest[m].id, place });
    place += j - i; i = j;
  }
  return out.map(r => ({ ...r, name: g.players.find(p => p.id === r.id).name }));
}

function finalize(g, mode, agreed = null) {
  syncDeaths(g);
  g.phase = 'ended'; g.negotiation = null;
  g.result = { mode, ranking: ranking(g, agreed) };
  const w = g.result.ranking.filter(r => r.place === 1).map(r => r.name).join(' and ');
  return ev('phase', `The game is over. Winner: ${w}`);
}

// Run after every change to the game. Cheap and safe to call repeatedly.
function check(g) {
  if (g.phase !== 'running') return [];
  syncDeaths(g);
  const out = [], alive = g.players.filter(p => p.alive);
  if (g.players.length >= 2 && alive.length <= 1) return [finalize(g, 'last')];
  const mode = g.settings.endgameMode || 'top3';
  const ids = alive.map(p => p.id).sort((a, b) => a - b);
  if (mode === 'top3' && (ids.length === 3 || ids.length === 4)) {
    if (!g.negotiation || g.negotiation.participants.join() !== ids.join()) {
      g.negotiation = { participants: ids, proposal: null, votes: {} };
      out.push(ev('negotiation', `${ids.length} players remain. They can now agree on the final ranking`));
    }
  } else g.negotiation = null;
  return out;
}

function neg(g, id) {
  if (g.phase !== 'running') fail('The game is not running');
  if (!g.negotiation) fail('There is no negotiation right now');
  if (!g.negotiation.participants.includes(id)) fail('Only the remaining players can negotiate');
  return g.negotiation;
}
function propose(g, id, order) {
  const n = neg(g, id);
  const ok = Array.isArray(order) && order.length === n.participants.length && new Set(order).size === order.length && order.every(x => n.participants.includes(x));
  if (!ok) fail('A ranking must list every remaining player exactly once');
  n.proposal = { by: id, ranking: order }; n.votes = { [id]: true };
  return [ev('negotiation', `${g.players.find(p => p.id === id).name} proposed a ranking`)];
}
function respond(g, id, accept) {
  const n = neg(g, id);
  if (!n.proposal) fail('There is no proposal to answer yet');
  n.votes[id] = !!accept;
  const out = [ev('negotiation', `${g.players.find(p => p.id === id).name} ${accept ? 'accepted' : 'rejected'} the proposal`)];
  if (n.participants.every(p => n.votes[p] === true)) out.push(finalize(g, 'top3', n.proposal.ranking));
  return out;
}
module.exports = { syncDeaths, ranking, finalize, check, propose, respond };
