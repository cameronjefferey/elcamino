(async function () {
  await Camino.renderHeader('/map');
  Camino.renderFooter();
  const cfg = await Camino.config();
  const units = Camino.getUnits();

  document.getElementById('route-desc').textContent =
    `${cfg.routeName} · ${cfg.routeDescription}`;

  const loc = await (await fetch('/api/location')).json();
  const idx = Math.min(Math.max(loc.townIndex ?? 0, 0), cfg.towns.length - 1);
  const towns = cfg.towns;
  const current = towns[idx];

  // ---- progress bar ----
  const totalKm = towns[towns.length - 1].km;
  const pct = Math.round((current.km / totalKm) * 100);
  const doneMi = Camino.kmToMi(current.km);
  const totalMi = Camino.kmToMi(totalKm);
  const card = document.getElementById('progress-card');
  card.style.display = '';
  document.getElementById('progress-label').textContent =
    `📍 Now in ${current.name}`;
  document.getElementById('progress-bar').style.width = `${pct}%`;
  document.getElementById('progress-sub').textContent =
    units === 'km'
      ? `${Camino.fmtNum(current.km)} of ${Camino.fmtNum(totalKm)} km along the route (${pct}%)`
      : `${Camino.dist(doneMi, 'mi')} of ${Camino.dist(totalMi, 'mi')} miles along the route (${pct}%)`;

  // ---- map ----
  const map = L.map('map', { scrollWheelZoom: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const latlngs = towns.map((t) => [t.lat, t.lng]);
  // Full route, faint
  L.polyline(latlngs, { color: '#b8ad97', weight: 4, dashArray: '6 8' }).addTo(map);
  // Walked portion, bold
  L.polyline(latlngs.slice(0, idx + 1), { color: '#6b7f59', weight: 5 }).addTo(map);

  towns.forEach((t, i) => {
    if (i === idx) return;
    const passed = i < idx;
    L.circleMarker([t.lat, t.lng], {
      radius: passed ? 6 : 5,
      color: passed ? '#55663f' : '#a89c85',
      fillColor: passed ? '#6b7f59' : '#d9d0bd',
      fillOpacity: 1,
      weight: 2,
    }).addTo(map).bindPopup(
      `<b>${Camino.esc(t.name)}</b><br>${Camino.fmtNum(t.km)} km from the start` +
      (passed ? '<br>✅ Already walked through!' : '')
    );
  });

  const hereIcon = L.divIcon({
    className: 'marker-here',
    iconSize: [22, 22],
  });
  L.marker([current.lat, current.lng], { icon: hereIcon, zIndexOffset: 1000 })
    .addTo(map)
    .bindPopup(`<b>📍 They are here: ${Camino.esc(current.name)}</b><br>${Camino.fmtNum(current.km)} km walked so far`)
    .openPopup();

  map.fitBounds(L.latLngBounds(latlngs).pad(0.08));

  // ---- town checklist ----
  document.getElementById('town-list').innerHTML = towns.map((t, i) => `
    <li class="${i < idx ? 'passed' : ''} ${i === idx ? 'current' : ''}">
      <span class="dot"></span>
      <span>${i === idx ? '📍 ' : ''}${Camino.esc(t.name)}</span>
      <span class="km">${units === 'km' ? `${Camino.fmtNum(t.km)} km` : `${Camino.dist(Camino.kmToMi(t.km), 'mi')} mi`}</span>
    </li>`).join('');
})();
