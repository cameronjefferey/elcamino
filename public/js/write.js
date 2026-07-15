/* Author area: login, posting with photos, location, daily numbers. */

(async function () {
  await Camino.renderHeader(null);
  const cfg = await Camino.config();
  document.title = `Write · ${cfg.siteTitle}`;

  const $ = (id) => document.getElementById(id);
  const DRAFT_KEY = 'camino_draft';

  // ---------- view switching ----------
  const views = ['login', 'menu', 'post', 'location', 'numbers', 'messages', 'comments', 'followers'];
  function show(view) {
    views.forEach((v) => { $(`view-${v}`).hidden = v !== view; });
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('[data-goto]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const v = el.dataset.goto;
      if (v === 'post') startNewPost();
      show(v);
    });
  });

  // ---------- login ----------
  $('login-shell').innerHTML = Camino.shellSvg();
  $('login-greeting').textContent = `Hi ${cfg.authors}! 👋`;
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'One moment…';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: e.target.password.value }),
      });
      const data = await res.json();
      if (res.ok) {
        await enterMenu();
      } else {
        $('login-msg').innerHTML = `<div class="notice err">${Camino.esc(data.error)}</div>`;
      }
    } catch {
      $('login-msg').innerHTML = `<div class="notice err">Couldn’t reach the internet. Try again in a moment.</div>`;
    }
    btn.disabled = false;
    btn.textContent = 'Let me in';
  });

  $('logout-btn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    show('login');
  });

  // ---------- town lists ----------
  const townOptions = cfg.towns.map((t) => `<option value="${Camino.esc(t.name)}">`).join('');
  $('towns-list').innerHTML = townOptions;
  $('towns-list-2').innerHTML = townOptions;
  $('town-select').innerHTML = cfg.towns
    .map((t, i) => `<option value="${i}">${Camino.esc(t.name)} (${t.km} km)</option>`)
    .join('');

  // ---------- menu / my posts ----------
  async function enterMenu() {
    show('menu');
    loadMyPosts();
  }

  async function loadMyPosts() {
    const el = $('my-posts');
    const { posts } = await (await fetch('/api/posts?limit=50')).json();
    if (!posts.length) {
      el.innerHTML = `<p style="color:var(--ink-soft);">No posts yet. Tap “Write a new post” above to share your first one!</p>`;
      return;
    }
    el.innerHTML = posts.map((p) => `
      <div class="post-admin-row" data-id="${p.id}">
        <div style="flex:1; min-width:0;">
          <div class="title">${Camino.esc(p.title)}</div>
          <div class="meta">${Camino.fmtDate(p.created_at, { month: 'short', day: 'numeric' })}${p.photo_ids.length ? ` · ${p.photo_ids.length} photo${p.photo_ids.length > 1 ? 's' : ''}` : ''}</div>
        </div>
        <button class="btn subtle edit-btn">Edit</button>
        <button class="btn subtle delete-btn" style="color:#a33; border-color:#e3c4bc;">Delete</button>
      </div>`).join('');
    el.querySelectorAll('.edit-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const id = Number(b.closest('.post-admin-row').dataset.id);
        startEditPost(posts.find((p) => p.id === id));
      });
    });
    el.querySelectorAll('.delete-btn').forEach((b) => {
      b.addEventListener('click', async () => {
        const row = b.closest('.post-admin-row');
        const title = row.querySelector('.title').textContent;
        if (!confirm(`Delete "${title}" forever?\n\nThis can't be undone.`)) return;
        await fetch(`/api/posts/${row.dataset.id}`, { method: 'DELETE' });
        loadMyPosts();
      });
    });
  }

  // ---------- post form ----------
  let editingId = null;
  let photos = []; // { id, status: 'uploading'|'done'|'error', el, blob }

  function autoDayNumber() {
    return Camino.dayNumberFor(Camino.todayStr(), cfg.startDate) || '';
  }

  function startNewPost() {
    editingId = null;
    $('post-form-title').textContent = 'Write a new post';
    $('publish-btn').textContent = 'Publish ✓';
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    $('pf-title').value = draft?.title || '';
    $('pf-body').value = draft?.body || '';
    $('pf-day').value = draft?.day || autoDayNumber();
    $('pf-location').value = draft?.location || '';
    $('thumbs').innerHTML = '';
    photos = [];
    (draft?.photoIds || []).forEach((id) => addThumbForExisting(id));
    $('post-msg').innerHTML = '';
    $('autosave-note').textContent = draft ? 'Restored your unfinished draft ✓' : '';
    if (!draft?.location) prefillLocation();
  }

  async function prefillLocation() {
    try {
      const loc = await (await fetch('/api/location')).json();
      if (!$('pf-location').value && loc.updatedAt) {
        $('pf-location').value = cfg.towns[loc.townIndex]?.name || '';
      }
    } catch { /* optional nicety */ }
  }

  function startEditPost(post) {
    editingId = post.id;
    $('post-form-title').textContent = 'Fix up your post';
    $('publish-btn').textContent = 'Save changes ✓';
    $('pf-title').value = post.title;
    $('pf-body').value = post.body;
    $('pf-day').value = post.day_number || '';
    $('pf-location').value = post.location || '';
    $('thumbs').innerHTML = '';
    photos = [];
    post.photo_ids.forEach((id) => addThumbForExisting(id));
    $('post-msg').innerHTML = '';
    $('autosave-note').textContent = '';
    show('post');
  }

  // ---- autosave (drafts of NEW posts survive lost connections & closed tabs) ----
  let autosaveTimer = null;
  function scheduleAutosave() {
    if (editingId) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(saveDraft, 600);
  }
  function saveDraft() {
    if (editingId) return;
    const draft = {
      title: $('pf-title').value,
      body: $('pf-body').value,
      day: $('pf-day').value,
      location: $('pf-location').value,
      photoIds: photos.filter((p) => p.status === 'done').map((p) => p.id),
    };
    if (!draft.title && !draft.body && !draft.photoIds.length) {
      localStorage.removeItem(DRAFT_KEY);
      $('autosave-note').textContent = '';
      return;
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    $('autosave-note').textContent = `Saved automatically at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ✓`;
  }
  ['pf-title', 'pf-body', 'pf-day', 'pf-location'].forEach((id) => {
    $(id).addEventListener('input', scheduleAutosave);
  });

  // ---- photos ----
  $('add-photos-btn').addEventListener('click', () => $('photo-input').click());
  $('photo-input').addEventListener('change', (e) => {
    [...e.target.files].forEach((file) => addAndUpload(file));
    e.target.value = '';
  });

  function makeThumb(src) {
    const div = document.createElement('div');
    div.className = 'thumb';
    div.innerHTML = `<img src="${src}" alt="">
      <button type="button" class="remove" aria-label="Remove photo">✕</button>
      <div class="bar"><i></i></div>`;
    $('thumbs').appendChild(div);
    return div;
  }

  function addThumbForExisting(id) {
    const entry = { id, status: 'done', el: makeThumb(`/photos/${id}`) };
    entry.el.querySelector('.bar').remove();
    entry.el.querySelector('.remove').addEventListener('click', () => removePhoto(entry));
    photos.push(entry);
  }

  function removePhoto(entry) {
    photos = photos.filter((p) => p !== entry);
    entry.el.remove();
    scheduleAutosave();
  }

  async function addAndUpload(file) {
    const previewUrl = URL.createObjectURL(file);
    const entry = { id: null, status: 'uploading', el: makeThumb(previewUrl), blob: null };
    entry.el.querySelector('.remove').addEventListener('click', () => removePhoto(entry));
    photos.push(entry);
    entry.blob = await PhotoUpload.compress(file);
    uploadEntry(entry);
  }

  async function uploadEntry(entry) {
    entry.status = 'uploading';
    entry.el.querySelector('.status-overlay')?.remove();
    const bar = entry.el.querySelector('.bar i');
    try {
      const { id } = await PhotoUpload.upload(entry.blob, (frac) => {
        if (bar) bar.style.width = `${Math.round(frac * 100)}%`;
      });
      entry.id = id;
      entry.status = 'done';
      entry.el.querySelector('.bar')?.remove();
      scheduleAutosave();
    } catch {
      entry.status = 'error';
      const overlay = document.createElement('div');
      overlay.className = 'status-overlay';
      overlay.innerHTML = `<button type="button">Didn’t send — tap to retry</button>`;
      overlay.querySelector('button').addEventListener('click', () => uploadEntry(entry));
      entry.el.appendChild(overlay);
    }
  }

  function waitForUploads() {
    return new Promise((resolve) => {
      const check = () => {
        if (!photos.some((p) => p.status === 'uploading')) return resolve();
        setTimeout(check, 500);
      };
      check();
    });
  }

  // ---- publish ----
  $('post-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('post-msg');
    const btn = $('publish-btn');
    if (!$('pf-title').value.trim()) {
      msg.innerHTML = `<div class="notice err">Just add a short title first, then hit Publish.</div>`;
      $('pf-title').focus();
      return;
    }
    btn.disabled = true;
    if (photos.some((p) => p.status === 'uploading')) {
      btn.textContent = 'Waiting for photos to finish…';
      await waitForUploads();
    }
    if (photos.some((p) => p.status === 'error')) {
      msg.innerHTML = `<div class="notice err">One of your photos didn’t upload. Tap it to retry, or tap ✕ to remove it — then Publish again.</div>`;
      btn.disabled = false;
      btn.textContent = editingId ? 'Save changes ✓' : 'Publish ✓';
      return;
    }
    btn.textContent = 'Publishing…';
    const payload = {
      title: $('pf-title').value.trim(),
      body: $('pf-body').value,
      day_number: $('pf-day').value ? Number($('pf-day').value) : null,
      location: $('pf-location').value.trim() || null,
      photo_ids: photos.map((p) => p.id),
    };
    try {
      const res = await fetch(editingId ? `/api/posts/${editingId}` : '/api/posts', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Server error');
      if (editingId) {
        msg.innerHTML = `<div class="notice ok">🎉 Saved!</div>`;
        setTimeout(() => { enterMenu(); }, 1400);
        btn.disabled = false;
        btn.textContent = 'Save changes ✓';
      } else {
        localStorage.removeItem(DRAFT_KEY);
        const postUrl = `${location.origin}/post/${data.id}`;
        msg.innerHTML = `<div class="notice ok">🎉 Published! Everyone following along will get an email.</div>
          <p style="margin-top:16px; font-weight:800;">Want to share it on Facebook too?</p>
          <a class="btn big" style="background:#1877f2;" target="_blank" rel="noopener"
             href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(postUrl)}">Share to Facebook</a>
          <button class="btn subtle big mt" type="button" id="post-done-btn">No thanks, I'm done</button>`;
        $('post-done-btn').addEventListener('click', () => enterMenu());
        btn.disabled = true;
        btn.textContent = 'Published ✓';
      }
    } catch (err) {
      msg.innerHTML = `<div class="notice err">Couldn’t publish (${Camino.esc(err.message)}). Your writing is saved on this phone — try again when the signal is better.</div>`;
      btn.disabled = false;
      btn.textContent = editingId ? 'Save changes ✓' : 'Publish ✓';
    }
  });

  // ---------- location ----------
  async function refreshLocationView() {
    const loc = await (await fetch('/api/location')).json();
    const town = cfg.towns[loc.townIndex ?? 0];
    $('current-loc').innerHTML = loc.updatedAt
      ? `Right now the map says you're in <strong>${Camino.esc(town.name)}</strong>.`
      : `The map hasn't been set yet — pick your starting town below.`;
    $('town-select').value = String(loc.townIndex ?? 0);
  }
  $('view-location').addEventListener('transitionend', () => {});
  document.querySelectorAll('[data-goto="location"]').forEach((el) =>
    el.addEventListener('click', refreshLocationView));

  $('save-location-btn').addEventListener('click', async () => {
    const btn = $('save-location-btn');
    btn.disabled = true;
    try {
      const res = await fetch('/api/location', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ townIndex: Number($('town-select').value) }),
      });
      if (!res.ok) throw new Error();
      const town = cfg.towns[Number($('town-select').value)];
      $('location-msg').innerHTML = `<div class="notice ok">Done! The map now shows you in ${Camino.esc(town.name)}. 📍</div>`;
    } catch {
      $('location-msg').innerHTML = `<div class="notice err">That didn’t save — try again in a moment.</div>`;
    }
    btn.disabled = false;
  });

  // ---------- reader messages ----------
  async function enterMessages() {
    const el = $('messages-list');
    el.innerHTML = `<div class="card center" style="color:var(--ink-soft);">
      Checking the mailbox… this takes a few seconds. ⏳</div>`;
    try {
      const res = await fetch('/api/messages');
      if (!res.ok) throw new Error((await res.json()).error || 'Server error');
      const { enabled, messages } = await res.json();
      if (!enabled) {
        el.innerHTML = `<div class="card center">Email isn't set up yet, so there's no mailbox to check.</div>`;
        return;
      }
      if (!messages.length) {
        el.innerHTML = `<div class="card center">
          <h2 style="margin-top:0;">No messages yet</h2>
          <p style="color:var(--ink-soft);">When friends and family reply to one of your post emails, their notes will show up right here.</p>
        </div>`;
        return;
      }
      el.innerHTML = messages.map((m) => `
        <div class="card" data-id="${m.id}" style="${m.unread ? 'border-left: 5px solid var(--terracotta);' : ''}">
          <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">
            <strong style="font-size:18px;">${m.unread ? '🔵 ' : ''}${Camino.esc(m.fromName)}</strong>
            <span style="color:var(--ink-soft); font-size:15px;">${m.date ? Camino.fmtDate(m.date, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}</span>
          </div>
          <div style="color:var(--ink-soft); font-size:15px; margin: 2px 0 10px;">${Camino.esc(m.subject)}</div>
          <div style="white-space: pre-wrap; font-size:17px;">${Camino.esc(m.text)}</div>
          ${m.quoted ? `<details style="margin-top:12px;">
            <summary style="cursor:pointer; font-weight:700; color:var(--olive-dark); font-size:15px;">See what they replied to ▾</summary>
            <div style="white-space: pre-wrap; font-size:15px; color:var(--ink-soft); border-left: 3px solid var(--line); padding-left: 12px; margin-top: 8px;">${Camino.esc(m.quoted)}</div>
          </details>` : ''}
          <button type="button" class="btn subtle reply-btn mt">↩️&nbsp; Reply</button>
          <div class="reply-box" hidden>
            <textarea placeholder="Write back to ${Camino.esc(m.fromName)}…" style="min-height:130px; margin-top:12px;"></textarea>
            <button type="button" class="btn green big send-reply" style="margin-top:10px;">Send reply ✉️</button>
            <div class="reply-msg"></div>
          </div>
        </div>`).join('');
      el.querySelectorAll('.reply-btn').forEach((b) => {
        b.addEventListener('click', () => {
          const box = b.nextElementSibling;
          box.hidden = !box.hidden;
          if (!box.hidden) box.querySelector('textarea').focus();
        });
      });
      el.querySelectorAll('.send-reply').forEach((b) => {
        b.addEventListener('click', async () => {
          const card = b.closest('.card');
          const box = card.querySelector('.reply-box');
          const textarea = box.querySelector('textarea');
          const msgEl = box.querySelector('.reply-msg');
          if (!textarea.value.trim()) {
            msgEl.innerHTML = `<div class="notice err">Write a little something first!</div>`;
            return;
          }
          b.disabled = true;
          b.textContent = 'Sending…';
          try {
            const res = await fetch(`/api/messages/${card.dataset.id}/reply`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: textarea.value }),
            });
            if (!res.ok) throw new Error((await res.json()).error || 'Server error');
            msgEl.innerHTML = `<div class="notice ok">Sent! 🎉</div>`;
            textarea.disabled = true;
            b.textContent = 'Reply sent ✓';
          } catch (err) {
            msgEl.innerHTML = `<div class="notice err">${Camino.esc(err.message)}</div>`;
            b.disabled = false;
            b.textContent = 'Send reply ✉️';
          }
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="notice err">${Camino.esc(err.message)} — tap the button again to retry.</div>`;
    }
  }
  document.querySelectorAll('[data-goto="messages"]').forEach((el) =>
    el.addEventListener('click', enterMessages));

  // ---------- comments on the blog ----------
  async function enterComments() {
    const el = $('comments-admin');
    el.innerHTML = `<div class="card center" style="color:var(--ink-soft);">Loading…</div>`;
    try {
      const { comments } = await (await fetch('/api/comments')).json();
      if (!comments.length) {
        el.innerHTML = `<div class="card center">
          <h2 style="margin-top:0;">No comments yet</h2>
          <p style="color:var(--ink-soft);">When friends and family leave a note on one of your posts, it'll show up here.</p>
        </div>`;
        return;
      }
      el.innerHTML = comments.map((c) => {
        // Decide how (and whether) the author can reply to this comment.
        // Public reader note → reply publicly on the post.
        // Private note with an email → reply privately by email.
        // Private note without an email → no way to write back.
        let replyBtn = '';
        let replyBox = '';
        if (!c.is_author) {
          if (!c.is_private) {
            replyBtn = `<button type="button" class="btn subtle reply-c mt">↩️&nbsp; Reply publicly</button>`;
            replyBox = `<div class="reply-box" hidden>
              <textarea placeholder="Write back to ${Camino.esc(c.author_name)}…" style="min-height:110px; margin-top:12px;"></textarea>
              <button type="button" class="btn green send-c" data-mode="public" style="margin-top:10px;">Post public reply ✓</button>
              <div class="reply-msg"></div>
            </div>`;
          } else if (c.has_email) {
            replyBtn = `<button type="button" class="btn subtle reply-c mt">↩️&nbsp; Reply by email</button>`;
            replyBox = `<div class="reply-box" hidden>
              <textarea placeholder="Write back to ${Camino.esc(c.author_name)}…" style="min-height:110px; margin-top:12px;"></textarea>
              <button type="button" class="btn green send-c" data-mode="private" style="margin-top:10px;">Send private reply ✉️</button>
              <div class="reply-msg"></div>
            </div>`;
          } else {
            replyBox = `<p class="hint" style="margin-top:10px;">They didn't leave an email, so there's no way to write back to this private note.</p>`;
          }
        }
        return `
        <div class="card ${c.is_private ? 'private-note' : ''}" data-id="${c.id}" data-post="${c.post_id}">
          <div style="color:var(--ink-soft); font-size:15px;">
            ${c.is_private ? '<span class="lock-badge">🔒 Private — only you can see this</span><br>' : ''}
            on <a href="/post/${c.post_id}" target="_blank" rel="noopener">${Camino.esc(c.post_title)}</a>
          </div>
          <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-top:4px;">
            <strong style="font-size:18px;">${c.is_author ? '✍️ ' : ''}${Camino.esc(c.author_name)}</strong>
            <span style="color:var(--ink-soft); font-size:15px;">${c.created_at ? Camino.fmtDate(c.created_at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}</span>
          </div>
          <div style="white-space: pre-wrap; font-size:17px; margin-top:8px;">${Camino.esc(c.body)}</div>
          ${replyBtn}
          <button type="button" class="btn subtle del-c mt" style="color:#a33; border-color:#e3c4bc; margin-left:8px;">Delete</button>
          ${replyBox}
        </div>`;
      }).join('');

      el.querySelectorAll('.reply-c').forEach((b) => {
        b.addEventListener('click', () => {
          const box = b.closest('.card').querySelector('.reply-box');
          box.hidden = !box.hidden;
          if (!box.hidden) box.querySelector('textarea').focus();
        });
      });
      el.querySelectorAll('.del-c').forEach((b) => {
        b.addEventListener('click', async () => {
          const card = b.closest('.card');
          if (!confirm('Delete this comment?')) return;
          await fetch(`/api/comments/${card.dataset.id}`, { method: 'DELETE' });
          card.remove();
          if (!el.querySelector('.card')) enterComments();
        });
      });
      el.querySelectorAll('.send-c').forEach((b) => {
        b.addEventListener('click', async () => {
          const card = b.closest('.card');
          const textarea = card.querySelector('.reply-box textarea');
          const msgEl = card.querySelector('.reply-msg');
          if (!textarea.value.trim()) {
            msgEl.innerHTML = `<div class="notice err">Write a little something first!</div>`;
            return;
          }
          const isPrivate = b.dataset.mode === 'private';
          b.disabled = true;
          b.textContent = isPrivate ? 'Sending…' : 'Posting…';
          try {
            const res = isPrivate
              ? await fetch(`/api/comments/${card.dataset.id}/reply`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ text: textarea.value }),
                })
              : await fetch(`/api/posts/${card.dataset.post}/comments`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ body: textarea.value }),
                });
            if (!res.ok) throw new Error((await res.json()).error || 'Server error');
            msgEl.innerHTML = isPrivate
              ? `<div class="notice ok">Sent by email — just between you two. ✉️</div>`
              : `<div class="notice ok">Reply posted! It's now on the post for everyone to see. 🎉</div>`;
            textarea.disabled = true;
            b.textContent = isPrivate ? 'Reply sent ✓' : 'Reply posted ✓';
          } catch (err) {
            msgEl.innerHTML = `<div class="notice err">${Camino.esc(err.message)}</div>`;
            b.disabled = false;
            b.textContent = isPrivate ? 'Send private reply ✉️' : 'Post public reply ✓';
          }
        });
      });
    } catch (err) {
      el.innerHTML = `<div class="notice err">${Camino.esc(err.message)} — tap the button again to retry.</div>`;
    }
  }
  document.querySelectorAll('[data-goto="comments"]').forEach((el) =>
    el.addEventListener('click', enterComments));

  // ---------- followers ----------
  async function enterFollowers() {
    const list = $('followers-list');
    const summary = $('followers-summary');
    summary.textContent = '';
    list.innerHTML = `<div class="card center" style="color:var(--ink-soft);">Loading…</div>`;
    try {
      const res = await fetch('/api/subscribers');
      if (!res.ok) throw new Error((await res.json()).error || 'Server error');
      const { subscribers } = await res.json();
      summary.textContent = subscribers.length === 1
        ? '1 person gets an email when you post.'
        : `${subscribers.length} people get an email when you post.`;
      if (!subscribers.length) {
        list.innerHTML = `<div class="card center">
          <h2 style="margin-top:0;">Nobody yet!</h2>
          <p style="color:var(--ink-soft);">Tell friends and family to visit the site and tap “Follow along.”</p>
        </div>`;
        return;
      }
      list.innerHTML = `<div class="card">${subscribers.map((s) => `
        <div class="post-admin-row" data-id="${s.id}">
          <div style="flex:1; min-width:0;">
            <div class="title" style="font-weight:400; white-space:normal; word-break:break-all;">${Camino.esc(s.email)}</div>
            <div class="meta">joined ${Camino.fmtDate(s.created_at, { month: 'long', day: 'numeric' })}</div>
          </div>
          <button class="btn subtle remove-sub" style="color:#a33; border-color:#e3c4bc;">Remove</button>
        </div>`).join('')}</div>`;
      list.querySelectorAll('.remove-sub').forEach((b) => {
        b.addEventListener('click', async () => {
          const row = b.closest('.post-admin-row');
          const email = row.querySelector('.title').textContent;
          if (!confirm(`Remove ${email} from the list?\n\nThey'll stop getting emails about new posts.`)) return;
          await fetch(`/api/subscribers/${row.dataset.id}`, { method: 'DELETE' });
          enterFollowers();
        });
      });
    } catch (err) {
      list.innerHTML = `<div class="notice err">${Camino.esc(err.message)} — tap the button again to retry.</div>`;
    }
  }
  document.querySelectorAll('[data-goto="followers"]').forEach((el) =>
    el.addEventListener('click', enterFollowers));

  // ---------- metrics ----------
  let mfUnits = Camino.getUnits();
  function paintUnitToggle() {
    document.querySelectorAll('#view-numbers .unit-toggle button').forEach((b) => {
      b.classList.toggle('active', b.dataset.u === mfUnits);
    });
  }
  document.querySelectorAll('#view-numbers .unit-toggle button').forEach((b) => {
    b.addEventListener('click', () => {
      const v = parseFloat($('mf-dist').value);
      if (!Number.isNaN(v) && b.dataset.u !== mfUnits) {
        $('mf-dist').value = (b.dataset.u === 'km' ? Camino.miToKm(v) : Camino.kmToMi(v)).toFixed(1);
      }
      mfUnits = b.dataset.u;
      paintUnitToggle();
    });
  });

  async function enterNumbers() {
    paintUnitToggle();
    const { entries } = await (await fetch('/api/metrics')).json();
    const last = entries[entries.length - 1];
    if (!$('mf-date').value) {
      $('mf-date').value = Camino.todayStr();
      $('mf-day').value = autoDayNumber();
      if (last && !$('mf-start').value) $('mf-start').value = last.end_town || '';
    }
    renderRecentMetrics(entries);
  }
  document.querySelectorAll('[data-goto="numbers"]').forEach((el) =>
    el.addEventListener('click', enterNumbers));

  function loadMetricEntry(e) {
    $('mf-date').value = String(e.date).slice(0, 10);
    $('mf-day').value = e.day_number ?? '';
    $('mf-start').value = e.start_town || '';
    $('mf-end').value = e.end_town || '';
    const mi = e.miles != null ? Number(e.miles) : null;
    $('mf-dist').value = mi == null ? '' : (mfUnits === 'km' ? Camino.miToKm(mi) : mi).toFixed(1);
    $('mf-steps').value = e.steps ?? '';
    $('mf-elev').value = e.elevation_ft ?? '';
    $('mf-blisters').value = e.blisters ?? '';
    $('mf-cafes').value = e.cafes ?? '';
    $('mf-favorite').value = e.favorite || '';
    $('mf-accommodation').value = e.accommodation || '';
    $('mf-meal').value = e.meal_location || '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    $('metrics-msg').innerHTML = `<div class="notice ok">Editing ${Camino.fmtDateShort(e.date)} — make your changes and hit Save.</div>`;
  }

  function renderRecentMetrics(entries) {
    const el = $('recent-metrics');
    if (!entries.length) {
      el.innerHTML = `<p style="color:var(--ink-soft);">Nothing yet — today will be your first entry!</p>`;
      return;
    }
    el.innerHTML = [...entries].reverse().map((e) => `
      <div class="post-admin-row" data-id="${e.id}">
        <div style="flex:1; min-width:0;">
          <div class="title">Day ${e.day_number ?? '?'} · ${Camino.fmtDateShort(e.date)}</div>
          <div class="meta">${Camino.esc(e.start_town || '?')} → ${Camino.esc(e.end_town || '?')} · ${e.miles ?? '?'} mi</div>
        </div>
        <button class="btn subtle edit-m">Edit</button>
        <button class="btn subtle del-m" style="color:#a33; border-color:#e3c4bc;">Delete</button>
      </div>`).join('');
    el.querySelectorAll('.edit-m').forEach((b, i) => {
      b.addEventListener('click', () => loadMetricEntry([...entries].reverse()[i]));
    });
    el.querySelectorAll('.del-m').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('Delete this day\u2019s numbers?')) return;
        await fetch(`/api/metrics/${b.closest('.post-admin-row').dataset.id}`, { method: 'DELETE' });
        enterNumbers();
      });
    });
  }

  $('metrics-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    const distVal = parseFloat($('mf-dist').value);
    const miles = Number.isNaN(distVal) ? null
      : +(mfUnits === 'km' ? Camino.kmToMi(distVal) : distVal).toFixed(1);
    const payload = {
      date: $('mf-date').value,
      day_number: $('mf-day').value || null,
      start_town: $('mf-start').value.trim() || null,
      end_town: $('mf-end').value.trim() || null,
      miles,
      steps: $('mf-steps').value || null,
      elevation_ft: $('mf-elev').value || null,
      blisters: $('mf-blisters').value || null,
      cafes: $('mf-cafes').value || null,
      favorite: $('mf-favorite').value.trim() || null,
      accommodation: $('mf-accommodation').value.trim() || null,
      meal_location: $('mf-meal').value.trim() || null,
    };
    try {
      const res = await fetch('/api/metrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Server error');
      $('metrics-msg').innerHTML = `<div class="notice ok">Saved! 🎉 The metrics page is updated for everyone.</div>`;
      e.target.querySelectorAll('input').forEach((i) => { if (i.type !== 'date') i.value = ''; });
      $('mf-date').value = '';
      enterNumbers();
    } catch (err) {
      $('metrics-msg').innerHTML = `<div class="notice err">Couldn’t save (${Camino.esc(err.message)}). Try again in a moment.</div>`;
    }
    btn.disabled = false;
  });

  // ---------- boot ----------
  const me = await (await fetch('/api/me')).json();
  if (me.authed) await enterMenu();
  else show('login');
})();
