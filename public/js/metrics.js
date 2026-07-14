(async function () {
  await Camino.renderHeader('/metrics');
  Camino.renderFooter();

  const { entries } = await (await fetch('/api/metrics')).json();
  let charts = [];

  function render() {
    const units = Camino.getUnits();
    const uLabel = Camino.unitLabel(units);
    document.querySelectorAll('#unit-toggle button').forEach((b) => {
      b.classList.toggle('active', b.dataset.u === units);
    });

    const summaryEl = document.getElementById('summary');
    const chartsEl = document.getElementById('charts');
    const tableEl = document.getElementById('table');

    if (!entries.length) {
      summaryEl.innerHTML = `<div class="card center">
        <h2 style="margin-top:0;">No numbers yet!</h2>
        <p>Once the walking starts, daily miles, steps, and more will show up here.</p></div>`;
      chartsEl.innerHTML = '';
      tableEl.innerHTML = '';
      return;
    }

    // ---- totals ----
    const totMiles = entries.reduce((s, e) => s + Number(e.miles || 0), 0);
    const totSteps = entries.reduce((s, e) => s + Number(e.steps || 0), 0);
    const totElev = entries.reduce((s, e) => s + Number(e.elevation_ft || 0), 0);
    const totCafes = entries.reduce((s, e) => s + Number(e.cafes || 0), 0);
    const daysWalked = entries.length;
    const lastDay = Math.max(...entries.map((e) => e.day_number || 0));

    summaryEl.innerHTML = `<div class="summary-hero">
      <p class="headline">Day ${lastDay || daysWalked} of the journey · ${Camino.dist(totMiles, units)} ${uLabel} walked · ${Camino.fmtNum(totSteps)} steps</p>
      <div class="big-stats">
        <div class="big-stat"><span class="n">${daysWalked}</span><span class="l">days walked</span></div>
        <div class="big-stat"><span class="n">${Camino.dist(totMiles, units)}</span><span class="l">${uLabel} total</span></div>
        <div class="big-stat"><span class="n">${Camino.fmtNum(totSteps)}</span><span class="l">steps</span></div>
        ${totElev ? `<div class="big-stat"><span class="n">${Camino.fmtNum(totElev)}</span><span class="l">ft climbed</span></div>` : ''}
        ${totCafes ? `<div class="big-stat"><span class="n">${Camino.fmtNum(totCafes)}</span><span class="l">cafés con leche ☕</span></div>` : ''}
      </div>
    </div>`;

    // ---- table ----
    let cum = 0;
    const rows = entries.map((e) => {
      cum += Number(e.miles || 0);
      return `<tr>
        <td>${Camino.fmtDateShort(e.date)}</td>
        <td>${e.day_number ?? ''}</td>
        <td>${Camino.esc(e.start_town || '')} → ${Camino.esc(e.end_town || '')}</td>
        <td>${e.miles != null ? Camino.dist(Number(e.miles), units, 1) : ''}</td>
        <td>${Camino.dist(cum, units, 0)}</td>
        <td>${e.steps ? Camino.fmtNum(e.steps) : ''}</td>
        <td>${e.elevation_ft ? Camino.fmtNum(e.elevation_ft) + ' ft' : ''}</td>
        <td>${e.blisters ?? ''}</td>
        <td>${e.cafes ?? ''}</td>
        <td style="white-space:normal; min-width:180px;">${Camino.esc(e.favorite || '')}</td>
        <td>${Camino.esc(e.accommodation || '')}</td>
        <td>${Camino.esc(e.meal_location || '')}</td>
      </tr>`;
    }).join('');

    tableEl.innerHTML = `<div class="table-wrap"><table class="metrics">
      <thead><tr>
        <th>Date</th><th>Day</th><th>From → To</th><th>${uLabel}</th><th>Total ${uLabel}</th>
        <th>Steps</th><th>Climb</th><th>Blisters 🩹</th><th>Cafés ☕</th><th>Favorite moment</th>
        <th>Slept at 🛏️</th><th>Ate at 🍽️</th>
      </tr></thead>
      <tbody>${rows}
        <tr class="total-row">
          <td colspan="3">Totals</td>
          <td>${Camino.dist(totMiles, units)}</td><td>${Camino.dist(totMiles, units)}</td>
          <td>${Camino.fmtNum(totSteps)}</td>
          <td>${totElev ? Camino.fmtNum(totElev) + ' ft' : ''}</td>
          <td>${entries.reduce((s, e) => s + Number(e.blisters || 0), 0)}</td>
          <td>${totCafes}</td><td></td><td></td><td></td>
        </tr>
      </tbody>
    </table></div>`;

    // ---- charts ----
    charts.forEach((c) => c.destroy());
    charts = [];
    chartsEl.innerHTML = `
      <div class="chart-card"><h3>${uLabel} per day</h3><canvas id="chart-daily" height="130"></canvas></div>
      <div class="chart-card"><h3>Total ${uLabel} over time</h3><canvas id="chart-cum" height="130"></canvas></div>`;

    const labels = entries.map((e) => e.day_number ? `Day ${e.day_number}` : Camino.fmtDateShort(e.date));
    const conv = (mi) => units === 'km' ? Camino.miToKm(mi) : mi;
    const daily = entries.map((e) => +conv(Number(e.miles || 0)).toFixed(1));
    let run = 0;
    const cumulative = entries.map((e) => +((run += conv(Number(e.miles || 0)))).toFixed(1));

    Chart.defaults.font.family = "'Nunito Sans', sans-serif";
    Chart.defaults.font.size = 13;
    Chart.defaults.color = '#6b6357';

    charts.push(new Chart(document.getElementById('chart-daily'), {
      type: 'bar',
      data: { labels, datasets: [{ data: daily, backgroundColor: '#d9a441', borderRadius: 6 }] },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
    }));
    charts.push(new Chart(document.getElementById('chart-cum'), {
      type: 'line',
      data: { labels, datasets: [{ data: cumulative, borderColor: '#b4532a', backgroundColor: 'rgba(180,83,42,0.12)', fill: true, tension: 0.25, pointRadius: 3 }] },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
    }));
  }

  document.querySelectorAll('#unit-toggle button').forEach((b) => {
    b.addEventListener('click', () => { Camino.setUnits(b.dataset.u); render(); });
  });

  render();
})();
