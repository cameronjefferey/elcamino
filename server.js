const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const compressionMw = require('compression');
const cookieParser = require('cookie-parser');
const multer = require('multer');

const { pool, init, getSetting, setSetting } = require('./db');
const { notifySubscribersOfPost, sendWelcomeEmail, sendReply } = require('./mailer');
const { fetchInboxMessages } = require('./inbox');
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
      `SELECT id, title, body, day_number, location, created_at, updated_at,
              (SELECT COUNT(*)::int FROM comments c WHERE c.post_id = posts.id AND c.is_private = false) AS comment_count
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
    `SELECT id, title, body, day_number, location, created_at, updated_at,
            (SELECT COUNT(*)::int FROM comments c WHERE c.post_id = posts.id AND c.is_private = false) AS comment_count
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

// ---------- comments ----------

// Readers post comments without an account, so guard the public endpoint with a
// light rate limit and a hidden honeypot field that only bots tend to fill.
const commentAttempts = new Map(); // ip -> { count, resetAt }
function tooManyComments(ip) {
  const now = Date.now();
  const rec = commentAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    commentAttempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return false;
  }
  rec.count++;
  return rec.count > 8;
}

// Public list: only public comments ever leave the server here. Private notes
// are for the authors' eyes only (see the /api/comments moderation route).
app.get('/api/posts/:id/comments', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, post_id, author_name, body, is_author, created_at
     FROM comments WHERE post_id = $1 AND is_private = false ORDER BY created_at ASC`,
    [req.params.id]
  );
  res.json({ comments: rows });
});

app.post('/api/posts/:id/comments', async (req, res) => {
  const authed = isAuthed(req);
  if (req.body.website) return res.json({ ok: true }); // honeypot: silently drop bots
  if (!authed && tooManyComments(req.ip)) {
    return res.status(429).json({ error: 'That\u2019s a lot of comments in a short time \u2014 please wait a bit and try again.' });
  }
  const body = String(req.body.body || '').trim().slice(0, 3000);
  if (!body) return res.status(400).json({ error: 'Please write a little something first!' });
  const name = authed
    ? config.authors
    : String(req.body.name || '').trim().slice(0, 80) || 'Anonymous';
  // The author's on-site replies are always public; only readers can mark a note private.
  const isPrivate = !authed && !!req.body.is_private;
  let email = null;
  if (isPrivate) {
    const e = String(req.body.email || '').trim().toLowerCase();
    if (e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) email = e;
  }

  const { rows: postRows } = await pool.query('SELECT id, title FROM posts WHERE id = $1', [req.params.id]);
  if (!postRows.length) return res.status(404).json({ error: 'That post no longer exists.' });

  const { rows } = await pool.query(
    `INSERT INTO comments (post_id, author_name, body, is_author, is_private, email)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, post_id, author_name, body, is_author, is_private, created_at`,
    [req.params.id, name, body, authed, isPrivate, email]
  );
  res.json(rows[0]);
});

app.delete('/api/comments/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM comments WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// All comments across posts, newest first, for the author's moderation view.
// Includes private notes and whether a private note left an email to reply to.
app.get('/api/comments', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.post_id, c.author_name, c.body, c.is_author, c.is_private,
            c.email, c.created_at, p.title AS post_title
     FROM comments c JOIN posts p ON p.id = c.post_id
     ORDER BY c.created_at DESC LIMIT 200`
  );
  const comments = rows.map((c) => ({ ...c, has_email: !!c.email, email: undefined }));
  res.json({ comments });
});

