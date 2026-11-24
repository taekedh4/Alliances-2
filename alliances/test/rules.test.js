const test = require('node:test');
const assert = require('node:assert');
const R = require('../server/rules');

test('starting range is a filled 7x7 square, including knight-style squares', () => {
  const c = [[-1,0,true],[2,0,true],[0,-3,true],[0,4,false],[1,1,true],[3,3,true],[4,4,false],
             [2,1,true],[1,2,true],[3,2,true],[-3,-2,true],[4,1,false],[1,-4,false],[3,0,true],[4,0,false]];
  for (const [dx, dy, ok] of c) assert.strictEqual(R.inRange(0, 5, 5, 5+dx, 5+dy), ok, `${dx},${dy}`);
});
test('cannot target own square', () => assert.strictEqual(R.inRange(0,2,2,2,2), false));
test('each upgrade grows the square by 1 in every direction', () => {
  assert.strictEqual(R.rangeFor(0).n, 3); assert.strictEqual(R.rangeFor(1).n, 4); assert.strictEqual(R.rangeFor(4).n, 7);
  assert.ok(R.inRange(1,5,5,9,9)); assert.ok(!R.inRange(1,5,5,10,5)); assert.ok(R.inRange(1,5,5,9,3));
});
test('squaresInRange counts at level 0 in open field', () => {
  // 7x7 block minus the player's own square
  assert.strictEqual(R.squaresInRange(0,8,8,17,17).length, 48);
  assert.strictEqual(R.squaresInRange(0,0,0,17,17).length, 15);   // clipped at a corner: 4x4 - 1
});
test('shrink alternates sides and stays centred', () => {
  let b = {x0:0,y0:0,x1:15,y1:15};
  b = R.shrinkBounds(b,0); assert.deepStrictEqual(b,{x0:1,y0:1,x1:15,y1:15});
  b = R.shrinkBounds(b,1); assert.deepStrictEqual(b,{x0:1,y0:1,x1:14,y1:14});
  assert.strictEqual(b.x1-b.x0+1, 14);
});
test('shrink classification', () => {
  const nb = {x0:1,y0:1,x1:15,y1:15};
  const players = [
    {id:1,x:0,y:5,alive:true}, {id:2,x:5,y:0,alive:false}, {id:3,x:5,y:5,alive:true},
    {id:4,x:0,y:0,alive:false,permanentlyEliminated:true}];
  const r = R.applyShrink(nb, players, [{id:9,x:0,y:0},{id:10,x:4,y:4}]);
  assert.deepStrictEqual(r, {eliminated:[1], unrevivable:[2], removedHearts:[9]});
});
test('cannot shrink to nothing', () => assert.throws(() => R.shrinkBounds({x0:0,y0:0,x1:0,y1:0},0)));
