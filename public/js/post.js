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
})();
