// One tiny interface: load(sessionId) -> state, save(sessionId, state).
// Swap the adapter without touching tool logic.
import { emptyState } from './tools.js';

export class MemoryStore {
  constructor() {
    this.map = new Map();
  }
  async load(sid) {
    const v = this.map.get(sid);
    return v ? structuredClone(v) : emptyState();
  }
  async save(sid, state) {
    this.map.set(sid, structuredClone(state));
  }
}

// Cloudflare KV adapter. Free-plan facts (from Cloudflare docs, checked Oct 2026): 1,000 writes/day
// in total, 100,000 reads/day, and only 1 write per second to the same key. A multi-item "add a, b, c"
// does several quick writes to one key, so save() retries after a short pause. Reads can be briefly stale
// (eventual consistency). Data expires after 30 days so abandoned anonymous sessions clean themselves up.
export class KVStore {
  constructor(kv, { ttlSeconds = 60 * 60 * 24 * 30, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.kv = kv;
    this.ttl = ttlSeconds;
    this.sleep = sleep;
  }
  async load(sid) {
    const raw = await this.kv.get('s:' + sid);
    return raw ? JSON.parse(raw) : emptyState();
  }
  async save(sid, state) {
    const body = JSON.stringify(state);
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.kv.put('s:' + sid, body, { expirationTtl: this.ttl });
        return;
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await this.sleep(1100);
      }
    }
    throw lastErr;
  }
}
