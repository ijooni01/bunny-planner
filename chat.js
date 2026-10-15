// POST /chat  { "message": "add gym 30 min" }  ->  { reply, mood, mode, toolCalls, data? }
// Headers: x-session-id (anonymous, isolates tasks), x-tz-offset-minutes (client UTC offset).
// Tools are called through the real MCP handler (JSON-RPC tools/call), never by touching storage directly.
import { sessionInfo, corsHeaders, originAllowed } from './mcp.js';
import { runScripted, MOODS } from './router.js';
import { buildProviders } from './providers.js';

const MAX_BODY_CHARS = 4000;
const MAX_MESSAGE_CHARS = 500;
const IP_LIMIT_PER_MIN = 60;
const SESSION_LIMIT_PER_MIN = 20;

// Best-effort limiter. On Workers each isolate has its own memory, so this slows abuse
// but is not a hard guarantee.
export class RateLimiter {
  constructor({ windowMs = 60000, now = () => Date.now(), maxKeys = 5000 } = {}) {
    this.windowMs = windowMs;
    this.now = now;
    this.maxKeys = maxKeys;
    this.hits = new Map();
  }
  // returns null if allowed, otherwise seconds to wait
  check(key, limit) {
    const t = this.now();
    const arr = (this.hits.get(key) || []).filter((x) => t - x < this.windowMs);
    if (arr.length >= limit) {
      this.hits.set(key, arr);
      return Math.max(1, Math.ceil((arr[0] + this.windowMs - t) / 1000));
    }
    arr.push(t);
    this.hits.delete(key);
    this.hits.set(key, arr);
    if (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value);
    return null;
  }
}
const defaultLimiter = new RateLimiter();

const withTimeout = (p, ms) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

export function createChat({ mcp, providers, limiter = defaultLimiter, providerTimeoutMs = 8000 }) {
  return async function handleChat(request, env = {}) {
    const cors = corsHeaders(request, env);
    const json = (body, status = 200, extra = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors, ...extra } });

    try {
      if (!originAllowed(request, env)) return new Response('Forbidden origin', { status: 403 });
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST, OPTIONS', ...cors } });
      }

      const { sid, tzOffsetMinutes } = sessionInfo(request);
      const ip = request.headers.get('cf-connecting-ip') || 'local';
      const wait = limiter.check('ip:' + ip, IP_LIMIT_PER_MIN) ?? limiter.check('sid:' + sid, SESSION_LIMIT_PER_MIN);
      if (wait !== null) {
        return json(
          { error: 'rate_limited', reply: 'Whoa, that is a lot of messages at once! Give me a moment and try again.', mood: 'confused', mode: 'error' },
          429,
          { 'retry-after': String(wait) },
        );
      }

      const text = await request.text();
      if (text.length > MAX_BODY_CHARS) return json({ error: 'too_large', reply: 'That message is too big for me.', mood: 'confused', mode: 'error' }, 413);
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return json({ error: 'bad_json', reply: 'I could not read that request.', mood: 'confused', mode: 'error' }, 400);
      }
      const message = body && typeof body.message === 'string' ? body.message.trim() : '';
      if (!message) return json({ error: 'empty_message', reply: 'Say something and I will help!', mood: 'listening', mode: 'error' }, 400);
      if (message.length > MAX_MESSAGE_CHARS) {
        return json({ error: 'message_too_long', reply: `Please keep messages under ${MAX_MESSAGE_CHARS} characters.`, mood: 'confused', mode: 'error' }, 400);
      }

      // In-process MCP client: a real JSON-RPC tools/call against the same /mcp handler.
      const toolCalls = [];
      let rpcId = 1;
      const callTool = async (name, args) => {
        const res = await mcp(
          new Request('http://internal/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-session-id': sid, 'x-tz-offset-minutes': String(tzOffsetMinutes) },
            body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
          }),
          env,
        );
        const out = await res.json();
        if (out.error) throw new Error('mcp_error ' + out.error.code);
        toolCalls.push({ name, args, isError: !!out.result.isError });
        return out.result;
      };

      let degraded = false;
      for (const p of providers || buildProviders(env)) {
        if (!p.available(env)) continue;
        try {
          const r = await withTimeout(p.run({ message, callTool, env }), providerTimeoutMs);
          if (r && typeof r.reply === 'string' && r.reply) {
            return json({ reply: r.reply, mood: MOODS.includes(r.mood) ? r.mood : 'idle', mode: p.name, toolCalls, data: r.data });
          }
          degraded = true;
        } catch {
          degraded = true;
        }
      }

      const r = await runScripted(message, callTool);
      return json({ reply: r.reply, mood: MOODS.includes(r.mood) ? r.mood : 'idle', mode: 'scripted', degraded, toolCalls, data: r.data });
    } catch {
      // Never leak internals. The front end can still show this reply and a concerned bunny.
      return json(
        { error: 'server_error', reply: 'Oops, my ears got tangled and I could not finish that. Please try again in a moment.', mood: 'concerned', mode: 'error' },
        500,
      );
    }
  };
}