// Reply privately (by email) to a private comment that left an address.
app.post('/api/comments/:id/reply', requireAuth, async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Write a little something first!' });
  const { rows } = await pool.query(
    `SELECT c.email, c.author_name, p.title AS post_title
     FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = $1`,
    [req.params.id]
  );
  if (!rows.length || !rows[0].email) {
    return res.status(400).json({ error: 'This note didn\u2019t include an email, so there\u2019s no way to write back.' });
  }
  try {
    await sendReply({
      to: rows[0].email,
      subject: `Re: your note on \u201c${rows[0].post_title}\u201d`,
      text,
    });
    console.log(`[comment-reply] emailed ${rows[0].email} (comment ${req.params.id})`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[comment-reply] failed:', err.message);
    res.status(502).json({ error: 'Couldn\u2019t send right now \u2014 try again in a minute.' });
  }
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

// Approximate how far along the route a point is (km from the start) by
// projecting it onto the nearest town-to-town segment of the path. This lets
// off-route villages still show sensible progress on the map.
function kmAlongRoute(lat, lng) {
  const toRad = (d) => (d * Math.PI) / 180;
  const project = (la, lo) => [toRad(lo) * Math.cos(toRad(lat)), toRad(la)];
  const [px, py] = project(lat, lng);
  let best = { dist: Infinity, km: 0 };
  for (let i = 0; i < TOWNS.length - 1; i++) {
    const a = TOWNS[i];
    const b = TOWNS[i + 1];
    const [ax, ay] = project(a.lat, a.lng);
    const [bx, by] = project(b.lat, b.lng);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d < best.dist) best = { dist: d, km: a.km + t * (b.km - a.km) };
  }
  return Math.round(best.km);
}

// Look up a place name -> coordinates via OpenStreetMap's Nominatim (free, no
// key). Low volume + cached, and scoped to Spain/France where the route runs.
const geoCache = new Map();
async function geocodePlace(q) {
  const key = q.toLowerCase();
  if (geoCache.has(key)) return geoCache.get(key);
  const url =
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=es,fr&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Camino family blog (contact: elcaminodesantiago26@gmail.com)' } });
  if (!r.ok) throw new Error(`geocoder ${r.status}`);
  const arr = await r.json();
  const hit = arr[0] ? { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) } : null;
  geoCache.set(key, hit);
  return hit;
}

app.get('/api/location', async (req, res) => {
  const loc = await getSetting('location');
  res.json(loc || { townIndex: 0 });
});

app.put('/api/location', requireAuth, async (req, res) => {
  const save = async (loc) => {
    await setSetting('location', { ...loc, updatedAt: new Date().toISOString() });
    res.json(await getSetting('location'));
  };

  // A known stage town chosen by index.
  if (req.body.townIndex !== undefined && req.body.place === undefined) {
    const townIndex = parseInt(req.body.townIndex);
    if (!Number.isInteger(townIndex) || townIndex < 0 || townIndex >= TOWNS.length) {
      return res.status(400).json({ error: 'Please pick a town from the list.' });
    }
    const t = TOWNS[townIndex];
    return save({ name: t.name, lat: t.lat, lng: t.lng, km: t.km, townIndex });
  }

  // Any typed place. If it matches a stage town, use its exact data; otherwise
  // geocode it and estimate how far along the route it is.
  const place = String(req.body.place || '').trim();
  if (!place) return res.status(400).json({ error: 'Please type where you are.' });
  const matchIdx = TOWNS.findIndex((t) => t.name.toLowerCase() === place.toLowerCase());
  if (matchIdx >= 0) {
    const t = TOWNS[matchIdx];
    return save({ name: t.name, lat: t.lat, lng: t.lng, km: t.km, townIndex: matchIdx });
  }
  try {
    const hit = await geocodePlace(place);
    if (!hit) {
      return res.status(422).json({
        error: `Couldn\u2019t find \u201c${place}\u201d on the map. Try a nearby bigger town, or check the spelling.`,
      });
    }
    return save({ name: place, lat: hit.lat, lng: hit.lng, km: kmAlongRoute(hit.lat, hit.lng), townIndex: null });
  } catch (err) {
    console.error('[location] geocode failed:', err.message);
    res.status(502).json({ error: 'Couldn\u2019t reach the map service right now \u2014 try again in a minute.' });
  }
});

// ---------- weather ----------

