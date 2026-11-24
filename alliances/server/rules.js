// Pure game rules: no I/O, so they can be unit-tested and reused by the server.
'use strict';

const START = { hearts: 3, ap: 0, rangeLevel: 0 };

// Range level 0 => reach 3 in every direction (a 7x7 block). Each upgrade adds +1.
// h/v/d are kept equal to n so older code reading them keeps working.
const BASE_REACH = 3;
function rangeFor(level) {
  const n = BASE_REACH + level;
  return { n, h: n, v: n, d: n };
}

// Filled square: anything within n squares in both directions is reachable
// (Chebyshev distance), including the knight-style squares in between.
function inRange(level, x1, y1, x2, y2) {
  const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
  if (dx === 0 && dy === 0) return false;
  return Math.max(dx, dy) <= BASE_REACH + level;
}

// All squares a player could target, for the highlight overlay.
function squaresInRange(level, x, y, width, height) {
  const out = [];
  for (let ty = 0; ty < height; ty++)
    for (let tx = 0; tx < width; tx++)
      if (inRange(level, x, y, tx, ty)) out.push([tx, ty]);
  return out;
}

const inBounds = (b, x, y) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;

// Shrink by one row and one column, alternating sides to stay centred:
// even shrink count removes left column + top row, odd removes right + bottom.
function shrinkBounds(b, shrinkCount) {
  const n = { ...b };
  if (shrinkCount % 2 === 0) { n.x0++; n.y0++; } else { n.x1--; n.y1--; }
  if (n.x1 < n.x0 || n.y1 < n.y0) throw new Error('Grid cannot shrink further');
  return n;
}

// Classify everything left outside the new bounds.
function applyShrink(newBounds, players, hearts) {
  const eliminated = [], unrevivable = [];
  for (const p of players) {
    if (p.permanentlyEliminated || inBounds(newBounds, p.x, p.y)) continue;
    (p.alive ? eliminated : unrevivable).push(p.id);
  }
  const removedHearts = hearts.filter(h => !inBounds(newBounds, h.x, h.y)).map(h => h.id);
  return { eliminated, unrevivable, removedHearts };
}

// Hand out a whole-grid check: who would be hit by a resize (for admin confirmation).
const previewResize = applyShrink;

module.exports = { START, rangeFor, inRange, squaresInRange, inBounds, shrinkBounds, applyShrink, previewResize };
