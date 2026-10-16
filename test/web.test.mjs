// Run with: node test/web.test.mjs
// Runs the page's real <script> in a stub DOM (NOT a real browser) wired to the real backend code.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/storage.js';
import { RateLimiter } from '../src/chat.js';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
new vm.Script(script); // syntax check

class El {
  constructor(id) { Object.assign(this, { id, children: [], style: {}, attrs: {}, listeners: {}, hidden: false, value: '', disabled: false, textContent: '', innerHTML: '', scrollTop: 0, scrollHeight: 0 }); this.classList = { s: new Set(), add: (...a) => a.forEach((x) => this.classList.s.add(x)), remove: (...a) => a.forEach((x) => this.classList.s.delete(x)) }; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(t, f) { this.listeners[t] = f; }
  setAttribute(k, v) { this.attrs[k] = v; }
  focus() {}
  getBoundingClientRect() { return {}; }
}
const ids = ['sv', 'log', 'banner', 'settings', 'mode', 'gear', 'api', 'saveApi', 'newSess', 'setMsg', 'chips', 'f', 't', 'go', 'br', 'bun'];

function boot({ fetchImpl, search = '' } = {}) {
  const els = Object.fromEntries(ids.map((i) => [i, new El(i)]));
  const ls = new Map();
  const app = createApp({ store: new MemoryStore(), limiter: new RateLimiter() });
  const calls = [];
  const fetch = fetchImpl || (async (url, opts = {}) => {
    calls.push({ url, opts });
    const abs = url.startsWith('http') ? url : 'http://x' + url;
    const { cache, signal, ...rest } = opts;
    return app(new Request(abs, rest), {});
  });
  let expose;
  const ctx = {
    document: { getElementById: (i) => els[i], createElement: () => new El('new') },
    localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, v) },
    location: { search }, URLSearchParams, crypto, AbortSignal, Date, JSON, Promise, String, Set, Math, Error,
    window: { crypto, AbortSignal }, fetch, console,
    setTimeout: (f, ms) => { const h = setTimeout(f, ms); if (ms >= 1000) h.unref?.(); return h; }, // long idle-reset timers must not keep Node alive
    clearTimeout, setInterval: () => 0,
    __expose: (o) => (expose = o),
  };
  vm.runInNewContext(script, ctx);
  return { els, ls, calls, api: expose, ctx };
}
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const texts = (els) => els.log.children.map((c) => c.className.split(' ')[1] + ':' + c.textContent);

let passed = 0;
const t = async (n, f) => { await f(); passed++; console.log('ok -', n); };

await t('all 11 expressions build; SVG written out for an XML well-formedness check', () => {
  const { api } = boot();
  const names = Object.keys(api.E);
  assert.equal(names.length, 11);
  mkdirSync('/tmp/svgs', { recursive: true });
  for (const k of names) writeFileSync(`/tmp/svgs/${k}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -4 114 156">${api.build(k)}</svg>`);
  assert.ok(api.build('thinking').includes('<animate'));
  assert.ok(!api.build('idle').includes('<animate'));
});

await t('startup: welcome message, idle bunny, valid anonymous session id, health says offline brain', async () => {
  const { els, ls, api } = boot();
  await tick();
  assert.match(els.log.children[0].textContent, /planner bunny/);
  assert.equal(api.cur, 'idle');
  assert.match(ls.get('bp_sid'), /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(els.mode.textContent, 'Offline brain (no AI key)');
  assert.equal(els.banner.hidden, true);
});

await t('send: thinking while waiting, then happy; session + timezone headers sent; real tool ran', async () => {
  const { els, calls, api } = boot();
  els.t.value = 'add gym 30 min';
  const p = api.send(els.t.value);
  assert.equal(api.cur, 'thinking');
  assert.equal(els.go.disabled, true);
  assert.equal(els.t.value, '');
  api.send('ignored while busy'); // must be ignored
  await p;
  const chat = calls.filter((c) => c.url === '/chat');
  assert.equal(chat.length, 1);
  assert.equal(chat[0].opts.headers['x-session-id'], api.sid);
  assert.equal(chat[0].opts.headers['x-tz-offset-minutes'], String(-new Date().getTimezoneOffset()));
  assert.equal(api.cur, 'happy');
  assert.equal(els.go.disabled, false);
  const log = texts(els);
  assert.equal(log[1], 'u:add gym 30 min');
  assert.match(log[2], /^b:Got it! "Gym"/);
});

await t('chips: prefill chips fill the input; action chips send', async () => {
  const { els, api } = boot();
  const [addChip, planChip, finChip] = els.chips.children;
  addChip.onclick();
  assert.equal(els.t.value, 'add ');
  assert.equal(api.cur, 'listening');
  finChip.onclick();
  assert.equal(els.t.value, 'finished ');
  els.t.value = '';
  await api.send('add read 45 min');
  planChip.onclick();
  await tick(800);
  assert.match(els.log.children.at(-1).textContent, /09:00-09:45/);
  assert.equal(api.cur, 'encouraging');
});

await t('typing makes the bunny listen; clearing returns to idle', () => {
  const { els, api } = boot();
  els.t.value = 'hel';
  els.t.listeners.input();
  assert.equal(api.cur, 'listening');
  els.t.value = '';
  els.t.listeners.input();
  assert.equal(api.cur, 'idle');
});

await t('mood from server drives expression: celebrating, concerned, confused', async () => {
  const { els, api } = boot();
  await api.send('add gym 30 min');
  await api.send('finished gym');
  assert.equal(api.cur, 'celebrating');
  await api.send('what is the weather');
  assert.equal(api.cur, 'confused');
  for (let i = 0; i < 7; i++) await api.send(`add task number ${i} 60 min`);
  assert.equal(api.cur, 'concerned');
});

await t('server unreachable: concerned bunny, friendly message, banner shown, input re-enabled', async () => {
  const { els, api } = boot({ fetchImpl: async () => { throw new TypeError('network down'); } });
  await tick();
  assert.equal(els.banner.hidden, false);
  assert.equal(els.mode.textContent, 'Not connected');
  await api.send('add gym');
  assert.equal(api.cur, 'concerned');
  assert.match(els.log.children.at(-1).textContent, /can't reach the server/i);
  assert.equal(els.go.disabled, false);
});

await t('server returns non-JSON or error body: still a friendly reply, no crash', async () => {
  const { els, api } = boot({ fetchImpl: async (url) => (url === '/health' ? Response.json({ ai: [] }) : new Response('<html>bad gateway</html>', { status: 502 })) });
  await api.send('add gym');
  assert.equal(api.cur, 'concerned');
  assert.match(els.log.children.at(-1).textContent, /could not read/i);
});

await t('settings: rejects a bad address, accepts a good one and uses it', async () => {
  const { els, calls, api } = boot({ search: '' });
  els.api.value = 'not a url';
  await els.saveApi.onclick();
  assert.match(els.setMsg.textContent, /must start with https/);
  els.api.value = 'https://bunny.example.workers.dev/';
  await els.saveApi.onclick();
  assert.equal(api.base, 'https://bunny.example.workers.dev');
  assert.ok(calls.some((c) => c.url === 'https://bunny.example.workers.dev/health'));
});

await t('?api= query parameter is saved; new session changes the id', () => {
  const { ls, els, api } = boot({ search: '?api=https://a.example/' });
  assert.equal(api.base, 'https://a.example');
  const old = api.sid;
  els.newSess.onclick();
  assert.notEqual(api.sid, old);
  assert.equal(ls.get('bp_sid'), api.sid);
});

console.log(`\nAll ${passed} web test groups passed.`);
