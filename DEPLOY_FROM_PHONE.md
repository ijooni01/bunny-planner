# Upload and deploy from an Android phone, $0

Status: these steps follow Cloudflare's and GitHub's documented flows, but the author has NOT run
them on a phone. Menu names may differ slightly. Nothing here needs a credit card.

## 1. Put the files in a GitHub repo
1. In your phone browser, open github.com, sign in, create a **public** repository named `bunny-planner`.
2. Add each file with **Add file > Create new file**. Type the full path in the name box
   (typing `src/mcp.js` creates the folder too), paste the contents, then **Commit changes**.
3. Files to create (21): `package.json`, `wrangler.toml`, `LICENSE`, `README.md`, `.gitignore`,
   `DEPLOY_FROM_PHONE.md`, `src/app.js`, `src/chat.js`, `src/filestore.js`, `src/mcp.js`, `src/node.js`,
   `src/providers.js`, `src/router.js`, `src/storage.js`, `src/tools.js`, `src/worker.js`,
   `web/index.html`, `test/test.mjs`, `test/chat.test.mjs`, `test/kv.test.mjs`, `test/web.test.mjs`.
   Alternative: unzip the zip with your Files app and upload files into each folder with **Add file > Upload files**.

## 2. Deploy to Cloudflare (free account, no card)
1. Sign up at cloudflare.com and open the dashboard, then **Workers & Pages**.
2. Choose **Import a repository** (Git integration), connect GitHub, pick `bunny-planner`.
3. The Worker name in the dashboard must match `name = "bunny-planner"` in `wrangler.toml`, or the build fails.
4. Keep the default deploy command (`npx wrangler deploy`) and select **Save and Deploy**.
5. Open `https://bunny-planner.<your-subdomain>.workers.dev/` for the bunny page (served from `web/` via the `[assets]` setting in `wrangler.toml`), and `/health` for JSON with `"fallback":"scripted"`.

## 3. Make tasks persist (optional but recommended for the demo)
Without KV the Worker keeps tasks in memory, and they can disappear when the Worker restarts.
1. In the dashboard, create a **Workers KV** namespace (look for KV under the storage options) and copy its **ID**.
2. Edit `wrangler.toml` on GitHub: remove the `#` from the three `[[kv_namespaces]]` lines, set
   `binding = "TASKS"` (leave as is) and paste the ID. Commit; Cloudflare redeploys.

## 4. Test it
Use a phone browser extension or an app like HTTP Shortcuts, or the front end we build next. A curl equivalent:

    curl -X POST https://bunny-planner.<you>.workers.dev/chat \
      -H 'content-type: application/json' -H 'x-session-id: phone_test_001' \
      -d '{"message":"add gym 30 min"}'

## Cost and risk notes
- Everything above uses free plans. If any free limit is exceeded, requests fail instead of charging you,
  according to Cloudflare's docs for the KV free plan. Check the pricing pages before relying on this.
- Never commit API keys. When an AI provider is added later, its key goes in Cloudflare **Settings > Variables and Secrets**.
