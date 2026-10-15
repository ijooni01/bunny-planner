// Minimal, dependency-free MCP server over Streamable HTTP (stateless, JSON responses).
// Uses only web-standard Request/Response, so the same code runs on Cloudflare Workers and Node 18+.
import { TOOLS, READ_ONLY } from './tools.js';

const SERVER_VERSION = '0.1.0';
export const LATEST_PROTOCOL = '2025-11-25';
const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26'];

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// Anonymous session + timezone from request headers (shared by /mcp and /chat).
export function sessionInfo(request) {
  const sidRaw = request.headers.get('x-session-id') || '';
  const tzRaw = parseInt(request.headers.get('x-tz-offset-minutes') || '0', 10);
  return {
    sid: /^[A-Za-z0-9_-]{8,64}$/.test(sidRaw) ? sidRaw : 'demo',
    tzOffsetMinutes: Number.isFinite(tzRaw) ? Math.max(-840, Math.min(840, tzRaw)) : 0,
  };
}

export function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  const h = {
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id, x-session-id, x-tz-offset-minutes',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
  if (origin) h['access-control-allow-origin'] = origin;
  return h;
}

// If ALLOWED_ORIGINS is set (comma separated), browser requests from other origins are refused.
export function originAllowed(request, env) {
  const origin = request.headers.get('origin');
  const list = (env && env.ALLOWED_ORIGINS ? String(env.ALLOWED_ORIGINS) : '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!origin || list.length === 0 || list.includes('*')) return true;
  return list.includes(origin);
}

export function createMcp({ store, now = () => Date.now() }) {
  async function dispatch(msg, ctx) {
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params && msg.params.protocolVersion;
        return {
          protocolVersion: SUPPORTED.includes(asked) ? asked : LATEST_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'bunny-planner', title: 'Bunny Planner', version: SERVER_VERSION },
          instructions:
            'Daily planning tools. Every tool result includes a "mood" (happy, concerned, encouraging, celebrating, confused) for a companion character.',
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
        };
      case 'tools/call': {
        const p = msg.params || {};
        const tool = TOOLS.find((t) => t.name === p.name);
        if (!tool) throw new RpcError(-32602, 'Unknown tool: ' + String(p.name));
        const args = p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments) ? p.arguments : {};
        const state = await store.load(ctx.sid);
        const result = tool.run(args, state, ctx);
        if (!READ_ONLY.has(tool.name) && !result.isError) await store.save(ctx.sid, state);
        return result;
      }
      default:
        throw new RpcError(-32601, 'Method not found: ' + msg.method);
    }
  }

  return async function handle(request, env = {}) {
    const cors = corsHeaders(request, env);
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...cors } });

    if (!originAllowed(request, env)) return new Response('Forbidden origin', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST, OPTIONS', ...cors } });
    }

    const ver = request.headers.get('mcp-protocol-version');
    if (ver && !SUPPORTED.includes(ver)) return json(rpcError(null, -32600, 'Unsupported MCP-Protocol-Version: ' + ver), 400);

    let msg;
    try {
      msg = JSON.parse(await request.text());
    } catch {
      return json(rpcError(null, -32700, 'Parse error'), 400);
    }
    if (Array.isArray(msg)) return json(rpcError(null, -32600, 'JSON-RPC batching is not supported'), 400);
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return json(rpcError(null, -32600, 'Invalid Request'), 400);

    // Notifications (no id) and client responses (no method): accept and return 202 with no body.
    if (typeof msg.method !== 'string' || msg.id === undefined || msg.id === null) {
      return new Response(null, { status: 202, headers: cors });
    }

    const ctx = { ...sessionInfo(request), now };

    try {
      return json(rpcResult(msg.id, await dispatch(msg, ctx)));
    } catch (e) {
      if (e instanceof RpcError) return json(rpcError(msg.id, e.code, e.message));
      return json(rpcError(msg.id, -32603, 'Internal error'));
    }
  };
}
