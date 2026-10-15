// Run with: node test/chat.test.mjs
import assert from 'node:assert/strict';
import { parseIntent } from '../src/router.js';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/storage.js';
import { RateLimiter } from '../src/chat.js';

let passed = 0;
const t = async (name, fn) => {
  await fn();
  passed++;
  console.log('ok -', name);
};

// ---------- parser table ----------
await t('parseIntent: add variants', () => {
  assert.deepEqual(parseIntent('add gym 30 min'), { intent: 'add', items: [{ title: 'Gym', minutes: 30 }], truncated: false });
  assert.deepEqual(parseIntent('Add read chapter 3 for 45 minutes').items, [{ title: 'Read chapter 3', minutes: 45 }]);
  assert.deepEqual(parseIntent('remind me to call mom').items, [{ title: 'Call mom' }]);
  assert.deepEqual(parseIntent('add gym, laundry 20 min, email').items, [{ title: 'Gym' }, { title: 'Laundry', minutes: 20 }, { title: 'Email' }]);
  assert.deepEqual(parseIntent('add study for 1.5 hours').items, [{ title: 'Study', minutes: 90 }]);
  assert.deepEqual(parseIntent('add yoga for half an hour').items, [{ title: 'Yoga', minutes: 30 }]);
  assert.equal(parseIntent('add a task').intent, 'add_ask');
  assert.equal(parseIntent('add 3 tasks').intent, 'add_ask');
  assert.equal(parseIntent('add a, b, c, d, e, f, g').truncated, true);
  assert.equal(parseIntent('add a, b, c, d, e, f, g').items.length, 5);
});

await t('parseIntent: plan / complete / streak / small talk', () => {
  assert.deepEqual(parseIntent('plan my day starting at 8am'), { intent: 'plan', start: '08:00' });
  assert.deepEqual(parseIntent('plan from 7:30pm'), { intent: 'plan', start: '19:30' });
  assert.equal(parseIntent('add my day').intent, 'plan');
  assert.equal(parseIntent('schedule').intent, 'plan');
  assert.equal(parseIntent('what do i have today').intent, 'plan');
  assert.deepEqual(parseIntent('finished gym'), { intent: 'complete', title: 'Gym' });
  assert.deepEqual(parseIntent('I just finished the report!'), { intent: 'complete', title: 'Report' });
  assert.deepEqual(parseIntent('done #3'), { intent: 'complete', id: 3 });
  assert.deepEqual(parseIntent('mark laundry as done'), { intent: 'complete', title: 'Laundry' });
  assert.deepEqual(parseIntent('done'), { intent: 'complete', ask: true });
  assert.equal(parseIntent("how's my streak?").intent, 'streak');
  assert.equal(parseIntent('help').intent, 'help');
  assert.equal(parseIntent('what can you do?').intent, 'help');
  assert.equal(parseIntent('hello').intent, 'greeting');
  assert.equal(parseIntent('thanks!').intent, 'thanks');
  assert.equal(parseIntent('good night').intent, 'tired');
});

await t('parseIntent: things it must NOT treat as planning', () => {
  assert.equal(parseIntent('what is the weather').intent, 'unknown');
  assert.equal(parseIntent('tell me a joke').intent, 'unknown');
  assert.equal(parseIntent('did you do your homework?').intent, 'unknown');
});

// ---------- /chat integration ----------
const DAY = 86400000;
let clock = Date.UTC(2026, 9, 14, 6, 0, 0);
const app = createApp({ store: new MemoryStore(), now: () => clock, limiter: new RateLimiter({ now: () => clock }) });
let ipCounter = 0;
async function chat(message, headers = {}, rawBody) {
  const res = await app(
    new Request('http://x/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.' + (ipCounter++ % 250), ...headers },
      body: rawBody ?? JSON.stringify({ message }),
    }),
    {},
  );
  return { status: res.status, headers: res.headers, json: await res.json() };
}
const A = { 'x-session-id': 'session_alpha_01' };
const B = { 'x-session-id': 'session_bravo_02' };

