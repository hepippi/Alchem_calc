/* Blueprint tab: import in-game blueprint PNGs, show them layer by layer and analyse production. */
(function () {
  'use strict';
  const A = window.AFApp;
  const { D, C, IDX, t, nm, pick, fmt, esc, ico, itemIco, toast } = A;
  const BP = window.AFBlueprint;
  const $ = s => document.querySelector(s);

  const CAT_COLORS = {
    craft: '#e0a43c', heat: '#d9573f', storage: '#4b8fd6', belt: '#7a8b99', structure: '#b9b2a6',
    pipe: '#9a6bd1', rail: '#9b6b43', shop: '#c98bb9', deco: '#c9c2b4', unknown: '#888888',
  };
  const CATS = ['craft', 'heat', 'storage', 'belt', 'pipe', 'rail', 'structure', 'shop', 'deco'];
  // facing of each rotation on screen (x right, y down); unverified convention: NoRotation faces +x
  const ROT_DIR = { NoRotation: [1, 0], ClockWise: [0, 1], CentralSymmetry: [-1, 0], CounterClockWise: [0, -1] };
  const HEATER_IDLE = { Crucible: 0.4 };

  const st = { list: [], sel: -1, layer: 0, mode: 'layer', zoom: 1, hover: null, picked: null, fert: '' };
  const FERTS = Object.entries(D.items).filter(([, it]) => it.nutrient > 0 && it.nutrientSpeed > 0 && !it.hidden).sort((a, b) => a[1].nutrient - b[1].nutrient).map(([id]) => id);
  const fertId = () => (FERTS.includes(st.fert) ? st.fert : (FERTS.includes(A.plan().fertilizer) ? A.plan().fertilizer : FERTS[0]));
  const bName = id => (D.buildings[id] ? pick(D.buildings[id].name) : id) || id;
  const bInfo = id => D.buildings[id] || { cat: 'unknown', z0: 0, h: 1, heat: 0, name: {} };
  const bh = b => Math.max(1, bInfo(b.id).h);
  const cur = () => st.list[st.sel];

  // ------------------------------------------------------------------ import
  async function importFiles(files) {
    let ok = 0;
    for (const f of files) {
      try {
        const buf = new Uint8Array(await f.arrayBuffer());
        const bp = await BP.parse(buf);
        bp.file = f.name;
        bp.thumb = URL.createObjectURL(new Blob([buf], { type: 'image/png' }));
        bp.maxZ = Math.max(0, ...bp.buildings.map(b => b.z + bh(b) - 1));
        st.list.push(bp);
        ok++;
      } catch (e) {
        toast(`${f.name}: ${e.message === 'not-blueprint' ? t('bpNotBlueprint') : t('bpReadError')}`);
        console.error(e);
      }
    }
    if (ok) { st.sel = st.list.length - 1; st.layer = 0; st.picked = null; st.zoom = 1; }
    render();
  }

  // ------------------------------------------------------------------ analysis
  function analyse(bp) {
    const ctx = C.context(D, A.plan());
    const groups = new Map();
    const cats = {};
    let heat = 0;
    for (const b of bp.buildings) {
      const info = bInfo(b.id);
      cats[info.cat] = (cats[info.cat] || 0) + 1;
      if (info.heat > 0) heat += (info.heat + (HEATER_IDLE[b.id] ?? 1)) * ctx.factory;
      if (!info.craft) continue;
      const key = [pick(info.name), b.recipe, b.seed, b.cauldron.join('+')].join('|');
      if (!groups.has(key)) groups.set(key, { b, info, n: 0 });
      groups.get(key).n++;
    }
    const rows = [...groups.values()].map(g => ({ ...g, ...machineOutput(g.b, g.info, ctx) }));
    rows.sort((a, b) => (a.outputs.length ? 0 : 1) - (b.outputs.length ? 0 : 1) || b.n - a.n);
    const totals = {};
    for (const r of rows) {
      for (const o of r.outputs) totals[o.item] = (totals[o.item] || 0) + o.rate * r.n;
      for (const i of r.inputs) totals[i.item] = (totals[i.item] || 0) - i.rate * r.n;
    }
    return { rows, cats, heat, totals, ctx };
  }

  /** Output/input per minute of one machine as configured in the blueprint (empty when it depends on its input). */
  function machineOutput(b, info, ctx) {
    const type = info.craft.types[0];
    const none = { outputs: [], inputs: [], note: '' };
    if (type === 'Cauldron') {
      if (b.cauldron.length < 2) return { ...none, note: t('bpAnyInput') };
      const m = C.cauldronMix(D, b.cauldron);
      if (!m) return { ...none, note: t('cdNoResult') };
      const per = 60 / (m.time / ctx.factory);
      return { outputs: [{ item: m.result, rate: per }], inputs: b.cauldron.map(id => ({ item: id, rate: per })), note: '' };
    }
    if ((type === 'Plant' || type === 'Nursery') && b.seed) {
      const p = D.plants[b.seed];
      if (!p) return none;
      let perMin;
      if (type === 'Nursery') {
        const fert = D.items[fertId()];
        perMin = Math.min(60 * fert.nutrientSpeed * ctx.factory / p.nutrientPerItem, ctx.belt);
      } else perMin = p.num / p.seconds * 60 * ctx.factory;
      const outs = [{ item: p.plant, rate: perMin }];
      if (p.side) outs.push({ item: p.side, rate: perMin * p.sideNum / p.num });
      const inputs = [{ item: b.seed, rate: perMin / p.num }];
      if (type === 'Nursery') inputs.push({ item: fertId(), rate: perMin * p.nutrientPerItem / (D.items[fertId()].nutrient * ctx.fertEff) });
      return { outputs: outs, inputs, note: '' };
    }
    const r = b.recipe && (IDX.recipeById[b.recipe] || (IDX.byMain[b.recipe] || [])[0]);
    if (!r) return { ...none, note: t('bpAnyInput') };
    const mult = { Extract: ctx.alchemy, Distill: ctx.alchemy, AdDistill: ctx.alchemy }[r.type] || 1;
    const crafts = 60 / r.time * info.craft.speed * (r.type === 'Paradox' ? 1 : ctx.factory);
    return {
      outputs: r.out.map(o => ({ item: o.item, rate: o.n * mult * crafts, p: o.p })),
      inputs: r.in.map(i => ({ item: i.item, rate: i.n * crafts })), note: '',
    };
  }

  // ------------------------------------------------------------------ drawing
  const icons = {};
  function iconImg(src) {
    if (!src) return null;
    if (!icons[src]) { const im = new Image(); im.onload = draw; im.src = src; icons[src] = im; }
    return icons[src].complete && icons[src].naturalWidth ? icons[src] : null;
  }
  function visible(bp) {
    if (st.mode === 'top') {
      // top view: for each cell keep the highest building
      const top = new Map();
      for (const b of bp.buildings) {
        const zt = b.z + bh(b) - 1;
        for (let x = b.x; x < b.x + b.w; x++) for (let y = b.y; y < b.y + b.d; y++) {
          const k = x + ',' + y, cur2 = top.get(k);
          if (!cur2 || zt > cur2.z + bh(cur2) - 1) top.set(k, b);
        }
      }
      return { main: [...new Set(top.values())], ghost: [] };
    }
    const L = st.layer;
    return {
      main: bp.buildings.filter(b => b.z <= L && L <= b.z + bh(b) - 1),
      ghost: bp.buildings.filter(b => b.z + bh(b) - 1 < L && b.z + bh(b) - 1 >= L - 3),
    };
  }
  function cellSize(bp) {
    const wrap = $('#bp-canvas-wrap');
    const avail = Math.max(240, (wrap ? wrap.clientWidth : 800) - 24);
    const base = Math.max(8, Math.min(48, Math.floor(avail / Math.max(bp.size.w, bp.size.d, 1))));
    return Math.max(4, Math.round(base * st.zoom));
  }
  function draw() {
    const bp = cur();
    const cv = $('#bp-canvas');
    if (!bp || !cv) return;
    const cs = cellSize(bp);
    const pad = 12;
    const W = bp.size.w * cs + pad * 2, H = bp.size.d * cs + pad * 2;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    g.fillStyle = css.getPropertyValue('--surface-2').trim() || '#eee';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = css.getPropertyValue('--border').trim() || '#ccc';
    g.lineWidth = 1;
    for (let x = 0; x <= bp.size.w; x++) { g.beginPath(); g.moveTo(pad + x * cs + 0.5, pad); g.lineTo(pad + x * cs + 0.5, pad + bp.size.d * cs); g.stroke(); }
    for (let y = 0; y <= bp.size.d; y++) { g.beginPath(); g.moveTo(pad, pad + y * cs + 0.5); g.lineTo(pad + bp.size.w * cs, pad + y * cs + 0.5); g.stroke(); }
    const { main, ghost } = visible(bp);
    const rect = b => [pad + b.x * cs + 1, pad + b.y * cs + 1, b.w * cs - 2, b.d * cs - 2];
    g.globalAlpha = 0.18;
    for (const b of ghost) { g.fillStyle = CAT_COLORS[bInfo(b.id).cat]; g.fillRect(...rect(b)); }
    g.globalAlpha = 1;
    const order = main.slice().sort((a, b) => (a.w * a.d) - (b.w * b.d) || a.z - b.z).reverse();
    for (const b of order) {
      const info = bInfo(b.id);
      const [x, y, w, h] = rect(b);
      g.fillStyle = CAT_COLORS[info.cat] || CAT_COLORS.unknown;
      g.globalAlpha = st.mode === 'layer' && b.z < st.layer ? 0.55 : 0.9;
      g.fillRect(x, y, w, h);
      g.globalAlpha = 1;
      const im = iconImg(info.icon);
      const s = Math.min(w, h) * 0.8;
      if (im && s >= 10) g.drawImage(im, x + (w - s) / 2, y + (h - s) / 2, s, s);
      if (info.cat === 'belt' && cs >= 8) arrow(g, x + w / 2, y + h / 2, Math.min(w, h) * 0.32, ROT_DIR[b.rot] || [1, 0]);
      if (st.picked === b.i || (st.hover && st.hover.i === b.i)) {
        g.strokeStyle = st.picked === b.i ? '#23786d' : '#000';
        g.lineWidth = 2;
        g.strokeRect(x, y, w, h);
        g.lineWidth = 1;
      }
    }
  }
  function arrow(g, cx, cy, r, [dx, dy]) {
    g.fillStyle = 'rgba(255,255,255,.95)';
    g.strokeStyle = 'rgba(0,0,0,.55)';
    g.beginPath();
    g.moveTo(cx + dx * r, cy + dy * r);
    g.lineTo(cx - dx * r * 0.6 - dy * r * 0.7, cy - dy * r * 0.6 + dx * r * 0.7);
    g.lineTo(cx - dx * r * 0.6 + dy * r * 0.7, cy - dy * r * 0.6 - dx * r * 0.7);
    g.closePath();
    g.fill();
    g.stroke();
  }
  function hitTest(ev) {
    const bp = cur();
    const cv = $('#bp-canvas');
    if (!bp || !cv) return null;
    const r = cv.getBoundingClientRect();
    const cs = cellSize(bp);
    const cx = Math.floor((ev.clientX - r.left - 12) / cs), cy = Math.floor((ev.clientY - r.top - 12) / cs);
    const { main } = visible(bp);
    const hits = main.filter(b => cx >= b.x && cx < b.x + b.w && cy >= b.y && cy < b.y + b.d);
    hits.sort((a, b) => (a.w * a.d) - (b.w * b.d) || (b.z + bh(b)) - (a.z + bh(a)));
    return hits[0] || null;
  }

  // ------------------------------------------------------------------ render
  function render() {
    const el = $('#tab-blueprint');
    if (!el || el.hidden) return;
    $('#bp-list').innerHTML = st.list.length ? st.list.map((bp, i) => `
      <button class="bp-card ${i === st.sel ? 'active' : ''}" data-bp-sel="${i}">
        <img src="${bp.thumb}" alt="">
        <span class="bp-card-meta"><b>${esc(bp.title || bp.file)}</b>
          <small>${bp.size.w}×${bp.size.d}×${bp.maxZ + 1} · ${bp.buildings.length} ${esc(t('bpBuildings'))}</small></span>
      </button>`).join('') : `<p class="muted small">${esc(t('bpNone'))}</p>`;
    const bp = cur();
    const main = $('#bp-main');
    if (!bp) { main.innerHTML = ''; return; }
    const an = analyse(bp);
    st.layer = Math.min(st.layer, bp.maxZ);
    const catLegend = CATS.filter(c => an.cats[c]).map(c =>
      `<span class="bp-legend-item"><i style="background:${CAT_COLORS[c]}"></i>${esc(t('bpCat_' + c))} <b>${an.cats[c]}</b></span>`).join('');
    const totalsPos = Object.entries(an.totals).filter(([, v]) => v > 1e-9).sort((a, b) => b[1] - a[1]);
    const totalsNeg = Object.entries(an.totals).filter(([, v]) => v < -1e-9).sort((a, b) => a[1] - b[1]);
    const chips = list => list.map(([id, v]) => `<span class="chip">${itemIco(id)}<b>${fmt(Math.abs(v))}</b><span class="muted">${esc(nm(id))}</span></span>`).join('');
    main.innerHTML = `
      <div class="summary">
        <div class="stat"><div class="label">${esc(t('bpSize'))}</div><div class="value">${bp.size.w}×${bp.size.d}<small>×${bp.maxZ + 1} ${esc(t('bpLayersUnit'))}</small></div></div>
        <div class="stat"><div class="label">${esc(t('bpBuildings'))}</div><div class="value">${bp.buildings.length}</div></div>
        <div class="stat"><div class="label">${esc(t('bpMachines'))}</div><div class="value">${an.rows.reduce((s, r) => s + r.n, 0)}</div></div>
        <div class="stat"><div class="label">${esc(t('heatTotal'))}</div><div class="value">${fmt(an.heat)}<small>${esc(t('heatUnit'))}</small></div></div>
      </div>
      <div class="card bp-viewer">
        <div class="section-head">
          <h2>${esc(bp.title || bp.file)}</h2>
          <div class="seg"><button data-bp-mode="layer" aria-pressed="${st.mode === 'layer'}">${esc(t('bpModeLayer'))}</button><button data-bp-mode="top" aria-pressed="${st.mode === 'top'}">${esc(t('bpModeTop'))}</button></div>
        </div>
        <div class="bp-controls">
          <label class="bp-layer ${st.mode === 'top' ? 'disabled' : ''}">${esc(t('bpLayer'))}
            <input type="range" id="bp-layer" min="0" max="${bp.maxZ}" value="${st.layer}" ${st.mode === 'top' ? 'disabled' : ''}>
            <b id="bp-layer-val">${st.layer}</b> / ${bp.maxZ}</label>
          <span class="bp-zoom"><button class="btn-ghost" data-bp-zoom="-1" aria-label="zoom out">−</button><button class="btn-ghost" data-bp-zoom="0">${esc(t('bpFit'))}</button><button class="btn-ghost" data-bp-zoom="1" aria-label="zoom in">＋</button></span>
        </div>
        <div class="bp-legend">${catLegend}</div>
        <div class="bp-canvas-wrap" id="bp-canvas-wrap"><canvas id="bp-canvas"></canvas><div id="bp-tip" class="bp-tip" hidden></div></div>
        <p class="hint small">${esc(t('bpDirNote'))}</p>
        <div id="bp-detail"></div>
      </div>
      <div class="card">
        <div class="section-head"><h2>${esc(t('bpAnalysis'))}</h2>
          ${an.rows.some(r => r.info.craft.types[0] === 'Nursery') ? `<label class="bp-fert">${esc(t('bpNurseryFert'))}
            <select id="bp-fert">${FERTS.map(id => `<option value="${id}" ${id === fertId() ? 'selected' : ''}>${esc(nm(id))}</option>`).join('')}</select></label>` : ''}</div>
        <p class="hint small">${esc(t('bpAnalysisHint', { p: fmt(an.ctx.factory * 100) }))}</p>
        <div class="table-wrap"><table class="line"><thead><tr><th>${esc(t('colMachine'))}</th><th class="num">${esc(t('colCount'))}</th>
          <th>${esc(t('bpSetting'))}</th><th>${esc(t('bpOutPerMin'))}</th><th>${esc(t('colInputs'))}</th></tr></thead>
          <tbody>${an.rows.map(r => `<tr>
            <td><span class="it sm">${ico(r.info.icon)}<span>${esc(pick(r.info.name))}</span></span></td>
            <td class="num"><b>${r.n}</b></td>
            <td>${settingLabel(r.b)}</td>
            <td><div class="inputs">${r.outputs.map(o => `<span class="chip">${itemIco(o.item)}<b>${fmt(o.rate * r.n)}</b><span class="muted">${esc(nm(o.item))}</span></span>`).join('') || `<span class="muted small">${esc(r.note)}</span>`}</div></td>
            <td><div class="inputs">${r.inputs.map(i => `<span class="chip">${itemIco(i.item)}<b>${fmt(i.rate * r.n)}</b><span class="muted">${esc(nm(i.item))}</span></span>`).join('')}</div></td>
          </tr>`).join('')}</tbody></table></div>
        ${totalsPos.length ? `<h3>${esc(t('bpNetOut'))}</h3><div class="inputs">${chips(totalsPos)}</div>` : ''}
        ${totalsNeg.length ? `<h3>${esc(t('bpNetIn'))}</h3><div class="inputs">${chips(totalsNeg)}</div>` : ''}
      </div>`;
    draw();
    renderDetail();
  }
  function settingLabel(b) {
    if (b.cauldron.length) return `<span class="inputs">${b.cauldron.map(id => `<span class="chip">${itemIco(id)}<span class="muted">${esc(nm(id))}</span></span>`).join('<span class="muted">+</span>')}</span>`;
    if (b.seed) return `<span class="chip">${itemIco(b.seed)}<span class="muted">${esc(nm(b.seed))}</span></span>`;
    if (b.recipe) return `<span class="chip">${itemIco(b.recipe)}<span class="muted">${esc(nm(b.recipe))}</span></span>`;
    return `<span class="muted small">${esc(t('bpNoSetting'))}</span>`;
  }
  function renderDetail() {
    const bp = cur();
    const el = $('#bp-detail');
    if (!el) return;
    const b = bp && st.picked != null ? bp.buildings[st.picked] : null;
    if (!b) { el.innerHTML = ''; return; }
    const info = bInfo(b.id);
    const kv = [
      [t('bpPosition'), `x ${b.x}, y ${b.y}, ${t('bpLayer')} ${b.z}–${b.z + bh(b) - 1}`],
      [t('bpFootprint'), `${b.w}×${b.d}`],
      [t('bpRotation'), t('bpRot_' + b.rot)],
      [t('bpCategory'), t('bpCat_' + info.cat)],
    ];
    el.innerHTML = `<div class="bp-detail-card">
      <div class="detail-head">${ico(info.icon)}<div><h2>${esc(bName(b.id))}</h2><code class="muted small">${esc(b.id)}</code></div></div>
      <dl class="kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
        ${b.recipe || b.seed || b.cauldron.length ? `<dt>${esc(t('bpSetting'))}</dt><dd>${settingLabel(b)}</dd>` : ''}
        ${b.filter ? `<dt>${esc(t('bpFilter'))}</dt><dd><span class="chip">${itemIco(b.filter)}<span>${esc(nm(b.filter))}</span></span></dd>` : ''}
      </dl></div>`;
  }

  // ------------------------------------------------------------------ events
  document.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.bpSel !== undefined) { st.sel = +d.bpSel; st.layer = 0; st.picked = null; st.zoom = 1; render(); return; }
    if (d.bpMode) { st.mode = d.bpMode; render(); return; }
    if (d.bpZoom !== undefined) {
      st.zoom = d.bpZoom === '0' ? 1 : Math.max(0.25, Math.min(6, st.zoom * (d.bpZoom === '1' ? 1.4 : 1 / 1.4)));
      draw();
      return;
    }
    if (b.id === 'bp-pick') $('#bp-file').click();
  });
  document.addEventListener('input', e => {
    if (e.target.id === 'bp-layer') { st.layer = +e.target.value; $('#bp-layer-val').textContent = st.layer; draw(); }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'bp-fert') { st.fert = e.target.value; render(); return; }
    if (e.target.id === 'bp-file') { importFiles([...e.target.files]); e.target.value = ''; }
  });
  document.addEventListener('mousemove', e => {
    if (e.target.id !== 'bp-canvas') { if (st.hover) { st.hover = null; const tip = $('#bp-tip'); if (tip) tip.hidden = true; draw(); } return; }
    const h = hitTest(e);
    const tip = $('#bp-tip');
    if ((h && h.i) !== (st.hover && st.hover.i)) { st.hover = h; draw(); }
    if (!h) { tip.hidden = true; return; }
    const wrap = $('#bp-canvas-wrap').getBoundingClientRect();
    tip.hidden = false;
    tip.innerHTML = `<b>${esc(bName(h.id))}</b>${h.recipe || h.seed || h.cauldron.length ? `<br>${esc(nm(h.recipe || h.seed || h.cauldron.join(' + ')))}` : ''}`;
    tip.style.left = (e.clientX - wrap.left + 14) + 'px';
    tip.style.top = (e.clientY - wrap.top + 14) + 'px';
  });
  document.addEventListener('mousedown', e => {
    if (e.target.id !== 'bp-canvas') return;
    const h = hitTest(e);
    st.picked = h ? h.i : null;
    draw();
    renderDetail();
  });
  const dropTarget = () => $('#tab-blueprint');
  document.addEventListener('dragover', e => { if (dropTarget() && !dropTarget().hidden) { e.preventDefault(); $('#bp-drop').classList.add('over'); } });
  document.addEventListener('dragleave', e => { if (e.target === document.documentElement || e.target.id === 'bp-drop') $('#bp-drop') && $('#bp-drop').classList.remove('over'); });
  document.addEventListener('drop', e => {
    if (!dropTarget() || dropTarget().hidden) return;
    e.preventDefault();
    $('#bp-drop').classList.remove('over');
    const files = [...e.dataTransfer.files].filter(f => /\.png$/i.test(f.name));
    if (files.length) importFiles(files);
  });
  window.addEventListener('resize', () => draw());

  window.AFBlueprintView = { render };
})();