// Open-Meteo (open-meteo.com): free, no API key. We fetch the current town
// plus the next 3 on the route in one request and cache for 15 minutes.
let weatherCache = { townIndex: null, expiresAt: 0, payload: null };

app.get('/api/weather', async (req, res) => {
  const loc = await getSetting('location');
  // For a listed town use its index; for a geocoded village use the nearest
  // town by distance-along-route so the forecast still makes sense.
  let idx;
  if (loc && loc.townIndex != null) {
    idx = loc.townIndex;
  } else if (loc && loc.km != null) {
    idx = 0;
    let best = Infinity;
    TOWNS.forEach((t, i) => {
      const d = Math.abs(t.km - loc.km);
      if (d < best) { best = d; idx = i; }
    });
  } else {
    idx = 0;
  }
  idx = Math.min(Math.max(idx, 0), TOWNS.length - 1);

  if (weatherCache.townIndex === idx && Date.now() < weatherCache.expiresAt) {
    return res.json(weatherCache.payload);
  }

  const towns = TOWNS.slice(idx, idx + 4);
  const url =
    'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${towns.map((t) => t.lat).join(',')}` +
    `&longitude=${towns.map((t) => t.lng).join(',')}` +
    '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation' +
    '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code' +
    '&forecast_days=1&timezone=Europe%2FMadrid';

  const r = await fetch(url);
  if (!r.ok) {
    return res.status(502).json({ error: 'Couldn\u2019t reach the weather service. Please try again soon.' });
  }
  let data = await r.json();
  if (!Array.isArray(data)) data = [data]; // single location returns an object

  const payload = {
    updatedAt: new Date().toISOString(),
    locations: towns.map((t, i) => ({
      name: t.name,
      km: t.km,
      isCurrent: i === 0,
      current: {
        tempC: data[i].current.temperature_2m,
        feelsLikeC: data[i].current.apparent_temperature,
        windKmh: data[i].current.wind_speed_10m,
        code: data[i].current.weather_code,
      },
      today: {
        highC: data[i].daily.temperature_2m_max[0],
        lowC: data[i].daily.temperature_2m_min[0],
        rainChance: data[i].daily.precipitation_probability_max[0],
        code: data[i].daily.weather_code[0],
      },
    })),
  };

  weatherCache = { townIndex: idx, expiresAt: Date.now() + 15 * 60 * 1000, payload };
  res.json(payload);
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
    `INSERT INTO metrics (date, day_number, start_town, end_town, miles, steps, elevation_ft, blisters, cafes, favorite, accommodation, meal_location)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (date) DO UPDATE SET
       day_number = EXCLUDED.day_number, start_town = EXCLUDED.start_town,
       end_town = EXCLUDED.end_town, miles = EXCLUDED.miles, steps = EXCLUDED.steps,
       elevation_ft = EXCLUDED.elevation_ft, blisters = EXCLUDED.blisters,
       cafes = EXCLUDED.cafes, favorite = EXCLUDED.favorite,
       accommodation = EXCLUDED.accommodation, meal_location = EXCLUDED.meal_location
     RETURNING *`,
    [
      m.date, num(m.day_number), m.start_town || null, m.end_town || null,
      num(m.miles), num(m.steps), num(m.elevation_ft), num(m.blisters),
      num(m.cafes), m.favorite || null, m.accommodation || null, m.meal_location || null,
    ]
  );
  res.json(rows[0]);
});

