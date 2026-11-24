const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/app');
const { MemoryStore } = require('../server/store');
const A = require('../server/auth');

async function boot() {
  const store = new MemoryStore();
  const srv = createApp(store, { adminCode: 'adm-secret', secret: 's3' });
  await new Promise(r => srv.listen(0, r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const call = async (path, o = {}, token) => {
    const r = await fetch(base + path, { method: o.body ? 'POST' : 'GET', body: o.body && JSON.stringify(o.body), headers: token ? { authorization: 'Bearer ' + token } : {} });
    return { status: r.status, json: await r.json() };
  };
  return { store, srv, call };
}

test('auth helpers', () => {
  const h = A.hashCode('1234567');
  assert.ok(A.verifyCode('1234567', h) && !A.verifyCode('1234568', h));
  assert.ok(!h.includes('1234567'));
  assert.strictEqual(A.readToken('k', A.signToken('k', { id: 1 })).id, 1);
  assert.strictEqual(A.readToken('other', A.signToken('k', { id: 1 })), null);
  assert.strictEqual(A.readToken('k', A.signToken('k', { id: 1 }, -1)), null);
});

test('full flow: admin creates players, players act, AP stays secret, no cheating', async () => {
  const { store, srv, call } = await boot();
  try {
    assert.strictEqual((await call('/api/admin/login', { body: { code: 'nope' } })).status, 401);
    const admin = (await call('/api/admin/login', { body: { code: 'adm-secret' } })).json.token;
    assert.strictEqual((await call('/api/admin/players', { body: { name: 'Ann', code: '12' } }, admin)).status, 400);
    await call('/api/admin/players', { body: { name: 'Ann', code: '1111111' } }, admin);
    await call('/api/admin/players', { body: { name: 'Bob', code: '2222222' } }, admin);
    assert.strictEqual((await call('/api/admin/players', { body: { name: 'Eve', code: '1111111' } }, admin)).status, 400);
    const ann = (await call('/api/login', { body: { code: '1111111' } })).json.token;
    const bob = (await call('/api/login', { body: { code: '2222222' } })).json.token;
    // Players cannot use admin routes or act before the start.
    assert.strictEqual((await call('/api/admin/start', { body: {} }, ann)).status, 403);
    assert.strictEqual((await call('/api/action', { body: { type: 'heal' } }, ann)).status, 400);
    await call('/api/admin/start', { body: {} }, admin);
    // Give AP and place players via the store (admin tools come later).
    await store.withState(d => { const [a, b] = d.game.players; Object.assign(a, { x: 3, y: 3, ap: 5 }); Object.assign(b, { x: 3, y: 5, ap: 7 }); });
    const sA = (await call('/api/state', {}, ann)).json;
    assert.strictEqual(sA.players.find(p => p.name === 'Ann').ap, 5);
    assert.ok(!('ap' in sA.players.find(p => p.name === 'Bob')));
    assert.ok(!JSON.stringify(sA).includes('"accounts"'));
    // A forged "player" field in the body is ignored: the session decides who acts.
    assert.strictEqual((await call('/api/action', { body: { type: 'shoot', target: 2, player: 2 } }, ann)).status, 200);
    const sB = (await call('/api/state', {}, bob)).json;
    assert.strictEqual(sB.players.find(p => p.name === 'Bob').hearts, 2);
    assert.ok(sB.notes.some(n => n.text === 'Ann shot you'));
    assert.strictEqual((await call('/api/action', { body: { type: 'move', x: 3, y: 5 } }, ann)).status, 400);
    assert.strictEqual((await call('/api/state')).status, 401);
  } finally { srv.close(); }
});

test('login attempts are rate limited', async () => {
  const { srv, call } = await boot();
  try {
    let last; for (let i = 0; i < 10; i++) last = await call('/api/login', { body: { code: '9999999' } });
    assert.strictEqual(last.status, 429);
  } finally { srv.close(); }
});

test('admin command route: admin only, confirmation flow over HTTP', async () => {
  const { srv, call } = await boot();
  try {
    const admin = (await call('/api/admin/login', { body: { code: 'adm-secret' } })).json.token;
    await call('/api/admin/players', { body: { name: 'Ann', code: '1111111' } }, admin);
    await call('/api/admin/players', { body: { name: 'Bob', code: '2222222' } }, admin);
    const ann = (await call('/api/login', { body: { code: '1111111' } })).json.token;
    assert.strictEqual((await call('/api/admin/do', { body: { cmd: 'reset', confirm: true } }, ann)).status, 403);
    const r = await call('/api/admin/do', { body: { cmd: 'reset' } }, admin);
    assert.strictEqual(r.status, 400); assert.match(r.json.error, /^CONFIRM/);
    assert.strictEqual((await call('/api/admin/do', { body: { cmd: 'reset', confirm: true } }, admin)).status, 200);
    const st = (await call('/api/state', {}, admin)).json;
    assert.ok(st.log.some(l => /Reset the game/.test(l.text)));
  } finally { srv.close(); }
});
