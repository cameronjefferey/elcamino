/* Shared helpers: config, header/nav, formatting, units, lightbox. */

const Camino = {
  _config: null,

  async config() {
    if (this._config) return this._config;
    const cached = sessionStorage.getItem('camino_config');
    if (cached) {
      this._config = JSON.parse(cached);
      return this._config;
    }
    const res = await fetch('/api/config');
    this._config = await res.json();
    sessionStorage.setItem('camino_config', JSON.stringify(this._config));
    return this._config;
  },

  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  },

  fmtDate(iso, opts) {
    return new Date(iso).toLocaleDateString(undefined, opts || {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
  },

  fmtDateShort(iso) {
    // For date-only strings, avoid timezone shifting by parsing parts.
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  },

  fmtNum(n) {
    return Number(n).toLocaleString();
  },

  // ---- units (miles stored canonically; km = mi * 1.609344) ----
  getUnits() { return localStorage.getItem('camino_units') || 'mi'; },
  setUnits(u) { localStorage.setItem('camino_units', u); },
  miToKm(mi) { return mi * 1.609344; },
  kmToMi(km) { return km / 1.609344; },
  dist(miles, units, decimals = 0) {
    const v = units === 'km' ? this.miToKm(miles) : miles;
    return v.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: 0 });
  },
  unitLabel(units) { return units === 'km' ? 'km' : 'miles'; },

  // Day number based on the configured start date (Day 1 = start date).
  dayNumberFor(dateStr, startDate) {
    const p = (s) => { const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return new Date(+m[1], +m[2] - 1, +m[3]); };
    const diff = Math.round((p(dateStr) - p(startDate)) / 86400000) + 1;
    return diff >= 1 ? diff : null;
  },

  todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  // ---- weather (Open-Meteo WMO codes) ----
  cToF(c) { return c * 9 / 5 + 32; },
  temp(c, units) {
    const v = units === 'km' ? c : this.cToF(c);
    return `${Math.round(v)}°`;
  },
  weatherIcon(code) {
    if (code === 0) return { icon: '☀️', label: 'Clear' };
    if (code <= 2) return { icon: '🌤️', label: 'Partly cloudy' };
    if (code === 3) return { icon: '☁️', label: 'Overcast' };
    if (code <= 48) return { icon: '🌫️', label: 'Foggy' };
    if (code <= 57) return { icon: '🌦️', label: 'Drizzle' };
    if (code <= 67) return { icon: '🌧️', label: 'Rain' };
    if (code <= 77) return { icon: '🌨️', label: 'Snow' };
    if (code <= 82) return { icon: '🌦️', label: 'Rain showers' };
    if (code <= 86) return { icon: '🌨️', label: 'Snow showers' };
    return { icon: '⛈️', label: 'Thunderstorm' };
  },

  weatherCardHtml(weather, units) {
    const cards = weather.locations.map((loc) => {
      const w = this.weatherIcon(loc.isCurrent ? loc.current.code : loc.today.code);
      const rain = loc.today.rainChance;
      return `<div class="weather-tile ${loc.isCurrent ? 'current' : ''}">
        <div class="w-town">${loc.isCurrent ? '📍 ' : ''}${this.esc(loc.name)}</div>
        <div class="w-icon" title="${w.label}">${w.icon}</div>
        <div class="w-label">${w.label}</div>
        ${loc.isCurrent
          ? `<div class="w-temp">${this.temp(loc.current.tempC, units)}</div>
             <div class="w-sub">feels like ${this.temp(loc.current.feelsLikeC, units)}</div>`
          : `<div class="w-temp">${this.temp(loc.today.highC, units)}<span class="w-low"> / ${this.temp(loc.today.lowC, units)}</span></div>
             <div class="w-sub">high / low today</div>`}
        <div class="w-sub">${rain != null ? `☔ ${rain}% chance of rain` : '&nbsp;'}</div>
      </div>`;
    }).join('');
    const ahead = weather.locations.length - 1;
    const note = ahead > 0
      ? `Where they are now, plus the next ${ahead === 1 ? 'town' : `${ahead} towns`} ahead.`
      : 'They\u2019ve reached the end of the trail!';
    return `<h2 class="weather-heading">Weather on the trail</h2>
      <div class="weather-strip">${cards}</div>
      <div class="w-note">${note}</div>`;
  },

  async renderWeather(el) {
    if (!el) return;
    try {
      const res = await fetch('/api/weather');
      if (!res.ok) return;
      const weather = await res.json();
      el.innerHTML = this.weatherCardHtml(weather, this.getUnits());
      el.style.display = '';
    } catch { /* weather is a bonus, never break the page */ }
  },

  shellSvg(cls) {
    return `<svg class="${cls || ''}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <path d="M32 56 L12 42 C6 30 10 14 32 8 C54 14 58 30 52 42 Z" fill="#d9a441"/>
      <g stroke="#a97a1f" stroke-width="2.4" stroke-linecap="round">
        <path d="M32 54 L32 10"/><path d="M32 54 L18 14"/><path d="M32 54 L46 14"/>
        <path d="M32 54 L13 26"/><path d="M32 54 L51 26"/>
      </g>
    </svg>`;
  },

  async renderHeader(active) {
    const cfg = await this.config();
    const header = document.querySelector('.site-header');
    if (!header) return;
    const links = [
      ['/', 'Latest Posts'],
      ['/map', 'Map'],
      ['/metrics', 'Metrics'],
      ['/about', 'About the Camino'],
      ['/follow', 'Follow Along'],
    ];
    header.innerHTML = `
      <div class="header-inner">
        <a class="brand" href="/">${this.shellSvg()}<span class="brand-title">${this.esc(cfg.siteTitle)}</span></a>
        <nav class="main-nav">
          ${links.map(([href, label]) =>
            `<a href="${href}" class="${href === active ? 'active' : ''}">${label}</a>`).join('')}
        </nav>
      </div>`;
    document.title = active === '/'
      ? cfg.siteTitle
      : `${links.find(([h]) => h === active)?.[1] || ''} · ${cfg.siteTitle}`;
  },

  async renderFooter() {
    const el = document.querySelector('.site-footer');
    if (!el) return;
    const cfg = await this.config();
    el.innerHTML = `Made with love for the road to Santiago · <a href="/write">${this.esc(cfg.authors)}: write here</a>`;
  },

  // ---- lightbox ----
  openLightbox(photoIds, start = 0) {
    let idx = start;
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `
      <img alt="Photo">
      <button class="lb-close" aria-label="Close">✕</button>
      <button class="lb-prev" aria-label="Previous">‹</button>
      <button class="lb-next" aria-label="Next">›</button>
      <div class="lb-count"></div>`;
    const img = lb.querySelector('img');
    const count = lb.querySelector('.lb-count');
    const show = (i) => {
      idx = (i + photoIds.length) % photoIds.length;
      img.src = `/photos/${photoIds[idx]}`;
      count.textContent = photoIds.length > 1 ? `${idx + 1} of ${photoIds.length}` : '';
      lb.querySelector('.lb-prev').style.display = photoIds.length > 1 ? '' : 'none';
      lb.querySelector('.lb-next').style.display = photoIds.length > 1 ? '' : 'none';
    };
    const close = () => { lb.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') show(idx - 1);
      if (e.key === 'ArrowRight') show(idx + 1);
    };
    lb.querySelector('.lb-close').onclick = close;
    lb.querySelector('.lb-prev').onclick = (e) => { e.stopPropagation(); show(idx - 1); };
    lb.querySelector('.lb-next').onclick = (e) => { e.stopPropagation(); show(idx + 1); };
    lb.onclick = (e) => { if (e.target === lb || e.target === img) close(); };
    document.addEventListener('keydown', onKey);
    // simple swipe
    let touchX = null;
    lb.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener('touchend', (e) => {
      if (touchX === null) return;
      const dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) > 50) show(idx + (dx < 0 ? 1 : -1));
      touchX = null;
    }, { passive: true });
    document.body.appendChild(lb);
    show(idx);
  },

  photoGridHtml(photoIds) {
    if (!photoIds || !photoIds.length) return '';
    const cls = photoIds.length === 1 ? 'count-1' : '';
    const odd = photoIds.length % 2 === 1 && photoIds.length > 1;
    return `<div class="photo-grid ${cls}" data-photos="${photoIds.join(',')}">
      ${photoIds.map((id, i) => `
        <div class="${odd && i === 0 ? 'first-wide' : ''}">
          <img src="/photos/${id}" loading="lazy" alt="Photo from the trail" data-index="${i}">
        </div>`).join('')}
    </div>`;
  },

  bindPhotoGrids(root) {
    (root || document).querySelectorAll('.photo-grid').forEach((grid) => {
      const ids = grid.dataset.photos.split(',');
      grid.querySelectorAll('img').forEach((img) => {
        img.addEventListener('click', () => Camino.openLightbox(ids, Number(img.dataset.index)));
      });
    });
  },

  // Turn a plain town text field into a tap-anywhere dropdown: clicking the
  // field shows the full town list, tapping a town fills it, and typing still
  // works for places that aren't on the list (it just filters the list).
  attachTownPicker(input, towns) {
    if (!input || input._townPicker) return;
    input._townPicker = true;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('data-lpignore', 'true'); // hush password managers
    input.setAttribute('data-1p-ignore', 'true');
    input.removeAttribute('list'); // we render our own dropdown instead

    const wrap = document.createElement('div');
    wrap.className = 'town-picker';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const panel = document.createElement('div');
    panel.className = 'town-options';
    panel.hidden = true;
    wrap.appendChild(panel);

    const names = towns.map((t) => t.name);
    let selecting = false;

    const render = (showAll) => {
      const q = input.value.trim().toLowerCase();
      const list = showAll || !q ? names : names.filter((n) => n.toLowerCase().includes(q));
      panel.innerHTML = (list.length ? list : names)
        .map((n) => `<button type="button" class="town-option">${this.esc(n)}</button>`)
        .join('');
    };
    const open = (showAll) => { render(showAll); panel.hidden = false; };
    const close = () => { panel.hidden = true; };

    input.addEventListener('focus', () => open(true));
    input.addEventListener('click', () => open(true));
    input.addEventListener('input', () => { if (!selecting) open(false); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    input.addEventListener('blur', () => setTimeout(close, 150));

    panel.addEventListener('mousedown', (e) => {
      const btn = e.target.closest('.town-option');
      if (!btn) return;
      e.preventDefault(); // keep focus off the panel so blur doesn't fire first
      selecting = true;
      input.value = btn.textContent;
      input.dispatchEvent(new Event('input', { bubbles: true })); // fire autosave etc.
      selecting = false;
      close();
    });
  },

  postCardHtml(post, { linkTitle = true } = {}) {
    const paragraphs = String(post.body || '')
      .split(/\n{2,}/)
      .map((p) => `<p>${this.esc(p).replace(/\n/g, '<br>')}</p>`)
      .join('');
    const meta = [];
    if (post.day_number) meta.push(`<span class="day-chip">Day ${post.day_number}</span>`);
    meta.push(`<span>${this.fmtDate(post.created_at)}</span>`);
    if (post.location) meta.push(`<span>📍 ${this.esc(post.location)}</span>`);
    // On the feed, a comment count nudges readers into the conversation.
    if (linkTitle && post.comment_count > 0) {
      meta.push(`<a href="/post/${post.id}#comments" style="text-decoration:none;">💬 ${post.comment_count}</a>`);
    }
    const title = linkTitle
      ? `<a href="/post/${post.id}">${this.esc(post.title)}</a>`
      : this.esc(post.title);
    return `<article class="post-card">
      <div class="post-meta">${meta.join(' · ')}</div>
      <h2>${title}</h2>
      <div class="post-body">${paragraphs}</div>
      ${this.photoGridHtml(post.photo_ids)}
    </article>`;
  },

  // ---- comments ----
  // Shared renderer so a comment looks the same on the post page and in the
  // author's moderation view. `authed` unlocks the little Delete button.
  commentHtml(c, { authed = false } = {}) {
    const when = this.fmtDate(c.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const paras = String(c.body || '')
      .split(/\n{2,}/)
      .map((p) => `<p>${this.esc(p).replace(/\n/g, '<br>')}</p>`)
      .join('');
    return `<div class="comment ${c.is_author ? 'from-author' : ''}" data-id="${c.id}">
      <div class="comment-head">
        <span class="comment-name">${this.esc(c.author_name)}${c.is_author ? ' <span class="author-badge">✍️ author</span>' : ''}</span>
        <span class="comment-when">${when}</span>
      </div>
      <div class="comment-body">${paras}</div>
      ${authed ? '<button type="button" class="comment-delete" aria-label="Delete comment">Delete</button>' : ''}
    </div>`;
  },
};
