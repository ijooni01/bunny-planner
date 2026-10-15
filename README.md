# Bunny Planner: MCP server + /chat proxy

A small planning backend for a bunny companion, built for the Amazon Developer Hackathon 2026
(Alexa+ track). It is a **simulated Alexa+-style experience**. It does not integrate with the real
Alexa+ service.

- `POST /mcp`: self-hosted MCP server, Streamable HTTP, protocol 2025-11-25, four tools.
- `POST /chat`: chat proxy. Takes plain text, calls the MCP tools, returns a reply and a bunny `mood`.
- `GET /health`: shows which AI providers are active (currently none) and the fallback mode.

**AI status:** no AI provider is wired in yet. `/chat` runs on a built-in scripted router that needs
no API key and no network. The provider slot (`src/providers.js`) is ready for an AI adapter; if one
is added and fails or times out, `/chat` falls back to the scripted router automatically.

## Front end
`web/index.html` is a single file, no build step. The bunny stands bottom-left, separate from the chat;
messages appear above it. While a reply is pending it shows a three-dot bubble beside its head, then the
answer appears in the chat and the bunny changes expression from the server's `mood`. It has 11
expressions, gentle breathing and blinking, and respects reduced-motion settings. A session id is created
in the browser (localStorage) and sent as `x-session-id`. The server address can be set in Settings or with
`?api=https://your-worker.workers.dev`; empty means "this site".
Local preview: run `node src/node.js` and open http://localhost:8788/.

## Tools
| Tool | What it does |
|---|---|
| `add_task(title, minutes?)` | Adds a task (5-480 min, default 30). Flags overbooked days. |
| `plan_day(start?)` | Time-ordered schedule; suggests what to move if overbooked. |
| `complete_task(id? or title?)` | Marks a task done and updates the daily streak. |
| `get_streak()` | Days in a row with at least one completed task. |

Moods returned: `happy`, `concerned`, `encouraging`, `celebrating`, `confused`, `listening`, `sleepy`.

## /chat
Request: `POST /chat` with JSON `{"message": "add gym 30 min"}`
Headers: `x-session-id` (8-64 chars: letters, digits, `-`, `_`), `x-tz-offset-minutes` (Bangladesh = 360).

Response: `{ reply, mood, mode, degraded, toolCalls, data }`. Errors also include `reply` and `mood`
so a front end can always show something friendly.

What the scripted bunny understands:
- `add read chapter 3 for 45 min`, `remind me to call mom`, `add gym, laundry 20 min, email` (up to 5)
- `plan my day`, `plan from 7:30pm`
- `finished gym`, `done #2`, `mark laundry as done`
- `how is my streak`
- `help`, greetings, thanks, `good night`
Anything else gets a friendly "offline mode, I only know planning" reply with examples.

## Run locally (Node 18+, nothing to install, no key)
    node src/node.js        # http://localhost:8788 (page + API)
    npm test                # four test files

    curl -s -X POST localhost:8788/chat -H 'content-type: application/json' \
      -H 'x-session-id: demo_session_1' -d '{"message":"add gym 30 min"}'

## Deploy free on Cloudflare Workers
See `DEPLOY_FROM_PHONE.md`.

## Known limits and caveats
- **Missing session header:** without a valid `x-session-id`, all callers share one `demo` bucket.
  The front end must always send a random id.
- **Cloudflare KV free plan** (per Cloudflare docs): 1,000 writes/day in total, 100,000 reads/day,
  1 write/second per key. Every add/complete is a write, so a busy day can exhaust writes; the bunny then
  answers with a friendly error. Reads can be briefly stale (eventual consistency).
- **Rate limiter is best effort:** 20 messages/min per session and 60/min per IP, held in memory per
  Worker instance. It slows abuse; it is not a hard guarantee.
- No chat history is stored. Tasks expire after 30 days of inactivity on KV.

## License
MIT
