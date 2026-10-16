// Run with: node test/test.mjs
import assert from 'node:assert/strict';
import { createMcp } from '../src/mcp.js';
import { MemoryStore } from '../src/storage.js';

const DAY = 86400000;
let clock = Date.UTC(2026, 9, 14, 6, 0, 0); // Oct 14 2026, 06:00 UTC
const mcp = createMcp({ store: new MemoryStore(), now: () => clock });
const SID = 'testsession_01';
let id = 1;

async function post(body, headers = {}) {
  const res = await mcp(
    new Request('http://x/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': SID, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    {},
  );
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const rpc = (method, params) => post({ jsonrpc: '2.0', id: id++, method, params });
const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).json.result;

let passed = 0;
const t = async (name, fn) => {
  await fn();
  passed++;
  console.log('ok -', name);
};

await t('initialize negotiates 2025-11-25', async () => {
  const r = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.result.protocolVersion, '2025-11-25');
  assert.ok(r.json.result.capabilities.tools);
});

await t('unknown protocol version falls back to latest', async () => {
  const r = await rpc('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(r.json.result.protocolVersion, '2025-11-25');
});

await t('initialized notification returns 202 with no body', async () => {
  const r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(r.status, 202);
  assert.equal(r.json, null);
});

await t('tools/list exposes the four tools', async () => {
  const r = await rpc('tools/list');
  assert.deepEqual(r.json.result.tools.map((x) => x.name).sort(), ['add_task', 'complete_task', 'get_streak', 'plan_day']);
});

await t('HTTP edge cases: GET 405, bad version 400, bad JSON 400, batch 400, unknown method', async () => {
  const get = await mcp(new Request('http://x/mcp', { method: 'GET' }), {});
  assert.equal(get.status, 405);
  assert.equal((await post({ jsonrpc: '2.0', id: 99, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' })).status, 400);
  const bad = await post('{nope');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, -32700);
  assert.equal((await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).status, 400);
  assert.equal((await rpc('nope/nothing')).json.error.code, -32601);
  assert.equal((await rpc('tools/call', { name: 'does_not_exist' })).json.error.code, -32602);
});

await t('origin allow-list blocks other sites', async () => {
  const res = await mcp(
    new Request('http://x/mcp', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }),
    { ALLOWED_ORIGINS: 'https://good.example' },
  );
  assert.equal(res.status, 403);
});

await t('add_task: happy mood, validation errors', async () => {
  const r = await call('add_task', { title: 'Write report', minutes: 60 });
  assert.equal(r.structuredContent.mood, 'happy');
  assert.equal(r.structuredContent.openCount, 1);
  assert.equal((await call('add_task', { title: '   ' })).isError, true);
  assert.equal((await call('add_task', { title: 'x', minutes: 3 })).isError, true);
  assert.equal((await call('add_task', { title: 'x'.repeat(121) })).isError, true);
});

await t('plan_day: fits -> encouraging with a schedule', async () => {
  const r = await call('plan_day');
  assert.equal(r.structuredContent.mood, 'encouraging');
  assert.equal(r.structuredContent.schedule[0].start, '09:00');
});

await t('overbooked day -> concerned, with move suggestions', async () => {
  for (const n of ['Gym', 'Laundry', 'Call mom', 'Study math', 'Email', 'Groceries']) await call('add_task', { title: n, minutes: 45 });
  const add = await call('add_task', { title: 'One more', minutes: 45 });
  assert.equal(add.structuredContent.mood, 'concerned');
  const plan = await call('plan_day');
  assert.equal(plan.structuredContent.overbooked, true);
  assert.equal(plan.structuredContent.mood, 'concerned');
  assert.ok(plan.structuredContent.moveIds.length >= 1);
});

await t('complete_task: celebrating, ambiguity and not-found handled', async () => {
  const r = await call('complete_task', { title: 'gym' });
  assert.equal(r.structuredContent.mood, 'celebrating');
  assert.equal(r.structuredContent.streak, 1);
  assert.equal((await call('complete_task', { title: 'zzz' })).isError, true);
  assert.equal((await call('complete_task', { title: 'o' })).isError, true); // matches several tasks
  assert.equal((await call('complete_task', {})).isError, true);
});

await t('streak grows on consecutive days and resets after a gap', async () => {
  clock += DAY;
  await call('complete_task', { title: 'Laundry' });
  assert.equal((await call('get_streak')).structuredContent.streak, 2);
  clock += DAY;
  await call('complete_task', { title: 'Email' });
  const s = await call('get_streak');
  assert.equal(s.structuredContent.streak, 3);
  assert.equal(s.structuredContent.mood, 'celebrating');
  clock += 3 * DAY; // skip days
  assert.equal((await call('get_streak')).structuredContent.streak, 0);
});

await t('sessions are isolated', async () => {
  const res = await mcp(
    new Request('http://x/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': 'another_session_1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 500, method: 'tools/call', params: { name: 'plan_day', arguments: {} } }),
    }),
    {},
  );
  const j = await res.json();
  assert.equal(j.result.structuredContent.schedule.length, 0);
});

console.log(`\nAll ${passed} test groups passed.`);
