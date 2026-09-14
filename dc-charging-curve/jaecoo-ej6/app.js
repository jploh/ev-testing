// Sample data lives in data.csv beside this file (columns: t,a,v,soc,kw where
// t is seconds since midnight). It is fetched at load, so this page must be
// served over http(s); opening the file directly from disk will not work.
const DATA_URL = './data.csv';

let DATA, STEPS, BY_SOC, fullExtent;

// Array order sets the panel order in the session trace, the legend order and
// the tooltip row order.
const SERIES = [
  { key: 'kw',  i: 4, name: 'Power',   unit: 'kW', color: 'var(--series-kw)',  fmt: d => d.toFixed(1) },
  { key: 'soc', i: 3, name: 'SOC',     unit: '%',  color: 'var(--series-soc)', fmt: d => d.toFixed(1) },
  { key: 'a',   i: 1, name: 'Current', unit: 'A',  color: 'var(--series-a)',   fmt: d => d.toFixed(1) },
  { key: 'v',   i: 2, name: 'Voltage', unit: 'V',  color: 'var(--series-v)',   fmt: d => d.toFixed(1) },
];

// Manufacturer-claimed peak DC charging power for this car (kW).
// Power is also expressed as a share of this on the Power panel's right-hand axis.
const CLAIMED_MAX_KW = 80;

// Manufacturer-specified usable battery capacity (kWh) and chemistry.
// C-rate is charging power divided by this capacity.
const PACK_KWH = 69.77;
const PACK_CHEMISTRY = 'LFP';

const DAY = new Date(2026, 11, 29);
const toDate = s => new Date(DAY.getFullYear(), DAY.getMonth(), DAY.getDate(), 0, 0, 0, 0 + s * 1000);
function parseRows(text) {
  const lines = text.trim().split('\n');
  const head = lines[0].split(',').map(s => s.trim());
  const ix = k => head.indexOf(k);
  const [it, ia, iv, isoc, ikw] = [ix('t'), ix('a'), ix('v'), ix('soc'), ix('kw')];
  if ([it, ia, iv, isoc, ikw].some(i => i < 0)) throw new Error('data.csv is missing a column');
  return lines.slice(1).map(l => {
    const c = l.split(',');
    return { t: toDate(+c[it]), a: +c[ia], v: +c[iv], soc: +c[isoc], kw: +c[ikw] };
  });
}

const fmtTime = d3.timeFormat('%H:%M');
const fmtTimeS = d3.timeFormat('%H:%M:%S');

/* ---------------- stat tiles ---------------- */
function buildTiles() {
  const kws = DATA.map(d => d.kw);
  const peak = d3.max(kws), avg = d3.mean(kws);
  const dur = (DATA[DATA.length - 1].t - DATA[0].t) / 60000;
  let e = 0;
  for (let i = 1; i < DATA.length; i++) e += (DATA[i].kw + DATA[i - 1].kw) / 2 * ((DATA[i].t - DATA[i - 1].t) / 3600000);
  const at = soc => DATA.find(d => d.soc >= soc);
  const t20 = at(20), t80 = at(80);
  const rate = t20 && t80 ? (t80.t - t20.t) / 60000 : null;
  const items = [
    { label: 'Peak power', value: peak.toFixed(1), unit: 'kW',
      sub: `${(peak / CLAIMED_MAX_KW * 100).toFixed(0)}% of ${CLAIMED_MAX_KW} kW claimed` },
    { label: 'Peak C-rate', value: (peak / PACK_KWH).toFixed(2), unit: 'C',
      sub: `${PACK_KWH} kWh ${PACK_CHEMISTRY}, average ${(avg / PACK_KWH).toFixed(2)}C` },
    { label: 'Duration', value: dur.toFixed(1), unit: 'min' },
    { label: 'SOC 20 → 80%', value: rate ? rate.toFixed(1) : 'n/a', unit: 'min' },
    { label: 'Energy', value: 46, unit: 'kWh' },
  ];
  d3.select('#tiles').selectAll('div.tile').data(items).join('div').attr('class', 'tile')
    .html(d => `<div class="label">${d.label}</div><div class="value">${d.value}<small>${d.unit}</small></div>`
      + (d.sub ? `<div class="sub2">${d.sub}</div>` : ''));
}

