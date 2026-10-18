/* Blueprint tab: import in-game blueprint PNGs, show them in 3D and analyse production. */
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
  const HEATER_IDLE = { Crucible: 0.4 };

  const st = { list: [], sel: -1, layer: 0, picked: null, fert: '' };
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
    if (ok) { st.sel = st.list.length - 1; st.layer = st.list[st.sel].maxZ; st.picked = null; }
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

  // ------------------------------------------------------------------ 3D view (three.js, loaded on demand)
  // Game grid -> three.js: x -> X, y -> Z, level (z) -> Y. One cell = 1 unit.
  const ROT_YAW = { NoRotation: 0, ClockWise: -Math.PI / 2, CentralSymmetry: Math.PI, CounterClockWise: Math.PI / 2 };
  const THIN = { belt: 0.22, pipe: 0.3, rail: 0.2 }; // drawn as slabs instead of full-height boxes
  let T = null, Orbit = null, loading = null;
  const v3 = { renderer: null, scene: null, camera: null, controls: null, meshes: [], key: null, hoverMesh: null, raf: 0 };
  const texCache = {};
  // per-category visibility: 'on' | 'faded' | 'off' (clicking the legend cycles)
  const catMode = { structure: 'faded', shop: 'faded', deco: 'faded' };
  const modeOf = c => catMode[c] || 'on';

  function loadThree() {
    if (!loading) {
      loading = Promise.all([import('three'), import(new URL('vendor/three/OrbitControls.js', document.baseURI).href)])
        .then(([three, oc]) => { T = three; Orbit = oc.OrbitControls; });
    }
    return loading;
  }
  function iconTexture(src) {
    if (!texCache[src]) {
      const tex = new T.TextureLoader().load(src, requestDraw);
      tex.colorSpace = T.SRGBColorSpace;
      texCache[src] = tex;
    }
    return texCache[src];
  }
  function arrowTexture() {
    if (!texCache.__arrow) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff';
      g.strokeStyle = 'rgba(0,0,0,.6)';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(56, 32); g.lineTo(18, 10); g.lineTo(26, 32); g.lineTo(18, 54); g.closePath();
      g.fill(); g.stroke();
      const tex = new T.CanvasTexture(c);
      tex.colorSpace = T.SRGBColorSpace;
      texCache.__arrow = tex;
    }
    return texCache.__arrow;
  }
  const materials = {};
  function boxMaterial(cat, faded) {
    const k = cat + (faded ? ':f' : '');
    if (!materials[k]) {
      materials[k] = new T.MeshLambertMaterial({
        color: CAT_COLORS[cat] || CAT_COLORS.unknown, transparent: faded, opacity: faded ? 0.18 : 1, depthWrite: !faded,
      });
    }
    return materials[k];
  }

  function requestDraw() {
    if (v3.raf) return;
    v3.raf = requestAnimationFrame(() => { v3.raf = 0; if (v3.renderer) v3.renderer.render(v3.scene, v3.camera); });
  }

  function ensureRenderer(wrap) {
    if (!v3.renderer) {
      v3.renderer = new T.WebGLRenderer({ antialias: true });
      v3.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      v3.camera = new T.PerspectiveCamera(40, 1, 0.1, 5000);
      v3.controls = new Orbit(v3.camera, v3.renderer.domElement);
      v3.controls.enableDamping = false;
      v3.controls.addEventListener('change', requestDraw);
      const el = v3.renderer.domElement;
      el.id = 'bp-canvas';
      el.addEventListener('pointermove', onHover);
      el.addEventListener('pointerleave', () => setHover(null));
      el.addEventListener('pointerdown', e => { v3.down = [e.clientX, e.clientY]; });
      el.addEventListener('pointerup', e => {
        if (!v3.down || Math.hypot(e.clientX - v3.down[0], e.clientY - v3.down[1]) > 4) return;
        const hit = pickAt(e);
        st.picked = hit ? hit.userData.i : null;
        updateHighlight();
        renderDetail();
      });
    }
    if (v3.renderer.domElement.parentElement !== wrap) wrap.prepend(v3.renderer.domElement);
    resize();
  }
  function resize() {
    const wrap = $('#bp-canvas-wrap');
    if (!v3.renderer || !wrap) return;
    const w = Math.max(240, wrap.clientWidth);
    const h = Math.round(Math.max(300, Math.min(window.innerHeight * 0.62, Math.max(w * 0.85, 380))));
    v3.renderer.setSize(w, h);
    v3.camera.aspect = w / h;
    v3.camera.updateProjectionMatrix();
    requestDraw();
  }

  function buildScene(bp) {
    const scene = new T.Scene();
    const css = getComputedStyle(document.documentElement);
    scene.background = new T.Color(css.getPropertyValue('--surface-2').trim() || '#eeeeee');
    scene.add(new T.HemisphereLight(0xffffff, 0x8a8478, 2.2));
    const sun = new T.DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.6, 1.4, 0.9);
    scene.add(sun);
    // ground grid sized to the blueprint
    const grid = [];
    for (let x = 0; x <= bp.size.w; x++) grid.push(x, 0, 0, x, 0, bp.size.d);
    for (let y = 0; y <= bp.size.d; y++) grid.push(0, 0, y, bp.size.w, 0, y);
    const gg = new T.BufferGeometry();
    gg.setAttribute('position', new T.Float32BufferAttribute(grid, 3));
    scene.add(new T.LineSegments(gg, new T.LineBasicMaterial({ color: css.getPropertyValue('--border').trim() || '#bbbbbb' })));
    const box = new T.BoxGeometry(1, 1, 1);
    const edges = new T.EdgesGeometry(box);
    const edgeMat = new T.LineBasicMaterial({ color: 0x3a3226, transparent: true, opacity: 0.45 });
    const plane = new T.PlaneGeometry(1, 1);
    v3.meshes = [];
    for (const b of bp.buildings) {
      const info = bInfo(b.id);
      const cat = info.cat in CAT_COLORS ? info.cat : 'unknown';
      const thin = THIN[cat];
      const h = thin || bh(b);
      const group = new T.Group();
      group.position.set(b.x + b.w / 2, b.z + h / 2, b.y + b.d / 2);
      group.userData = { b, cat };
      const mesh = new T.Mesh(box, boxMaterial(cat, false));
      mesh.scale.set(b.w - 0.06, h - (thin ? 0 : 0.04), b.d - 0.06);
      mesh.userData = { i: b.i, cat };
      group.add(mesh);
      const edge = new T.LineSegments(edges, edgeMat);
      edge.scale.copy(mesh.scale);
      group.add(edge);
      // icon on the top face (arrows on belts)
      const s = Math.min(b.w, b.d) * 0.82;
      const topTex = cat === 'belt' && b.w === 1 && b.d === 1 ? arrowTexture() : info.icon ? iconTexture(info.icon) : null;
      if (topTex) {
        const yaw = new T.Group();
        yaw.position.y = h / 2 + 0.01;
        if (topTex === texCache.__arrow) yaw.rotation.y = ROT_YAW[b.rot] || 0;
        const p = new T.Mesh(plane, new T.MeshBasicMaterial({ map: topTex, transparent: true, depthWrite: false }));
        p.rotation.x = -Math.PI / 2;
        p.scale.set(s, s, 1);
        yaw.add(p);
        group.add(yaw);
      }
      scene.add(group);
      v3.meshes.push(group);
    }
    return scene;
  }

  function applyVisibility() {
    const bp = cur();
    if (!bp) return;
    for (const g of v3.meshes) {
      const { b, cat } = g.userData;
      const mode = modeOf(cat);
      g.visible = mode !== 'off' && b.z <= st.layer;
      const mesh = g.children[0];
      mesh.material = boxMaterial(cat, mode === 'faded');
      g.children[1].visible = mode !== 'faded';
      if (g.children[2]) g.children[2].visible = mode !== 'faded';
    }
    updateHighlight();
  }
  function updateHighlight() {
    for (const g of v3.meshes) {
      const mesh = g.children[0];
      const on = st.picked === g.userData.b.i || v3.hoverMesh === mesh;
      if (on) {
        if (!mesh.userData.hl) mesh.material = mesh.material.clone();
        mesh.userData.hl = true;
        mesh.material.emissive = new T.Color(st.picked === g.userData.b.i ? 0x1f8a7c : 0x444444);
      } else if (mesh.userData.hl) {
        mesh.userData.hl = false;
        mesh.material = boxMaterial(g.userData.cat, modeOf(g.userData.cat) === 'faded');
      }
    }
    requestDraw();
  }
  function resetCamera(bp) {
    const cx = bp.size.w / 2, cz = bp.size.d / 2, H = bp.maxZ + 1;
    const r = Math.max(bp.size.w, bp.size.d, H) * 1.35 + 4;
    v3.controls.target.set(cx, H * 0.3, cz);
    v3.camera.position.set(cx + r * 0.75, H * 0.3 + r * 0.85, cz + r * 1.0);
    v3.controls.update();
    requestDraw();
  }
  const raycaster = () => (v3.ray = v3.ray || new T.Raycaster());
  function pickAt(e) {
    const r = v3.renderer.domElement.getBoundingClientRect();
    const ndc = new T.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = raycaster();
    ray.setFromCamera(ndc, v3.camera);
    const targets = v3.meshes.filter(g => g.visible && modeOf(g.userData.cat) !== 'faded').map(g => g.children[0]);
    const hits = ray.intersectObjects(targets, false);
    return hits.length ? hits[0].object : null;
  }
  function setHover(mesh, e) {
    const tip = $('#bp-tip');
    if (mesh !== v3.hoverMesh) { v3.hoverMesh = mesh; updateHighlight(); }
    if (!tip) return;
    if (!mesh) { tip.hidden = true; return; }
    const b = cur().buildings[mesh.userData.i];
    const wrap = $('#bp-canvas-wrap').getBoundingClientRect();
    tip.hidden = false;
    tip.innerHTML = `<b>${esc(bName(b.id))}</b>${b.recipe || b.seed || b.cauldron.length ? `<br>${esc(b.cauldron.length ? b.cauldron.map(nm).join(' + ') : nm(b.recipe || b.seed))}` : ''}`;
    tip.style.left = (e.clientX - wrap.left + 14) + 'px';
    tip.style.top = (e.clientY - wrap.top + 14) + 'px';
  }
  function onHover(e) {
    if (e.buttons) return; // dragging the camera
    setHover(pickAt(e), e);
  }

  async function draw3d() {
    const bp = cur();
    const wrap = $('#bp-canvas-wrap');
    if (!bp || !wrap) return;
    try { await loadThree(); } catch (err) {
      wrap.innerHTML = `<p class="alert">${esc(t('bp3dError'))}</p>`;
      console.error(err);
      return;
    }
    ensureRenderer(wrap);
    const key = st.sel + ':' + bp.file;
    if (v3.key !== key) {
      v3.scene = buildScene(bp);
      v3.key = key;
      v3.hoverMesh = null;
      resetCamera(bp);
    }
    applyVisibility();
    resize();
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
      `<button class="bp-legend-item mode-${modeOf(c)}" data-bp-cat="${c}" title="${esc(t('bpCatToggle'))}"><i style="background:${CAT_COLORS[c]}"></i>${esc(t('bpCat_' + c))} <b>${an.cats[c]}</b><small>${esc(t('bpCatMode_' + modeOf(c)))}</small></button>`).join('');
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
          <button class="btn-ghost small" data-bp-reset="1">${esc(t('bpResetView'))}</button>
        </div>
        <div class="bp-controls">
          <label class="bp-layer">${esc(t('bpHeightLimit'))}
            <input type="range" id="bp-layer" min="0" max="${bp.maxZ}" value="${st.layer}">
            <b id="bp-layer-val">${st.layer}</b> / ${bp.maxZ}</label>
        </div>
        <div class="bp-legend">${catLegend}</div>
        <div class="bp-canvas-wrap" id="bp-canvas-wrap"><div id="bp-tip" class="bp-tip" hidden></div></div>
        <p class="hint small">${esc(t('bpViewHint'))}</p>
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
    if (v3.renderer) v3.renderer.domElement.remove();
    draw3d();
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
    if (d.bpSel !== undefined) { st.sel = +d.bpSel; st.layer = cur().maxZ; st.picked = null; render(); return; }
    if (d.bpCat) {
      const order = ['on', 'faded', 'off'];
      catMode[d.bpCat] = order[(order.indexOf(modeOf(d.bpCat)) + 1) % 3];
      b.className = `bp-legend-item mode-${modeOf(d.bpCat)}`;
      b.querySelector('small').textContent = t('bpCatMode_' + modeOf(d.bpCat));
      applyVisibility();
      return;
    }
    if (d.bpReset && cur() && v3.controls) { resetCamera(cur()); return; }
    if (b.id === 'bp-pick') $('#bp-file').click();
  });
  document.addEventListener('input', e => {
    if (e.target.id === 'bp-layer') { st.layer = +e.target.value; $('#bp-layer-val').textContent = st.layer; applyVisibility(); }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'bp-fert') { st.fert = e.target.value; render(); return; }
    if (e.target.id === 'bp-file') { importFiles([...e.target.files]); e.target.value = ''; }
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
  window.addEventListener('resize', () => resize());

  window.AFBlueprintView = { render };
})();
