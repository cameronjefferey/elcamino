(async function () {
  await Camino.renderHeader('/map');
  Camino.renderFooter();
  const cfg = await Camino.config();
  const units = Camino.getUnits();

  document.getElementById('route-desc').textContent =
    `${cfg.routeName} · ${cfg.routeDescription}`;

  const loc = await (await fetch('/api/location')).json();
  const towns = cfg.towns;

  // Location can be a listed stage town (townIndex) or a geocoded village
  // (name + lat/lng + projected km). Normalize both into one shape, and fall
  // back gracefully for older saved locations that only had a townIndex.
  let current;
  if (loc.lat != null && loc.lng != null) {
    current = { name: loc.name, lat: loc.lat, lng: loc.lng, km: loc.km ?? 0, townIndex: loc.townIndex ?? null };
  } else {
    const i = Math.min(Math.max(loc.townIndex ?? 0, 0), towns.length - 1);
    current = { name: towns[i].name, lat: towns[i].lat, lng: towns[i].lng, km: towns[i].km, townIndex: i };
  }
  const currentKm = current.km;
  const isOffRoute = current.townIndex == null;

  // ---- progress bar ----
  const totalKm = towns[towns.length - 1].km;
  const pct = Math.round((currentKm / totalKm) * 100);
  const doneMi = Camino.kmToMi(currentKm);
  const totalMi = Camino.kmToMi(totalKm);
  const card = document.getElementById('progress-card');
  card.style.display = '';
  document.getElementById('progress-label').textContent =
    `📍 Now in ${current.name}`;
  document.getElementById('progress-bar').style.width = `${pct}%`;
  document.getElementById('progress-sub').textContent =
    units === 'km'
      ? `${Camino.fmtNum(currentKm)} of ${Camino.fmtNum(totalKm)} km along the route (${pct}%)`
      : `${Camino.dist(doneMi, 'mi')} of ${Camino.dist(totalMi, 'mi')} miles along the route (${pct}%)`;

  Camino.renderWeather(document.getElementById('weather-card'));

  // ---- map ----
  const map = L.map('map', { scrollWheelZoom: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const latlngs = towns.map((t) => [t.lat, t.lng]);
  // Full route, faint
  L.polyline(latlngs, { color: '#b8ad97', weight: 4, dashArray: '6 8' }).addTo(map);
  // Walked portion, bold — every town already behind them, then their exact spot.
  const walked = towns.filter((t) => t.km <= currentKm).map((t) => [t.lat, t.lng]);
  walked.push([current.lat, current.lng]);
  L.polyline(walked, { color: '#6b7f59', weight: 5 }).addTo(map);

  towns.forEach((t, i) => {
    if (i === current.townIndex) return; // the "here" marker covers this town
    const passed = t.km <= currentKm;
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

  const hereIcon = L.divIcon({ className: 'marker-here', iconSize: [22, 22] });
  const herePopup = isOffRoute
    ? `<b>📍 They are here: ${Camino.esc(current.name)}</b><br>about ${Camino.fmtNum(currentKm)} km along the route`
    : `<b>📍 They are here: ${Camino.esc(current.name)}</b><br>${Camino.fmtNum(currentKm)} km walked so far`;
  L.marker([current.lat, current.lng], { icon: hereIcon, zIndexOffset: 1000 })
    .addTo(map)
    .bindPopup(herePopup)
    .openPopup();

  map.fitBounds(L.latLngBounds(latlngs.concat([[current.lat, current.lng]])).pad(0.08));

  // ---- town checklist ----
  const listItems = towns.map((t, i) => {
    const isCurrent = i === current.townIndex;
    const passed = !isCurrent && t.km <= currentKm;
    return `<li class="${passed ? 'passed' : ''} ${isCurrent ? 'current' : ''}">
      <span class="dot"></span>
      <span>${isCurrent ? '📍 ' : ''}${Camino.esc(t.name)}</span>
      <span class="km">${units === 'km' ? `${Camino.fmtNum(t.km)} km` : `${Camino.dist(Camino.kmToMi(t.km), 'mi')} mi`}</span>
    </li>`;
  });
  // When they're between towns, show their exact spot in the list at the right point.
  if (isOffRoute) {
    const insertAt = towns.filter((t) => t.km <= currentKm).length;
    listItems.splice(insertAt, 0, `<li class="current">
      <span class="dot"></span>
      <span>📍 ${Camino.esc(current.name)} <em style="font-weight:400; color:var(--ink-soft);">(you are here)</em></span>
      <span class="km">~${units === 'km' ? `${Camino.fmtNum(currentKm)} km` : `${Camino.dist(Camino.kmToMi(currentKm), 'mi')} mi`}</span>
    </li>`);
  }
  document.getElementById('town-list').innerHTML = listItems.join('');
})();
