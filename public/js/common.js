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

  postCardHtml(post, { linkTitle = true } = {}) {
    const paragraphs = String(post.body || '')
      .split(/\n{2,}/)
      .map((p) => `<p>${this.esc(p).replace(/\n/g, '<br>')}</p>`)
      .join('');
    const meta = [];
    if (post.day_number) meta.push(`<span class="day-chip">Day ${post.day_number}</span>`);
    meta.push(`<span>${this.fmtDate(post.created_at)}</span>`);
    if (post.location) meta.push(`<span>📍 ${this.esc(post.location)}</span>`);
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
};