/* ---------------- power step detection ---------------- */
// The pack steps between discrete current limits rather than tapering smoothly,
// so "significant change" means the smoothed level moves by more than STEP_KW.
const STEP_KW = 4;      // minimum change worth annotating
const SETTLE = 25;      // seconds allowed for the new level to settle
const SMOOTH = 9;       // +/- seconds in the median window

function detectSteps() {
  const n = DATA.length;
  const med = [];
  for (let i = 0; i < n; i++) {
    const w = DATA.slice(Math.max(0, i - SMOOTH), Math.min(n, i + SMOOTH + 1)).map(d => d.kw).sort(d3.ascending);
    med.push(d3.quantileSorted(w, 0.5));
  }
  const out = [];
  // first mark: where the ramp settles onto its opening plateau
  const opening = med[Math.min(30, n - 1)];
  let onset = DATA.findIndex(d => d.kw >= opening * 0.98);
  if (onset > 0) out.push({ i: onset, from: null, to: opening });

  let level = opening, i = 31;
  while (i < n - 2) {
    if (Math.abs(med[i] - level) >= STEP_KW) {
      const j = Math.min(n - 1, i + SETTLE);
      out.push({ i, from: level, to: med[j] });
      level = med[j];
      i = j + 1;
    } else i++;
  }
  // For each step, record the settled level of EVERY measure, so the same
  // moments can be annotated in the current, voltage and SOC panels too.
  const levelAt = (key, a, b) => {
    const w = DATA.slice(Math.max(0, a), Math.min(n, b)).map(d => d[key]).sort(d3.ascending);
    return w.length ? d3.quantileSorted(w, 0.5) : null;
  };
  return out.map(s => {
    const lvl = {};
    ['kw', 'a', 'v', 'soc'].forEach(key => {
      // the settled level after the step; near the end of the log the window is
      // short, so fall back to whatever samples remain rather than dropping the mark
      const post = levelAt(key, s.i + SETTLE, s.i + SETTLE * 2)
        ?? levelAt(key, s.i + 1, n)
        ?? DATA[n - 1][key];
      lvl[key] = {
        pre: s.from === null ? null : levelAt(key, s.i - SETTLE, s.i),
        post,
        at: DATA[s.i][key],
      };
    });
    return { ...s, d: DATA[s.i], lvl };
  });
}

/* ---------------- state ---------------- */
const state = {
  visible: new Set(SERIES.map(s => s.key)),
  domain: null, // null = full extent
};


/* ---------------- legend ---------------- */
d3.select('#legend').selectAll('button').data(SERIES).join('button')
  .attr('class', 'chip').attr('type', 'button')
  .attr('aria-pressed', d => state.visible.has(d.key))
  .html(d => `<span class="sw" style="background:${d.color}"></span>${d.name} <span style="color:var(--muted-foreground)">(${d.key === 'kw' ? 'kW · % of claim' : d.unit})</span>`)
  .on('click', function (event, d) {
    if (state.visible.has(d.key)) {
      if (state.visible.size === 1) return;
      state.visible.delete(d.key);
    } else state.visible.add(d.key);
    d3.select(this).attr('aria-pressed', state.visible.has(d.key));
    render();
  });

/* ---------------- theme + table ---------------- */
d3.select('#reset').on('click', () => { state.domain = null; render(); });

const root = document.documentElement;
function applyTheme(t) {
  root.setAttribute('data-theme', t);
  document.getElementById('ico-sun').hidden = t === 'dark';
  document.getElementById('ico-moon').hidden = t !== 'dark';
  try { localStorage.setItem('ej6-theme', t); } catch (e) {}
}
(function initTheme() {
  let t = null;
  try { t = localStorage.getItem('ej6-theme'); } catch (e) {}
  if (!t) t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(t);
})();
document.getElementById('theme').addEventListener('click', () =>
  applyTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));