await t('chat: add -> happy, goes through the MCP tool', async () => {
  const r = await chat('add gym 30 min', A);
  assert.equal(r.status, 200);
  assert.equal(r.json.mode, 'scripted');
  assert.equal(r.json.mood, 'happy');
  assert.equal(r.json.toolCalls[0].name, 'add_task');
  assert.equal(r.json.data.openCount, 1);
  assert.match(r.json.reply, /"Gym"/);
});

await t('chat: plan, overbooked -> concerned, complete -> celebrating, streak', async () => {
  const plan = await chat('plan my day', A);
  assert.equal(plan.json.mood, 'encouraging');
  assert.match(plan.json.reply, /09:00-09:30 +Gym/);
  for (const n of ['Laundry', 'Email', 'Study', 'Groceries', 'Call mom']) await chat(`add ${n} 45 min`, A);
  const over = await chat('add Cleaning 45 min', A);
  assert.equal(over.json.mood, 'concerned');
  const plan2 = await chat('plan my day', A);
  assert.equal(plan2.json.mood, 'concerned');
  assert.match(plan2.json.reply, /overbooked/);
  const done = await chat('finished gym', A);
  assert.equal(done.json.mood, 'celebrating');
  assert.equal(done.json.data.streak, 1);
  const s = await chat("how's my streak", A);
  assert.match(s.json.reply, /Streak: 1 day/);
});

await t('chat: friendly replies when a tool fails or the text is unclear', async () => {
  const nf = await chat('finished nonexistent thing', A);
  assert.equal(nf.status, 200);
  assert.equal(nf.json.mood, 'confused');
  assert.match(nf.json.reply, /could not find/);
  const bad = await chat('add tiny task 2 min', A);
  assert.equal(bad.json.mood, 'confused');
  const unk = await chat('what is the weather', A);
  assert.equal(unk.json.mood, 'confused');
  assert.match(unk.json.reply, /offline mode/);
  assert.equal((await chat('done', A)).json.mood, 'listening');
});

await t('chat: sessions are separated', async () => {
  const b = await chat('plan my day', B);
  assert.deepEqual(b.json.data.schedule, []);
  await chat('add private thing 20 min', B);
  const a = await chat('plan my day', A);
  assert.ok(!JSON.stringify(a.json).includes('Private thing'));
});

await t('chat: timezone header changes what counts as today', async () => {
  const saved = clock;
  clock = Date.UTC(2026, 9, 20, 20, 0, 0); // 20:00 UTC = next day 02:00 in Bangladesh
  const T = { 'x-session-id': 'session_tz_test1', 'x-tz-offset-minutes': '360' };
  await chat('add tz task 30 min', T);
  await chat('finished tz task', T);
  assert.equal((await chat('streak', T)).json.data.streak, 1);
  assert.equal((await chat('streak', { ...T, 'x-tz-offset-minutes': '0' })).json.data.streak, 0);
  clock = saved;
});

await t('chat: input validation and HTTP edge cases', async () => {
  clock += 61_000; // earlier tests used session A heavily; let the rate-limit window pass
  assert.equal((await chat('', A)).status, 400);
  assert.equal((await chat('   ', A)).status, 400);
  assert.equal((await chat('x'.repeat(501), A)).status, 400);
  assert.equal((await chat('', A, '{nope')).status, 400);
  assert.equal((await chat('', A, '[1,2]')).status, 400);
  assert.equal((await chat('', A, JSON.stringify({ message: 'x'.repeat(5000) }))).status, 413);
  const get = await app(new Request('http://x/chat', { method: 'GET' }), {});
  assert.equal(get.status, 405);
  const opt = await app(new Request('http://x/chat', { method: 'OPTIONS', headers: { origin: 'https://site.example' } }), {});
  assert.equal(opt.status, 204);
  assert.equal(opt.headers.get('access-control-allow-origin'), 'https://site.example');
  const blocked = await app(new Request('http://x/chat', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }), { ALLOWED_ORIGINS: 'https://site.example' });
  assert.equal(blocked.status, 403);
  assert.equal((await app(new Request('http://x/nope'), {})).status, 404);
  const health = await (await app(new Request('http://x/health'), {})).json();
  assert.deepEqual(health.ai, []);
  assert.equal(health.fallback, 'scripted');
});

