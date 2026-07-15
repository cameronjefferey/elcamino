const { Pool, types } = require('pg');

// Return DATE columns as plain 'YYYY-MM-DD' strings so days never shift across timezones.
types.setTypeParser(1082, (v) => v);

const connectionString =
  process.env.DATABASE_URL || 'postgres://localhost:5432/camino';

const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);

function makePool(useSsl) {
  return new Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  });
}

// Render's internal database URLs run on a private network without TLS, while
// external URLs require it. Start with our best guess and fall back if the
// server disagrees, so the app boots correctly with either URL.
const state = { pool: makePool(!isLocal) };

const pool = {
  query: (...args) => state.pool.query(...args),
};

async function connectWithRetry() {
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await state.pool.query('SELECT 1');
      return;
    } catch (err) {
      if (/does not support SSL/i.test(err.message)) {
        console.log('[db] server does not support SSL - reconnecting without it');
        state.pool = makePool(false);
      } else if (/SSL.*(required|off)/i.test(err.message)) {
        console.log('[db] server requires SSL - reconnecting with it');
        state.pool = makePool(true);
      } else if (attempt < maxAttempts) {
        // Database may still be provisioning on the very first deploy.
        console.log(`[db] connection attempt ${attempt} failed (${err.message}) - retrying in 5s`);
        await new Promise((r) => setTimeout(r, 5000));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Could not connect to the database');
}

async function init() {
  await connectWithRetry();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      day_number INTEGER,
      location TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      data BYTEA NOT NULL,
      mime TEXT NOT NULL DEFAULT 'image/jpeg',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS subscribers (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      token TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id SERIAL PRIMARY KEY,
      date DATE NOT NULL UNIQUE,
      day_number INTEGER,
      start_town TEXT,
      end_town TEXT,
      miles NUMERIC(6,1),
      steps INTEGER,
      elevation_ft INTEGER,
      blisters INTEGER,
      cafes INTEGER,
      favorite TEXT,
      accommodation TEXT,
      meal_location TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      author_name TEXT NOT NULL,
      body TEXT NOT NULL,
      is_author BOOLEAN NOT NULL DEFAULT false,
      is_private BOOLEAN NOT NULL DEFAULT false,
      email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS comments_post_idx ON comments (post_id, created_at);
  `);

  // Add columns introduced after the table already existed in production.
  await pool.query(`
    ALTER TABLE metrics ADD COLUMN IF NOT EXISTS accommodation TEXT;
    ALTER TABLE metrics ADD COLUMN IF NOT EXISTS meal_location TEXT;
    ALTER TABLE comments ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE comments ADD COLUMN IF NOT EXISTS email TEXT;
  `);

  // Clean up photos that were uploaded but never attached to a published post.
  await pool.query(
    `DELETE FROM photos WHERE post_id IS NULL AND created_at < now() - interval '7 days'`
  );
}

async function getSetting(key) {
  const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return r.rows[0] ? r.rows[0].value : null;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

module.exports = { pool, init, getSetting, setSetting };