d3.select('#toggletable').on('click', function () {
  const showing = d3.select('#tablewrap').property('hidden');
  d3.select('#tablewrap').property('hidden', !showing);
  d3.select(this).attr('aria-pressed', showing);
  if (showing) buildTable();
});

function buildTable() {
  const wrap = d3.select('#tablewrap');
  wrap.selectAll('*').remove();
  const step = 30; // one row per 30 s
  const rows = DATA.filter((d, i) => i % step === 0 || i === DATA.length - 1);
  const table = wrap.append('table');
  table.append('caption').text('Sampled every 30 seconds. Full 1 Hz series is plotted above.');
  table.append('thead').append('tr').selectAll('th')
    .data(['Time', 'Power (kW)', '% of claim', 'Current (A)', 'Voltage (V)', 'SOC (%)']).join('th').text(d => d);
  const tb = table.append('tbody');
  tb.selectAll('tr').data(rows).join('tr').selectAll('td')
    .data(d => [fmtTimeS(d.t), d.kw.toFixed(1), (d.kw / CLAIMED_MAX_KW * 100).toFixed(0) + '%', d.a.toFixed(1), d.v.toFixed(1), d.soc.toFixed(2)])
    .join('td').text(d => d);
}

/* ---------------- load animation ---------------- */
// Only the first paint animates. Re-renders (resize, theme change, zoom,
// legend toggles) draw instantly, and the whole thing is skipped for anyone
// who has asked their system to reduce motion.
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let firstPaint = true;
const animating = () => firstPaint && !REDUCED_MOTION;

const DRAW_MS = 850;   // time for one line to draw itself
const STAGGER = 110;   // offset between stacked panels

// Reveals a line left to right by retracting its own dash gap.
function drawOn(path, delay) {
  const node = path.node();
  const len = node.getTotalLength();
  if (!len || !isFinite(len)) return;
  path.attr('stroke-dasharray', `${len} ${len}`).attr('stroke-dashoffset', len)
    .transition().delay(delay).duration(DRAW_MS).ease(d3.easeCubicOut)
    .attr('stroke-dashoffset', 0)
    .on('end', function () {
      d3.select(this).attr('stroke-dasharray', null).attr('stroke-dashoffset', null);
    });
}

// Annotations settle in once their line has finished drawing.
function fadeIn(sel, delay) {
  sel.attr('opacity', 0).transition().delay(delay).duration(260).attr('opacity', 1);
}

/* ---------------- step annotations ---------------- */
// Draws a marker per detected step into one panel. `pos` maps a step to its x,
// so the same marks work against time and against SOC.
function drawSteps(gpOuter, steps, pos, y, innerW, panelH, key = 'kw', unit = 'kW', color = 'var(--series-kw)') {
  const gp = gpOuter.append('g').attr('class', 'notes');
  const placed = [];
  const dp = key === 'soc' ? 1 : 0;
  // Power and current step to a new shelf, so the settled level is the useful
  // number. Voltage and SOC just drift, so those panels mark the value at the
  // moment of the step and carry no delta.
  const steps_ = key === 'kw' || key === 'a';
  steps.forEach(s => {
    const px = pos(s);
    if (px < -1 || px > innerW + 1) return;
    const lv = s.lvl[key];
    const value = steps_ ? lv.post : lv.at;
    if (value === null || value === undefined) return;
    const delta = steps_ && lv.pre !== null ? lv.post - lv.pre : null;
    const showDelta = delta !== null && innerW >= 520 && Math.abs(delta) >= 1;
    const text = `${value.toFixed(dp)} ${unit}` +
      (showDelta ? ` ${delta > 0 ? '+' : ''}${delta.toFixed(0)}` : '');
    const w = text.length * 6.4 + 6;
    const flip = px + w > innerW;            // no room to the right, label leftwards
    const x0 = flip ? px - w : px, x1 = flip ? px : px + w;
    let ty = 11;
    // stack downwards until this label's span is clear of the ones already placed
    while (placed.some(q => q.y === ty && x0 < q.x1 + 6 && x1 + 6 > q.x0) && ty < panelH - 20) ty += 12;
    placed.push({ x0, x1, y: ty });

    gp.append('line').attr('class', 'note-line')
      .attr('x1', px).attr('x2', px).attr('y1', ty + 3).attr('y2', y(value));
    gp.append('circle').attr('class', 'note-dot').style('fill', color)
      .attr('cx', px).attr('cy', y(value)).attr('r', 3);
    const label = gp.append('text').attr('class', 'note-text')
      .attr('x', px + (flip ? -5 : 5)).attr('y', ty)
      .attr('text-anchor', flip ? 'end' : 'start')
      .text(`${value.toFixed(dp)} ${unit}`);
    if (showDelta) label.append('tspan').attr('class', 'delta').attr('dx', 4)
      .text(`${delta > 0 ? '+' : ''}${delta.toFixed(0)}`);
  });
  return gp;
}