await t('chat: storage failure returns a friendly 500 without leaking details', async () => {
  const broken = createApp({ store: { load: async () => { throw new Error('SECRET_DB_BOOM'); }, save: async () => {} }, limiter: new RateLimiter() });
  const res = await broken(new Request('http://x/chat', { method: 'POST', body: JSON.stringify({ message: 'add gym' }) }), {});
  const text = await res.text();
  assert.equal(res.status, 500);
  assert.ok(!text.includes('SECRET_DB_BOOM'));
  assert.equal(JSON.parse(text).mood, 'concerned');
  assert.ok(JSON.parse(text).reply.length > 0);
});

await t('rate limiting: per-session and per-IP, resets after the window', async () => {
  let now = 1_000_000;
  const limiter = new RateLimiter({ now: () => now });
  const rl = createApp({ store: new MemoryStore(), limiter });
  const send = (sid, ip) =>
    rl(new Request('http://x/chat', { method: 'POST', headers: { 'x-session-id': sid, 'cf-connecting-ip': ip }, body: JSON.stringify({ message: 'help' }) }), {});
  for (let i = 0; i < 20; i++) assert.equal((await send('rate_session_01', '1.1.1.1')).status, 200);
  const blocked = await send('rate_session_01', '1.1.1.1');
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  assert.equal((await send('rate_session_02', '2.2.2.2')).status, 200); // other user unaffected
  for (let i = 0; i < 60; i++) assert.equal((await send('rotating_sid_' + i + '_xx', '3.3.3.3')).status, 200);
  assert.equal((await send('rotating_sid_new_xx', '3.3.3.3')).status, 429); // IP cap beats sid rotation
  now += 61_000;
  assert.equal((await send('rate_session_01', '1.1.1.1')).status, 200);
});

// ---------- provider chain with injected fake providers ----------
const withProviders = (providers, extra = {}) =>
  createApp({ store: new MemoryStore(), providers, limiter: new RateLimiter(), ...extra });
const post = (a, msg) => a(new Request('http://x/chat', { method: 'POST', headers: { 'x-session-id': 'provider_test_01' }, body: JSON.stringify({ message: msg }) }), {});

await t('providers: a working provider is used; bad mood is normalised', async () => {
  const a = withProviders([{ name: 'fake', available: () => true, run: async () => ({ reply: 'hi from ai', mood: 'not-a-mood' }) }]);
  const j = await (await post(a, 'anything')).json();
  assert.equal(j.mode, 'fake');
  assert.equal(j.mood, 'idle');
  assert.equal(j.reply, 'hi from ai');
});

await t('providers: error, null, timeout all fall back to scripted and flag degraded', async () => {
  const cases = [
    async () => { throw new Error('quota'); },
    async () => null,
    () => new Promise((r) => setTimeout(() => r({ reply: 'too late' }), 200)),
  ];
  for (const run of cases) {
    const a = withProviders([{ name: 'flaky', available: () => true, run }], { providerTimeoutMs: 30 });
    const j = await (await post(a, 'add gym 30 min')).json();
    assert.equal(j.mode, 'scripted');
    assert.equal(j.degraded, true);
    assert.equal(j.mood, 'happy');
  }
});

await t('providers: unavailable provider (no key) is skipped silently', async () => {
  const a = withProviders([{ name: 'nokey', available: () => false, run: async () => ({ reply: 'never' }) }]);
  const j = await (await post(a, 'help')).json();
  assert.equal(j.mode, 'scripted');
  assert.equal(j.degraded, false);
});

console.log(`\nAll ${passed} chat test groups passed.`);
