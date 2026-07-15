(async function () {
  await Camino.renderHeader(null);
  Camino.renderFooter();
  const cfg = await Camino.config();

  const id = location.pathname.split('/').pop();
  const el = document.getElementById('post');
  const res = await fetch(`/api/posts/${id}`);
  if (!res.ok) {
    el.innerHTML = `<div class="card center"><h2>Hmm, we couldn’t find that post.</h2>
      <p><a href="/">Head back to the latest posts →</a></p></div>`;
    return;
  }
  const post = await res.json();
  document.title = `${post.title} · ${cfg.siteTitle}`;
  el.innerHTML = Camino.postCardHtml(post, { linkTitle: false });
  Camino.bindPhotoGrids(el);

  // ---- share this post ----
  const postUrl = `${location.origin}/post/${post.id}`;
  const share = document.createElement('div');
  share.className = 'center mt';
  share.innerHTML = `
    <a class="btn" style="background:#1877f2;" target="_blank" rel="noopener"
       href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(postUrl)}">Share to Facebook</a>
    <button class="btn subtle" id="share-generic" type="button" style="margin-left:8px;">🔗 Share link</button>
    <div id="share-generic-msg"></div>`;
  el.appendChild(share);
  document.getElementById('share-generic').addEventListener('click', async () => {
    const data = { title: post.title, text: `${post.title} — ${cfg.siteTitle}`, url: postUrl };
    if (navigator.share) {
      try { await navigator.share(data); } catch { /* dismissed */ }
      return;
    }
    const m = document.getElementById('share-generic-msg');
    try {
      await navigator.clipboard.writeText(postUrl);
      m.innerHTML = `<div class="notice ok">Link copied!</div>`;
    } catch {
      m.innerHTML = `<div class="notice ok">${Camino.esc(postUrl)}</div>`;
    }
  });

  // ---- comments ----
  const { authed } = await (await fetch('/api/me')).json().catch(() => ({ authed: false }));

  const section = document.createElement('section');
  section.id = 'comments';
  section.className = 'card comments-card';
  section.innerHTML = `
    <h2 class="comments-title">Comments</h2>
    <div id="comments-list"><p style="color:var(--ink-soft);">Loading…</p></div>
    <form id="comment-form" class="comment-form">
      <h3 style="margin:0 0 4px;">${authed ? 'Reply as ' + Camino.esc(cfg.authors) : 'Leave a note'}</h3>
      ${authed ? '' : `
        <label for="cf-name">Your name</label>
        <input type="text" id="cf-name" placeholder="e.g. Aunt Sue" autocomplete="name" maxlength="80">`}
      <input type="text" name="website" tabindex="-1" autocomplete="off"
             style="position:absolute; left:-9999px;" aria-hidden="true">
      <label for="cf-body">${authed ? 'Your reply' : 'Your message'}</label>
      <textarea id="cf-body" placeholder="Say hello, cheer them on, ask a question…" style="min-height:120px;"></textarea>
      ${authed ? '' : `
        <label class="privacy-check">
          <input type="checkbox" id="cf-private">
          <span>Keep this private — only ${Camino.esc(cfg.authors)} will see it (it won't appear on the page)</span>
        </label>
        <div id="cf-private-extra" hidden>
          <label for="cf-email">Your email <span class="hint">(optional — so they can write back to you privately)</span></label>
          <input type="email" id="cf-email" placeholder="your@email.com" autocomplete="email">
        </div>`}
      <button class="btn green mt" type="submit" id="cf-submit">${authed ? 'Post reply ✓' : 'Post comment ✓'}</button>
      <div id="comment-msg"></div>
    </form>`;
  el.appendChild(section);

  const listEl = document.getElementById('comments-list');

  function bindDeletes() {
    listEl.querySelectorAll('.comment-delete').forEach((b) => {
      b.addEventListener('click', async () => {
        const wrap = b.closest('.comment');
        if (!confirm('Delete this comment?')) return;
        await fetch(`/api/comments/${wrap.dataset.id}`, { method: 'DELETE' });
        wrap.remove();
        if (!listEl.querySelector('.comment')) renderEmpty();
      });
    });
  }
  function renderEmpty() {
    listEl.innerHTML = `<p class="comments-empty">No comments yet — be the first to say hello! 👋</p>`;
  }

  async function loadComments() {
    try {
      const { comments } = await (await fetch(`/api/posts/${post.id}/comments`)).json();
      if (!comments.length) return renderEmpty();
      listEl.innerHTML = comments.map((c) => Camino.commentHtml(c, { authed })).join('');
      bindDeletes();
    } catch {
      listEl.innerHTML = `<p class="comments-empty">Couldn’t load comments right now.</p>`;
    }
  }
  await loadComments();

  // Reveal the optional email field only when a reader chooses "private".
  const privateBox = document.getElementById('cf-private');
  if (privateBox) {
    privateBox.addEventListener('change', () => {
      document.getElementById('cf-private-extra').hidden = !privateBox.checked;
    });
  }

  document.getElementById('comment-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('cf-submit');
    const msg = document.getElementById('comment-msg');
    const body = document.getElementById('cf-body').value.trim();
    if (!body) {
      msg.innerHTML = `<div class="notice err">Write a little something first!</div>`;
      return;
    }
    const isPrivate = !authed && privateBox && privateBox.checked;
    btn.disabled = true;
    btn.textContent = 'Posting…';
    const payload = {
      body,
      website: e.target.website.value,
      name: authed ? undefined : (document.getElementById('cf-name')?.value || ''),
      is_private: isPrivate,
      email: isPrivate ? (document.getElementById('cf-email')?.value || '') : undefined,
    };
    try {
      const res = await fetch(`/api/posts/${post.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server error');
      document.getElementById('cf-body').value = '';
      if (isPrivate) {
        // Private notes never appear on the page — reassure the reader instead.
        if (privateBox) { privateBox.checked = false; document.getElementById('cf-private-extra').hidden = true; }
        if (document.getElementById('cf-email')) document.getElementById('cf-email').value = '';
        msg.innerHTML = `<div class="notice ok">Sent privately to ${Camino.esc(cfg.authors)} 🔒 — it won’t show up on the page.</div>`;
      } else {
        if (listEl.querySelector('.comments-empty')) listEl.innerHTML = '';
        listEl.insertAdjacentHTML('beforeend', Camino.commentHtml(data, { authed }));
        bindDeletes();
        msg.innerHTML = `<div class="notice ok">Posted — thanks! 🎉</div>`;
        listEl.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } catch (err) {
      msg.innerHTML = `<div class="notice err">${Camino.esc(err.message)}</div>`;
    }
    btn.disabled = false;
    btn.textContent = authed ? 'Post reply ✓' : 'Post comment ✓';
  });
})();