/* ---------------- chart ---------------- */
const svg = d3.select('#chart');
const tip = d3.select('#tip');
const M = { top: 18, right: 18, bottom: 30, left: 56 };
const FACET_H = 132, GAP = 20;

function render() {
  const active = SERIES.filter(s => state.visible.has(s.key));
  const node = svg.node();
  const width = Math.max(320, node.getBoundingClientRect().width || 800);
  const panels = active.length;
  // room on the right for the Power panel's "% of claimed max" axis
  const rightPad = state.visible.has('kw') ? 56 : M.right;
  const innerW = width - M.left - rightPad;
  const innerH = panels * FACET_H + (panels - 1) * GAP;
  const height = innerH + M.top + M.bottom;

  svg.attr('viewBox', `0 0 ${width} ${height}`).attr('height', height);
  svg.selectAll('*').remove();
  const g = svg.append('g').attr('transform', `translate(${M.left},${M.top})`);

  const x = d3.scaleTime().domain(state.domain || fullExtent).range([0, innerW]);
  const view = DATA.filter(d => d.t >= x.domain()[0] && d.t <= x.domain()[1]);
  const plot = view.length > 1 ? view : DATA;

  // y scales: nice-rounded over the visible window, per series
  const yFor = {};
  active.forEach(s => {
    const [lo, hi] = d3.extent(plot, d => d[s.key]);
    const pad = (hi - lo) * 0.12 || 1;
    yFor[s.key] = d3.scaleLinear().domain([Math.max(0, lo - pad), hi + pad]).nice();
  });

  const panelTop = i => i * (FACET_H + GAP);

  active.forEach((s, i) => {
    const top = panelTop(i);
    const p = g.append('g').attr('transform', `translate(0,${top})`);
    const y = yFor[s.key].range([FACET_H, 0]);
    {
      // gridlines + axis
      const ticks = y.ticks(4);
      p.selectAll('line.gridline').data(ticks).join('line').attr('class', 'gridline')
        .attr('x1', 0).attr('x2', innerW).attr('y1', y).attr('y2', y);
      p.append('g').attr('class', 'axis').call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(8));
      // direct label (relief rule: identity never by color alone)
      p.append('rect').attr('x', 0).attr('y', -15).attr('width', 3).attr('height', 11)
        .attr('rx', 1.5).style('fill', s.color);
      const flabel = p.append('text').attr('class', 'facet-label').attr('x', 10).attr('y', -6).text(s.name);
      flabel.append('tspan').attr('class', 'facet-unit').attr('dx', 6).text(s.unit);
      if (s.key === 'kw') flabel.append('tspan').attr('class', 'facet-unit').attr('dx', 6)
        .text('· right axis: % of claimed max');

      // Second unit on the SAME measure (not a second measure): power as a share of
      // the manufacturer's claimed peak. Ticks land on round percentages.
      if (s.key === 'kw') {
        const [d0, d1] = y.domain();
        const pct = v => v / CLAIMED_MAX_KW * 100;
        const step = d3.tickStep(pct(d0), pct(d1), 4) || 25;
        const pctTicks = d3.range(Math.ceil(pct(d0) / step) * step, pct(d1) + 1e-6, step);
        p.append('g').attr('class', 'axis').attr('transform', `translate(${innerW},0)`)
          .call(d3.axisRight(y).tickValues(pctTicks.map(v => v * CLAIMED_MAX_KW / 100))
            .tickSize(0).tickPadding(8).tickFormat(v => Math.round(pct(v)) + '%'));
        // 100%-of-claim reference line
        if (CLAIMED_MAX_KW >= d0 && CLAIMED_MAX_KW <= d1) {
          p.append('line').attr('class', 'ref-line')
            .attr('x1', 0).attr('x2', innerW).attr('y1', y(CLAIMED_MAX_KW)).attr('y2', y(CLAIMED_MAX_KW));
          p.append('text').attr('class', 'ref-label').attr('x', 4).attr('y', y(CLAIMED_MAX_KW) - 5)
            .text(`${CLAIMED_MAX_KW} kW claimed max`);
        }
      }
    }
    const line = d3.line().x(d => x(d.t)).y(d => y(d[s.key]));
    const path = p.append('path').datum(plot).attr('class', 'series-line')
      .style('stroke', s.color).attr('d', line);
    const notes = drawSteps(p, STEPS, st => x(st.d.t), y, innerW, FACET_H, s.key, s.unit, s.color);
    if (animating()) {
      drawOn(path, i * STAGGER);
      fadeIn(notes, i * STAGGER + DRAW_MS - 120);
    }
    s.__y = y; s.__top = top;
  });

  // shared x axis
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(Math.max(3, Math.floor(innerW / 90))).tickSizeOuter(0).tickFormat(fmtTime));

  /* ----- interaction layer ----- */
  const focus = g.append('g').attr('pointer-events', 'none');
  const cross = focus.append('line').attr('class', 'crosshair').attr('y1', 0).attr('y2', innerH).attr('opacity', 0);
  const dots = active.map(s => focus.append('circle').attr('class', 'focus-dot').attr('r', 4).style('fill', s.color).attr('opacity', 0));
  const selRect = g.append('rect').attr('class', 'sel-rect').attr('y', 0).attr('height', innerH).attr('width', 0).attr('opacity', 0);

  const bisect = d3.bisector(d => d.t).center;
  let dragStart = null;

  const overlay = g.append('rect')
    .attr('width', innerW).attr('height', innerH)
    .attr('fill', 'transparent').style('cursor', 'crosshair');

  function nearest(event) {
    const [mx] = d3.pointer(event, overlay.node());
    const t = x.invert(Math.max(0, Math.min(innerW, mx)));
    return plot[bisect(plot, t)];
  }

  overlay
    .on('pointermove', function (event) {
      const d = nearest(event);
      if (!d) return;
      const px = x(d.t);
      cross.attr('x1', px).attr('x2', px).attr('opacity', 1);
      active.forEach((s, i) => dots[i].attr('cx', px).attr('cy', s.__top + s.__y(d[s.key])).attr('opacity', 1));
      if (dragStart !== null) {
        const [mx] = d3.pointer(event, overlay.node());
        const a = Math.min(dragStart, mx), b = Math.max(dragStart, mx);
        selRect.attr('x', a).attr('width', Math.max(0, b - a)).attr('opacity', 1);
      }
      tip.style('opacity', 1)
        .style('left', Math.min(window.innerWidth - 200, event.clientX + 16) + 'px')
        .style('top', Math.max(8, event.clientY - 20) + 'px')
        .html(`<div class="t-time">${fmtTimeS(d.t)}</div>` + active.map(s => {
          const row = `<div class="t-row"><span class="t-sw" style="background:${s.color}"></span><span class="t-name">${s.name}</span><span class="t-val">${s.fmt(d[s.key])} ${s.unit}</span></div>`;
          return s.key === 'kw'
            ? row + `<div class="t-row"><span class="t-sw" style="background:transparent"></span><span class="t-name">of claim</span><span class="t-val">${(d.kw / CLAIMED_MAX_KW * 100).toFixed(0)} %</span></div>`
            : row;
        }).join(''));
    })
    .on('pointerleave', function () {
      cross.attr('opacity', 0); dots.forEach(c => c.attr('opacity', 0)); tip.style('opacity', 0);
    })
    .on('pointerdown', function (event) {
      dragStart = d3.pointer(event, overlay.node())[0];
      this.setPointerCapture(event.pointerId);
    })
    .on('pointerup', function (event) {
      if (dragStart === null) return;
      const end = d3.pointer(event, overlay.node())[0];
      selRect.attr('opacity', 0).attr('width', 0);
      if (Math.abs(end - dragStart) > 8) {
        const a = x.invert(Math.min(dragStart, end)), b = x.invert(Math.max(dragStart, end));
        if (DATA.filter(d => d.t >= a && d.t <= b).length > 2) state.domain = [a, b];
        dragStart = null;
        render();
        return;
      }
      dragStart = null;
    })
    .on('dblclick', () => { state.domain = null; render(); });
}

