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
})();
