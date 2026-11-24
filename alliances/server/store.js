'use strict';
// A store runs fn(data) under an exclusive lock and saves the result, or discards it if fn throws.
const E = require('./engine');
// Keep the single saved record from growing forever.
const trim = (d) => { for (const k of ['events', 'adminLog']) if (d[k] && d[k].length > 5000) d[k].splice(0, d[k].length - 5000); };
const fresh = () => ({ game: E.newState(), accounts: {}, events: [], eventId: 1 });

class MemoryStore {
  constructor() { this.data = fresh(); this.queue = Promise.resolve(); }
  withState(fn) {
    const run = this.queue.then(() => {
      const copy = structuredClone(this.data);
      const out = fn(copy);
      trim(copy);
      this.data = copy;
      return out;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

// Postgres: one JSONB row, locked with SELECT ... FOR UPDATE inside a transaction.
class PgStore {
  constructor(pool) { this.pool = pool; }
  async init() {
    await this.pool.query('CREATE TABLE IF NOT EXISTS app_state (id int PRIMARY KEY, data jsonb NOT NULL)');
    await this.pool.query('INSERT INTO app_state (id, data) VALUES (1, $1) ON CONFLICT DO NOTHING', [JSON.stringify(fresh())]);
  }
  async withState(fn) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const { rows } = await c.query('SELECT data FROM app_state WHERE id = 1 FOR UPDATE');
      const data = rows[0].data;
      const out = fn(data);
      trim(data);
      await c.query('UPDATE app_state SET data = $1 WHERE id = 1', [JSON.stringify(data)]);
      await c.query('COMMIT');
      return out;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  }
}
module.exports = { MemoryStore, PgStore };