/* ---------------- power vs. SOC ---------------- */
const socSvg = d3.select('#soc-chart');
const M2 = { top: 22, right: 56, bottom: 42, left: 56 };
const SOC_H = 260;
// BY_SOC: the same rows sorted by SOC. SOC rises monotonically through the
// session, but sorting defensively keeps the path from doubling back on jitter.

function renderSoc() {
  const width = Math.max(320, socSvg.node().getBoundingClientRect().width || 800);
  const innerW = width - M2.left - M2.right;
  const innerH = SOC_H;
  const height = innerH + M2.top + M2.bottom;

  socSvg.attr('viewBox', `0 0 ${width} ${height}`).attr('height', height);
  socSvg.selectAll('*').remove();
  const g = socSvg.append('g').attr('transform', `translate(${M2.left},${M2.top})`);

  const x = d3.scaleLinear().domain(d3.extent(BY_SOC, d => d.soc)).nice().range([0, innerW]);
  const kwMax = d3.max(BY_SOC, d => d.kw);
  const y = d3.scaleLinear().domain([0, Math.max(kwMax, CLAIMED_MAX_KW) * 1.12]).nice().range([innerH, 0]);

  g.selectAll('line.gridline').data(y.ticks(5)).join('line').attr('class', 'gridline')
    .attr('x1', 0).attr('x2', innerW).attr('y1', y).attr('y2', y);

  g.append('g').attr('class', 'axis').call(d3.axisLeft(y).ticks(5).tickSize(0).tickPadding(8));
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(Math.max(4, Math.floor(innerW / 80))).tickSizeOuter(0).tickFormat(d => d + '%'));

  // same second unit as the time chart: power as a share of the claimed peak
  const pct = v => v / CLAIMED_MAX_KW * 100;
  const step = d3.tickStep(0, pct(y.domain()[1]), 5) || 25;
  const pctTicks = d3.range(0, pct(y.domain()[1]) + 1e-6, step);
  g.append('g').attr('class', 'axis').attr('transform', `translate(${innerW},0)`)
    .call(d3.axisRight(y).tickValues(pctTicks.map(v => v * CLAIMED_MAX_KW / 100))
      .tickSize(0).tickPadding(8).tickFormat(v => Math.round(pct(v)) + '%'));

  g.append('rect').attr('x', 0).attr('y', -17).attr('width', 3).attr('height', 11)
    .attr('rx', 1.5).style('fill', 'var(--series-kw)');
  g.append('text').attr('class', 'facet-label').attr('x', 10).attr('y', -8).text('Power')
    .append('tspan').attr('class', 'facet-unit').attr('dx', 6).text('kW · right axis: % of claimed max');
  g.append('text').attr('class', 'facet-unit').attr('x', innerW / 2).attr('y', innerH + 36)
    .attr('text-anchor', 'middle').text('State of charge (%)');

  if (CLAIMED_MAX_KW <= y.domain()[1]) {
    g.append('line').attr('class', 'ref-line')
      .attr('x1', 0).attr('x2', innerW).attr('y1', y(CLAIMED_MAX_KW)).attr('y2', y(CLAIMED_MAX_KW));
    g.append('text').attr('class', 'ref-label').attr('x', 4).attr('y', y(CLAIMED_MAX_KW) - 5)
      .text(`${CLAIMED_MAX_KW} kW claimed max`);
  }

  const socPath = g.append('path').datum(BY_SOC).attr('class', 'series-line')
    .style('stroke', 'var(--series-kw)')
    .attr('d', d3.line().x(d => x(d.soc)).y(d => y(d.kw)));

  const socNotes = drawSteps(g, STEPS, st => x(st.d.soc), y, innerW, innerH, 'kw', 'kW', 'var(--series-kw)');
  if (animating()) {
    drawOn(socPath, 0);
    fadeIn(socNotes, DRAW_MS - 120);
  }

  const focus = g.append('g').attr('pointer-events', 'none');
  const cross = focus.append('line').attr('class', 'crosshair').attr('y1', 0).attr('y2', innerH).attr('opacity', 0);
  const dot = focus.append('circle').attr('class', 'focus-dot').attr('r', 4)
    .style('fill', 'var(--series-kw)').attr('opacity', 0);

  const bisect = d3.bisector(d => d.soc).center;
  g.append('rect').attr('width', innerW).attr('height', innerH).attr('fill', 'transparent')
    .style('cursor', 'crosshair')
    .on('pointermove', function (event) {
      const [mx] = d3.pointer(event, this);
      const d = BY_SOC[bisect(BY_SOC, x.invert(Math.max(0, Math.min(innerW, mx))))];
      if (!d) return;
      cross.attr('x1', x(d.soc)).attr('x2', x(d.soc)).attr('opacity', 1);
      dot.attr('cx', x(d.soc)).attr('cy', y(d.kw)).attr('opacity', 1);
      tip.style('opacity', 1)
        .style('left', Math.min(window.innerWidth - 200, event.clientX + 16) + 'px')
        .style('top', Math.max(8, event.clientY - 20) + 'px')
        .html(`<div class="t-time">${d.soc.toFixed(1)}% SOC</div>` +
          `<div class="t-row"><span class="t-sw" style="background:var(--series-kw)"></span><span class="t-name">Power</span><span class="t-val">${d.kw.toFixed(1)} kW</span></div>` +
          `<div class="t-row"><span class="t-sw" style="background:transparent"></span><span class="t-name">of claim</span><span class="t-val">${pct(d.kw).toFixed(0)} %</span></div>` +
          `<div class="t-row"><span class="t-sw" style="background:transparent"></span><span class="t-name">at</span><span class="t-val">${fmtTimeS(d.t)}</span></div>`);
    })
    .on('pointerleave', () => { cross.attr('opacity', 0); dot.attr('opacity', 0); tip.style('opacity', 0); });
}

