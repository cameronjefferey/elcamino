const path = require('path');
const crypto = require('crypto');
const express = require('express');
const compressionMw = require('compression');
const cookieParser = require('cookie-parser');
const multer = require('multer');

const { pool, init, getSetting, setSetting } = require('./db');
const { notifySubscribersOfPost } = require('./mailer');
const TOWNS = require('./camino-data');
const config = require('./config.json');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const AUTHOR_PASSWORD = process.env.AUTHOR_PASSWORD || 'buen-camino-2026';
const AUTH_TOKEN = crypto.createHmac('sha256', SECRET).update('camino-author').digest('hex');
const COOKIE = 'camino_token';

const app = express();
app.set('trust proxy', 1);
app.use(compressionMw());
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

// ---------- auth ----------

function isAuthed(req) {
  return req.cookies[COOKIE] === AUTH_TOKEN;
}

function requireAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ error: 'Not logged in' });
  next();
}

const loginAttempts = new Map(); // ip -> { count, resetAt }
function tooManyAttempts(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    loginAttempts.set(ip, { count: 0, resetAt: now + 60 * 60 * 1000 });
    return false;
  }
  return rec.count >= 20;
}

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (tooManyAttempts(ip)) {
    return res.status(429).json({ error: 'Too many tries. Please wait an hour and try again.' });
  }
  const password = String(req.body.password || '');
  const ok =
    password.length === AUTHOR_PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(password), Buffer.from(AUTHOR_PASSWORD));
  if (!ok) {
    loginAttempts.get(ip).count++;
    return res.status(401).json({ error: 'That password isn\u2019t right. Try again \u2014 no rush!' });
  }
  res.cookie(COOKIE, AUTH_TOKEN, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 180 * 24 * 60 * 60 * 1000, // stay logged in for 6 months
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ authed: isAuthed(req) }));

// ---------- config / health ----------

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => {
  res.json({ ...config, towns: TOWNS });
});

// ---------- posts ----------

async function attachPhotos(posts) {
  if (!posts.length) return posts;
  const ids = posts.map((p) => p.id);
  const { rows } = await pool.query(
    `SELECT id, post_id FROM photos WHERE post_id = ANY($1) ORDER BY position, id`,
    [ids]
  );
  const byPost = {};
  for (const r of rows) (byPost[r.post_id] ||= []).push(r.id);
  for (const p of posts) p.photo_ids = byPost[p.id] || [];
  return posts;
}

