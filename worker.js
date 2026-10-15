// Cloudflare Worker entry. Bind a KV namespace named TASKS to persist tasks;
// without it the server still works but keeps tasks in memory (resets on cold start).
import { createApp } from './app.js';
import { KVStore, MemoryStore } from './storage.js';

const fallbackStore = new MemoryStore();

export default {
  async fetch(request, env) {
    const store = env.TASKS ? new KVStore(env.TASKS) : fallbackStore;
    return createApp({ store })(request, env);
  },
};