function renderAll() { render(); renderSoc(); }

function showLoadError(err) {
  d3.selectAll('#chart, #soc-chart').remove();
  d3.selectAll('.card-body').append('p').attr('class', 'load-error')
    .text(`Could not load ${DATA_URL}: ${err.message}. This page reads its data over the network, so it needs to be served over http rather than opened from disk.`);
  console.error(err);
}

(async function init() {
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = parseRows(await res.text());
    if (DATA.length < 2) throw new Error('not enough rows');
  } catch (err) {
    showLoadError(err);
    return;
  }

  fullExtent = d3.extent(DATA, d => d.t);
  BY_SOC = DATA.slice().sort((a, b) => a.soc - b.soc);
  STEPS = detectSteps();
  buildTiles();

  renderAll();
  // the animation owns the first paint; everything after it redraws instantly
  const settle = REDUCED_MOTION ? 0 : DRAW_MS + STAGGER * (SERIES.length - 1) + 300;
  setTimeout(() => { firstPaint = false; }, settle);

  const widths = () => [svg.node().getBoundingClientRect().width,
                        socSvg.node().getBoundingClientRect().width].join('x');
  let lastW = widths();
  let rt;
  // ResizeObserver fires once on observe; ignoring an unchanged width keeps that
  // first callback from redrawing over the animation.
  const ro = new ResizeObserver(() => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const w = widths();
      if (w === lastW) return;
      lastW = w;
      renderAll();
    }, 80);
  });
  ro.observe(svg.node().parentNode);
  ro.observe(socSvg.node().parentNode);
  new MutationObserver(renderAll).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
})();