app.get('/api/posts', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const offset = parseInt(req.query.offset) || 0;
  const [{ rows: posts }, { rows: countRows }] = await Promise.all([
    pool.query(
      `SELECT id, title, body, day_number, location, created_at, updated_at
       FROM posts ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    ),
    pool.query('SELECT COUNT(*)::int AS total FROM posts'),
  ]);
  await attachPhotos(posts);
  res.json({ posts, total: countRows[0].total });
});

app.get('/api/posts/:id', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, title, body, day_number, location, created_at, updated_at
     FROM posts WHERE id = $1`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Post not found' });
  await attachPhotos(rows);
  res.json(rows[0]);
});

async function claimPhotos(postId, photoIds) {
  // Attach uploaded photos to the post (only unclaimed ones or ones already on this post).
  const ids = (photoIds || []).map(Number).filter(Number.isInteger);
  await pool.query('UPDATE photos SET post_id = NULL WHERE post_id = $1', [postId]);
  for (let i = 0; i < ids.length; i++) {
    await pool.query(
      `UPDATE photos SET post_id = $1, position = $2
       WHERE id = $3 AND (post_id IS NULL OR post_id = $1)`,
      [postId, i, ids[i]]
    );
  }
  // Anything left detached from this post will be swept by the orphan cleanup.
}

app.post('/api/posts', requireAuth, async (req, res) => {
  const { title, body, day_number, location, photo_ids } = req.body;
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Please give your post a title.' });
  }
  const { rows } = await pool.query(
    `INSERT INTO posts (title, body, day_number, location)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [String(title).trim(), String(body || ''), day_number || null, location || null]
  );
  const post = rows[0];
  await claimPhotos(post.id, photo_ids);
  await attachPhotos([post]);
  res.json(post);
  notifySubscribersOfPost(post); // async, non-blocking
});

app.put('/api/posts/:id', requireAuth, async (req, res) => {
  const { title, body, day_number, location, photo_ids } = req.body;
  const { rows } = await pool.query(
    `UPDATE posts SET title = $1, body = $2, day_number = $3, location = $4, updated_at = now()
     WHERE id = $5 RETURNING *`,
    [String(title || '').trim(), String(body || ''), day_number || null, location || null, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Post not found' });
  await claimPhotos(rows[0].id, photo_ids);
  await attachPhotos(rows);
  res.json(rows[0]);
});

app.delete('/api/posts/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM posts WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---------- photos ----------

app.post('/api/upload', requireAuth, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No photo received' });
  const { rows } = await pool.query(
    'INSERT INTO photos (data, mime) VALUES ($1, $2) RETURNING id',
    [req.file.buffer, req.file.mimetype || 'image/jpeg']
  );
  res.json({ id: rows[0].id });
});

app.get('/photos/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT data, mime FROM photos WHERE id = $1', [
    req.params.id,
  ]);
  if (!rows.length) return res.status(404).end();
  res.set('Content-Type', rows[0].mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(rows[0].data);
});

// ---------- location ----------

app.get('/api/location', async (req, res) => {
  const loc = await getSetting('location');
  res.json(loc || { townIndex: 0 });
});

app.put('/api/location', requireAuth, async (req, res) => {
  const townIndex = parseInt(req.body.townIndex);
  if (!Number.isInteger(townIndex) || townIndex < 0 || townIndex >= TOWNS.length) {
    return res.status(400).json({ error: 'Please pick a town from the list.' });
  }
  const loc = { townIndex, updatedAt: new Date().toISOString() };
  await setSetting('location', loc);
  res.json(loc);
});

// ---------- metrics ----------

app.get('/api/metrics', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM metrics ORDER BY date ASC');
  res.json({ entries: rows });
});

app.post('/api/metrics', requireAuth, async (req, res) => {
  const m = req.body;
  if (!m.date) return res.status(400).json({ error: 'Please pick a date.' });
  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
  const { rows } = await pool.query(
    `INSERT INTO metrics (date, day_number, start_town, end_town, miles, steps, elevation_ft, blisters, cafes, favorite)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (date) DO UPDATE SET
       day_number = EXCLUDED.day_number, start_town = EXCLUDED.start_town,
       end_town = EXCLUDED.end_town, miles = EXCLUDED.miles, steps = EXCLUDED.steps,
       elevation_ft = EXCLUDED.elevation_ft, blisters = EXCLUDED.blisters,
       cafes = EXCLUDED.cafes, favorite = EXCLUDED.favorite
     RETURNING *`,
    [
      m.date, num(m.day_number), m.start_town || null, m.end_town || null,
      num(m.miles), num(m.steps), num(m.elevation_ft), num(m.blisters),
      num(m.cafes), m.favorite || null,
    ]
  );
  res.json(rows[0]);
});

app.delete('/api/metrics/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM metrics WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---------- follow / subscribers ----------

app.post('/api/subscribe', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'That doesn\u2019t look like an email address \u2014 mind checking it?' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  const result = await pool.query(
    `INSERT INTO subscribers (email, token) VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING RETURNING id`,
    [email, token]
  );
  res.json({
    ok: true,
    message: result.rows.length
      ? 'You\u2019re on the list! You\u2019ll get an email whenever there\u2019s a new post.'
      : 'Good news \u2014 you were already on the list!',
  });
});

app.get('/unsubscribe', async (req, res) => {
  const token = String(req.query.token || '');
  let message = 'That unsubscribe link doesn\u2019t look right. It may have already been used.';
  if (token) {
    const r = await pool.query('DELETE FROM subscribers WHERE token = $1 RETURNING email', [token]);
    if (r.rows.length) message = `Done \u2014 ${r.rows[0].email} won\u2019t get any more emails from us. Thanks for following along!`;
  }
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Unsubscribed</title><link rel="stylesheet" href="/css/style.css"></head>
    <body><div style="max-width:520px;margin:15vh auto;padding:32px;text-align:center;">
    <h1 style="font-family:Fraunces,Georgia,serif;">Unsubscribed</h1>
    <p style="font-size:18px;line-height:1.6;">${message}</p>
    <p><a href="/" style="color:#b4532a;">\u2190 Back to the blog</a></p>
    </div></body></html>`);
});

app.get('/api/subscribers/count', async (req, res) => {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM subscribers');
  res.json({ count: rows[0].n });
});

// ---------- static pages ----------

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', extensions: ['html'] }));

const send = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
app.get('/post/:id', send('post.html'));
app.get('/map', send('map.html'));
app.get('/metrics', send('metrics.html'));
app.get('/about', send('about.html'));
app.get('/follow', send('follow.html'));
app.get('/write', send('write.html'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
});

init()
  .then(() => {
    app.listen(PORT, () => console.log(`Camino blog running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
