// Single router for all endpoints: /mcp, /chat, /health.
import { createMcp } from './mcp.js';
import { createChat } from './chat.js';
import { buildProviders } from './providers.js';

export function createApp({ store, now, providers, limiter, providerTimeoutMs } = {}) {
  const mcp = createMcp({ store, now });
  const chat = createChat({ mcp, providers, limiter, providerTimeoutMs });
  return async function app(request, env = {}) {
    const { pathname } = new URL(request.url);
    if (pathname === '/mcp') return mcp(request, env);
    if (pathname === '/chat') return chat(request, env);
    if (pathname === '/' || pathname === '/health') {
      const ai = (providers || buildProviders(env)).filter((p) => p.available(env)).map((p) => p.name);
      return Response.json({ name: 'bunny-planner', endpoints: { mcp: '/mcp', chat: '/chat' }, transport: 'streamable-http', protocol: '2025-11-25', ai, fallback: 'scripted' });
    }
    return new Response('Not found', { status: 404 });
  };
}
