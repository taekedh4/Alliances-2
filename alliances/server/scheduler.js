'use strict';
// Daily mechanics. Everything here is a pure function of (data, now), run under the store lock.
// "Exactly once": data.game.lastTickDay records the last processed 17:00 slot, and the lock
// (a Postgres row lock) means two instances or a restart can never process the same slot twice.
const R = require('./rules');
const E = require('./engine');
const EG = require('./endgame');
const TZ = 'Europe/Amsterdam', HOUR = 17;

const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function localParts(ts) {
  const o = {}; for (const p of fmt.formatToParts(new Date(ts))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, min: +o.minute };
}
const key = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function addDays(k, n) { const [y, m, d] = k.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return key(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }
// The most recent 17:00 (Netherlands time) slot at or before `now`, as a date key.
function dueSlot(now) { const p = localParts(now), today = key(p.y, p.m, p.d); return p.h >= HOUR ? today : addDays(today, -1); }

const cfg = (s) => ({ shrinkEnabled: false, shrinkEvery: 3, juryCloseMinutes: 16 * 60 + 55, ...s.settings });
const ev = (type, pub) => ({ type, pub, priv: {} });

function onStart(d, now, rng = Math.random) {
  d.game.lastTickDay = dueSlot(now);
  d.game.lastJuryDay = d.game.lastTickDay;
  planSpawn(d.game, now, rng);
  return [];
}
function planSpawn(g, now, rng) { g.nextSpawnAt = now + Math.floor(rng() * 864e5); g.spawnPending = true; }

function dayTick(g, now, rng) {
  const c = cfg(g), out = [];
  g.day += 1;
  for (const p of g.players) {
    if (p.alive && !p.permanentlyEliminated && !p.haunted) p.ap += c.apPerDay;
    p.haunted = false;                       // a haunting only lasts for one distribution
  }
  out.push(ev('ap', `Day ${g.day} begins. Action Points were distributed`));
  if (c.shrinkEnabled) {
    if ((g.day + 1) % c.shrinkEvery === 0) out.push(ev('warn', 'The board will shrink at the next 17:00'));
    if (g.day % c.shrinkEvery === 0) out.push(...shrink(g));
  }
  planSpawn(g, now, rng);
  return out;
}

// Move the board edges and apply the consequences to everything that ends up outside.
function applyBounds(g, nb, type, text) {
  const r = R.applyShrink(nb, g.players, g.hearts);
  g.bounds = nb;
  const byId = (id) => g.players.find(p => p.id === id);
  const out = [ev(type, text)];
  for (const id of r.eliminated) { const p = byId(id); p.alive = false; p.hearts = 0; p.permanentlyEliminated = true; out.push(ev('eliminated', `${p.name} was lost when the board shrank`)); }
  for (const id of r.unrevivable) byId(id).permanentlyEliminated = true;
  g.hearts = g.hearts.filter(h => !r.removedHearts.includes(h.id));
  return out;
}
function shrink(g) {
  const nb = R.shrinkBounds(g.bounds, g.shrinkCount);
  const out = applyBounds(g, nb, 'shrink', `The board shrank to ${nb.x1 - nb.x0 + 1}×${nb.y1 - nb.y0 + 1}`);
  g.shrinkCount += 1;
  return out;
}

function trySpawn(g, rng) {
  const b = g.bounds, free = [];
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++)
    if (!g.players.some(p => p.x === x && p.y === y) && !g.hearts.some(h => h.x === x && h.y === y)) free.push([x, y]);
  if (!free.length) return null;                 // stays pending; retried on the next run
  const [x, y] = free[Math.floor(rng() * free.length)];
  g.hearts.push({ id: g.nextId++, x, y });
  g.spawnPending = false;
  return ev('spawn', `A heart appeared at (${x},${y})`);
}

function juryDue(g, up, now) {
  const p = localParts(now), k = key(p.y, p.m, p.d);
  return k > up || (k === up && p.h * 60 + p.min >= cfg(g).juryCloseMinutes);
}

// Run everything that is due. Safe to call as often as you like.
function runDue(d, now, rng = Math.random) {
  const g = d.game, out = [];
  if (g.phase !== 'running' || !g.lastTickDay) return out;
  const due = dueSlot(now);
  // Voting for a day closes at juryCloseMinutes (default 16:55), before that day's 17:00 AP tick,
  // so a haunting always lands on the distribution straight after it.
  for (;;) {
    const up = addDays(g.lastTickDay, 1), tickDue = g.lastTickDay < due;
    if ((tickDue || juryDue(g, up, now)) && (g.lastJuryDay || '') < up) { out.push(...E.closeVoting(g)); g.lastJuryDay = up; }
    if (!tickDue) break;
    g.lastTickDay = up; out.push(...dayTick(g, now, rng));
  }
  if (g.spawnPending && now >= g.nextSpawnAt) { const e = trySpawn(g, rng); if (e) out.push(e); }
  out.push(...EG.check(g));
  for (const e of out) d.events.push({ id: d.eventId++, ts: now, day: g.day, type: e.type, pub: e.pub, priv: e.priv });
  return out;
}
module.exports = { applyBounds, planSpawn, dueSlot, addDays, onStart, runDue, shrink, trySpawn };
