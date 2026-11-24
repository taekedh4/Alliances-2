'use strict';
const { createApp } = require('./app');
const { PgStore } = require('./store');
const { Pool } = require('pg');
const { ADMIN_CODE, SESSION_SECRET, DATABASE_URL, PORT = 3000 } = process.env;
if (!ADMIN_CODE || !SESSION_SECRET || !DATABASE_URL) { console.error('Set ADMIN_CODE, SESSION_SECRET and DATABASE_URL'); process.exit(1); }
(async () => {
  const store = new PgStore(new Pool({ connectionString: DATABASE_URL, ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false } }));
  await store.init();
  const app = createApp(store, { adminCode: ADMIN_CODE, secret: SESSION_SECRET });
  app.listen(PORT, () => console.log('ALLIANCES on ' + PORT));
  app.runScheduler(); setInterval(app.runScheduler, 30_000);
})();
