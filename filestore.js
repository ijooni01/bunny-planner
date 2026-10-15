// Local-only JSON file storage. Imported by node.js, never by the Worker.
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { emptyState } from './tools.js';

export class FileStore {
  constructor(path) {
    this.path = path;
    this.queue = Promise.resolve();
  }
  async #read() {
    try {
      return JSON.parse(await fs.readFile(this.path, 'utf8'));
    } catch {
      return {};
    }
  }
  async load(sid) {
    const all = await this.#read();
    return all[sid] || emptyState();
  }
  save(sid, state) {
    // serialize writes so concurrent requests cannot clobber each other
    this.queue = this.queue.then(async () => {
      const all = await this.#read();
      all[sid] = state;
      await fs.mkdir(dirname(this.path), { recursive: true });
      await fs.writeFile(this.path, JSON.stringify(all, null, 2));
    });
    return this.queue;
  }
}
