// Run with: node test/kv.test.mjs
// Uses a FAKE KV that mimics the documented "1 write per second per key" rule.
// This checks my retry logic against my reading of the docs; it is NOT a test of real Cloudflare KV.
import assert from 'node:assert/strict';
import { KVStore } from '../src/storage.js';
import { createApp } from '../src/app.js';
import { RateLimiter } from '../src/chat.js';

function fakeKV({ failAlways = false } = {}) {
  let clock = 0;
  const data = new Map();
  const lastWrite = new Map();
  const puts = [];
  return {
    advance: (ms) => (clock += ms),
    puts,
    async get(k) { return data.has(k) ? data.get(k) : null; },
    async put(k, v, opts) {
      if (failAlways || (lastWrite.has(k) && clock - lastWrite.get(k) < 1000)) throw new Error('KV PUT failed: 429 Too Many Requests');
      lastWrite.set(k, clock);
      data.set(k, v);
      puts.push({ k, opts });
    },
  };
}

let passed = 0;
const t = async (n, f) => { await f(); passed++; console.log('ok -', n); };

await t('KVStore: round trip, TTL set, key prefixed', async () => {
  const kv = fakeKV();
  const s = new KVStore(kv, { sleep: async (ms) => kv.advance(ms) });
  await s.save('abc_session_1', { tasks: [1], doneDates: [], nextId: 2 });
  assert.deepEqual(await s.load('abc_session_1'), { tasks: [1], doneDates: [], nextId: 2 });
  assert.equal(kv.puts[0].k, 's:abc_session_1');
  assert.equal(kv.puts[0].opts.expirationTtl, 2592000);
  assert.deepEqual((await s.load('nobody_here_1')).tasks, []);
});

await t('KVStore: quick second write to the same key succeeds via retry', async () => {
  const kv = fakeKV();
  const s = new KVStore(kv, { sleep: async (ms) => kv.advance(ms) });
  await s.save('same_key_user1', { v: 1 });
  await s.save('same_key_user1', { v: 2 }); // would throw without the retry
  assert.equal(JSON.parse(await kv.get('s:same_key_user1')).v, 2);
});

await t('KVStore: gives up after 3 attempts and throws', async () => {
  const kv = fakeKV({ failAlways: true });
  let sleeps = 0;
  const s = new KVStore(kv, { sleep: async () => { sleeps++; } });
  await assert.rejects(() => s.save('x_session_001', {}), /KV PUT failed/);
  assert.equal(sleeps, 2);
});

await t('end to end: "add a, b, c" through /chat on the fake KV keeps all three tasks', async () => {
  const kv = fakeKV();
  const store = new KVStore(kv, { sleep: async (ms) => kv.advance(ms) });
  const app = createApp({ store, limiter: new RateLimiter() });
  const send = (message) => app(new Request('http://x/chat', { method: 'POST', headers: { 'x-session-id': 'kv_e2e_session' }, body: JSON.stringify({ message }) }), {}).then((r) => r.json());
  const r = await send('add gym, laundry, email');
  assert.equal(r.data.openCount, 3);
  const plan = await send('plan my day');
  assert.equal(plan.data.schedule.length, 3);
});

await t('end to end: KV outage gives a friendly 500, not a crash', async () => {
  const kv = fakeKV({ failAlways: true });
  const store = new KVStore(kv, { sleep: async () => {} });
  const app = createApp({ store, limiter: new RateLimiter() });
  const res = await app(new Request('http://x/chat', { method: 'POST', body: JSON.stringify({ message: 'add gym' }) }), {});
  assert.equal(res.status, 500);
  const j = await res.json();
  assert.equal(j.mood, 'concerned');
  assert.ok(!JSON.stringify(j).includes('KV PUT'));
});

console.log(`\nAll ${passed} KV test groups passed.`);
