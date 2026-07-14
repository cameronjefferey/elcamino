(async function () {
  await Camino.renderHeader('/');
  Camino.renderFooter();
  const cfg = await Camino.config();

  document.getElementById('hero-shell').innerHTML = Camino.shellSvg('shell');
  document.getElementById('hero-title').textContent = cfg.siteTitle;
  document.getElementById('hero-tagline').textContent = cfg.tagline;
  document.getElementById('intro-text').textContent = cfg.intro;
  document.getElementById('intro-card').style.display = '';

  // ---- status strip (day / location / miles) ----
  try {
    const units = Camino.getUnits();
    const [locRes, metricsRes] = await Promise.all([
      fetch('/api/location'), fetch('/api/metrics'),
    ]);
    const loc = await locRes.json();
    const { entries } = await metricsRes.json();
    const chips = [];
    if (entries.length) {
      const totalMiles = entries.reduce((s, e) => s + Number(e.miles || 0), 0);
      const lastDay = Math.max(...entries.map((e) => e.day_number || 0));
      if (lastDay) chips.push(`<span class="status-chip"><span class="icon">🥾</span>Day ${lastDay}</span>`);
      if (totalMiles) chips.push(`<span class="status-chip"><span class="icon">🛤️</span>${Camino.dist(totalMiles, units)} ${Camino.unitLabel(units)} walked</span>`);
    }
    const town = cfg.towns[loc.townIndex ?? 0];
    if (town && (loc.updatedAt || loc.townIndex > 0)) {
      chips.push(`<a class="status-chip" href="/map" style="text-decoration:none;"><span class="icon">📍</span>Now in ${Camino.esc(town.name)}</a>`);
    }
    document.getElementById('status-strip').innerHTML = chips.join('');
  } catch (e) { /* status strip is decorative */ }

  // ---- inline follow form ----
  const form = document.getElementById('follow-inline');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msgEl = document.getElementById('follow-inline-msg');
    const email = form.email.value;
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      msgEl.innerHTML = `<div class="notice ${res.ok ? 'ok' : 'err'}">${Camino.esc(data.message || data.error)}</div>`;
      if (res.ok) form.reset();
    } catch {
      msgEl.innerHTML = `<div class="notice err">Couldn’t reach the server — please try again.</div>`;
    }
  });

  // ---- posts feed ----
  const feed = document.getElementById('feed');
  const loadMoreBtn = document.getElementById('load-more');
  let offset = 0;
  const LIMIT = 10;

  async function loadPosts() {
    loadMoreBtn.disabled = true;
    const res = await fetch(`/api/posts?offset=${offset}&limit=${LIMIT}`);
    const { posts, total } = await res.json();
    if (offset === 0 && !posts.length) {
      feed.innerHTML = `<div class="card center">
        <h2 style="margin-top:0;">The journey hasn’t started yet!</h2>
        <p>Check back soon — the first post from the trail will show up right here.</p>
      </div>`;
      return;
    }
    const div = document.createElement('div');
    div.innerHTML = posts.map((p) => Camino.postCardHtml(p)).join('');
    Camino.bindPhotoGrids(div);
    feed.appendChild(div);
    offset += posts.length;
    loadMoreBtn.style.display = offset < total ? '' : 'none';
    loadMoreBtn.disabled = false;
  }

  loadMoreBtn.addEventListener('click', loadPosts);
  loadPosts();
})();