app.delete('/api/metrics/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM metrics WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---------- reader messages (email replies) ----------

app.get('/api/messages', requireAuth, async (req, res) => {
  try {
    res.json(await fetchInboxMessages());
  } catch (err) {
    console.error('[inbox] fetch failed:', err.message);
    res.status(502).json({ error: 'Couldn\u2019t reach the mailbox right now. Try again in a minute.' });
  }
});

app.post('/api/messages/:id/reply', requireAuth, async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Write a little something first!' });
  try {
    const { enabled, messages } = await fetchInboxMessages();
    if (!enabled) return res.status(400).json({ error: 'Email isn\u2019t set up yet.' });
    const msg = messages.find((m) => String(m.id) === String(req.params.id));
    if (!msg) {
      return res.status(404).json({ error: 'Couldn\u2019t find that message anymore \u2014 go back and reopen it.' });
    }
    await sendReply({
      to: msg.fromAddress,
      subject: msg.subject,
      text,
      inReplyTo: msg.messageId,
    });
    console.log(`[reply] sent to ${msg.fromAddress} (message ${msg.id})`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[reply] failed:', err.message);
    res.status(502).json({ error: 'Couldn\u2019t send right now \u2014 try again in a minute.' });
  }
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
  const isNew = result.rows.length > 0;
  res.json({
    ok: true,
    message: isNew
      ? 'You\u2019re on the list! We just sent you a welcome note \u2014 if it\u2019s not in your inbox, check your spam folder and mark it \u201cNot spam\u201d so future posts reach you.'
      : 'Good news \u2014 you were already on the list!',
  });
  if (isNew) sendWelcomeEmail(email, token); // async, non-blocking
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

app.get('/api/subscribers', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, email, created_at FROM subscribers ORDER BY created_at DESC'
  );
  res.json({ subscribers: rows });
});

app.delete('/api/subscribers/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM subscribers WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---------- social share previews (Open Graph) ----------
// Facebook, iMessage, WhatsApp, etc. read these tags from the raw HTML (their
// crawlers don't run our JavaScript), so we inject them server-side. This makes
// shared links show a title, blurb, and photo everywhere.

const pageCache = {};
function pageTemplate(file) {
  if (!pageCache[file]) {
    pageCache[file] = fs.readFileSync(path.join(__dirname, 'public', file), 'utf8');
  }
  return pageCache[file];
}
function escAttr(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function baseUrl(req) {
  return process.env.SITE_URL
    ? process.env.SITE_URL.replace(/\/$/, '')
    : `${req.protocol}://${req.get('host')}`;
}
function renderWithOg(file, tags) {
  const meta = tags
    .map(([p, c]) => `    <meta property="${escAttr(p)}" content="${escAttr(c)}">`)
    .join('\n');
  return pageTemplate(file).replace('</head>', `${meta}\n  </head>`);
}

app.get('/', (req, res) => {
  const base = baseUrl(req);
  res.set('Cache-Control', 'public, max-age=300');
  res.type('html').send(renderWithOg('index.html', [
    ['og:site_name', config.siteTitle],
    ['og:title', config.siteTitle],
    ['og:description', config.tagline],
    ['og:type', 'website'],
    ['og:url', `${base}/`],
  ]));
});

app.get('/post/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.title, p.body,
              (SELECT id FROM photos WHERE post_id = p.id ORDER BY position, id LIMIT 1) AS first_photo
       FROM posts p WHERE p.id = $1`,
      [req.params.id]
    );
    res.set('Cache-Control', 'public, max-age=300');
    if (!rows.length) return res.type('html').send(pageTemplate('post.html'));
    const post = rows[0];
    const base = baseUrl(req);
    const desc =
      String(post.body || '').replace(/\s+/g, ' ').trim().slice(0, 200) || config.tagline;
    const tags = [
      ['og:site_name', config.siteTitle],
      ['og:title', post.title],
      ['og:description', desc],
      ['og:type', 'article'],
      ['og:url', `${base}/post/${post.id}`],
    ];
    if (post.first_photo) tags.push(['og:image', `${base}/photos/${post.first_photo}`]);
    res.type('html').send(renderWithOg('post.html', tags));
  } catch (err) {
    next(err);
  }
});

// ---------- static pages ----------

// maxAge 0 + ETag means browsers revalidate each load (cheap 304s) and never
// get stuck on a stale version — important since the audience won't hard-refresh.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true, extensions: ['html'] }));

const send = (file) => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
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
