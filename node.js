// Local server: `node src/node.js` -> http://localhost:8788  (/mcp, /chat, /health). No install, no key needed.
import http from 'node:http';
import { createApp } from './app.js';
import { FileStore } from './filestore.js';
import { readFile } from 'node:fs/promises';

const PORT = Number(process.env.PORT || 8788);
const app = createApp({ store: new FileStore(process.env.DATA_FILE || './data/tasks.json') });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      // local preview of the front end (on Cloudflare the [assets] folder serves it instead)
      try {
        const html = await readFile(new URL('../web/index.html', import.meta.url));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      } catch {}
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
    });
    const response = await app(request, process.env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Server error');
  }
});

server.listen(PORT, () => console.log(`Bunny Planner on http://localhost:${PORT}  (POST /mcp, POST /chat)`));
