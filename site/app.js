/* Alchemy Factory calculator UI */
(function () {
  'use strict';
  const D = window.GAME_DATA;
  const C = window.AFCalc;
  const IDX = C.buildIndex(D);
  const RESEARCH_KEYS = ['factory', 'fuel', 'fertilizer', 'alchemy', 'logistics'];
  const LANG_LABELS = {
    ja: '日本語', en: 'English', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文', ko: '한국어',
    de: 'Deutsch', fr: 'Français', es: 'Español', 'pt-BR': 'Português (BR)', ru: 'Русский',
  };
  const $ = sel => document.querySelector(sel);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };

  // ------------------------------------------------------------------ state
  const DEFAULT_PLAN = {
    targets: [], recipes: {}, machines: {}, cauldron: {},
    research: { factory: 0, fuel: 0, fertilizer: 0, alchemy: 0, logistics: 0 },
    fuel: 'Charcoal', fertilizer: '', byproducts: 'recycle', selfSupply: false, herbOnly: false, herbCore: false, hoPriority: 'space', hoLeaf: 'noCauldron', hoCoin: true, hoForce: {},
  };
  const ui = {
    lang: store.get('af.lang', (navigator.language || 'ja').startsWith('ja') ? 'ja' : 'en'),
    tab: 'planner', view: store.get('af.view', 'table'), dbTag: '', dbItem: null, dbQuery: '',
  };
  if (!D.langs.includes(ui.lang)) ui.lang = 'en';
  let plan = readHash() || store.get('af.plan', null) || clone(DEFAULT_PLAN);
  plan = { ...clone(DEFAULT_PLAN), ...plan, research: { ...DEFAULT_PLAN.research, ...(plan.research || {}) } };
  if (!plan.targets.length) plan.targets.push({ item: '', rate: 10, unit: 'min' });

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function b64(s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function unb64(s) { return decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))); }
  function readHash() {
    const m = location.hash.match(/[#&]p=([^&]+)/);
    if (!m) return null;
    try { return JSON.parse(unb64(m[1])); } catch (e) { return null; }
  }
  function compactPlan() {
    const p = clone(plan);
    p.targets = p.targets.filter(t => t.item);
    return p;
  }
  function persist() {
    store.set('af.plan', plan);
    const url = location.pathname + location.search + '#p=' + b64(JSON.stringify(compactPlan()));
    history.replaceState(null, '', url);
  }

  // ------------------------------------------------------------------ i18n + formatting
  const uiLang = () => (window.AF_I18N[ui.lang] ? ui.lang : 'en');
  const t = (k, vars) => {
    let s = (window.AF_I18N[uiLang()] || {})[k] ?? window.AF_I18N.en[k] ?? k;
    if (vars) for (const [a, b] of Object.entries(vars)) s = s.replace(`{${a}}`, b);
    return s;
  };
  const pick = names => (names && (names[ui.lang] || names.en || Object.values(names)[0])) || '';
  const nm = id => pick(D.items[id] && D.items[id].name) || id;
  const mn = id => pick(D.machines[id] && D.machines[id].name) || id;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function fmt(n) {
    if (!isFinite(n)) return '∞';
    const a = Math.abs(n);
    if (a === 0) return '0';
    if (a >= 1000) return Math.round(n).toLocaleString();
    if (a >= 100) return (+n.toFixed(1)).toLocaleString();
    if (a >= 0.1) return String(+n.toFixed(2));
    return String(+n.toPrecision(2));
  }
  const ico = (src, cls = '') => src ? `<img src="${src}" alt="" loading="lazy" class="${cls}">` : '';
  const itemIco = id => ico(D.items[id] && D.items[id].icon);
  const itemTag = (id, cls = '') => `<span class="it ${cls}">${itemIco(id)}<span>${esc(nm(id))}</span></span>`;
  const typeName = type => {
    const ct = D.craftTypes[type];
    const name = ct && pick(ct.name);
    if (name) return name;
    const m = IDX.machinesByType[type];
    return m ? mn(m[0]) : type;
  };
  const visibleItems = () => Object.entries(D.items).filter(([, it]) => !it.hidden).sort((a, b) => a[1].order - b[1].order);

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 1600);
  }

  // ------------------------------------------------------------------ static texts
  function applyTexts() {
    document.documentElement.lang = ui.lang;
    document.title = t('title');
    document.querySelectorAll('[data-t]').forEach(el => { el.textContent = t(el.dataset.t); });
    document.querySelectorAll('[data-tp]').forEach(el => { el.placeholder = t(el.dataset.tp); });
    $('#game-version').textContent = D.version;
  }

  // ------------------------------------------------------------------ sidebar
  function renderTargets() {
    $('#targets').innerHTML = plan.targets.map((tg, i) => `
      <div class="target" data-i="${i}">
        <button class="item-btn ${tg.item ? '' : 'empty'}" data-act="pick-target" title="${esc(tg.item ? nm(tg.item) : t('selectItem'))}">
          ${tg.item ? itemIco(tg.item) : ''}<span>${esc(tg.item ? nm(tg.item) : t('selectItem'))}</span>
        </button>
        <input type="number" min="0" step="any" value="${esc(tg.rate)}" data-act="rate" aria-label="${esc(t('colRate'))}">
        <select data-act="unit" aria-label="unit">
          <option value="min" ${tg.unit !== 'machines' ? 'selected' : ''}>${esc(t('unitMin'))}</option>
          <option value="machines" ${tg.unit === 'machines' ? 'selected' : ''}>${esc(t('unitMachines'))}</option>
        </select>
        <button class="btn-ghost" data-act="remove" title="${esc(t('remove'))}" aria-label="${esc(t('remove'))}">✕</button>
      </div>`).join('');
  }

  function renderResearch() {
    $('#research').innerHTML = RESEARCH_KEYS.map(k => {
      const line = D.research[k];
      const lv = plan.research[k] || 0;
      const v = C.researchValue(line, lv);
      const shown = k === 'logistics' ? `${fmt(v)}${t('perMin')}` : `${fmt(v)}%`;
      return `<div class="res-row" title="${esc(pick(line.name))}">
        ${ico(line.icon)}<span class="name">${esc(pick(line.name))}</span>
        <input type="number" min="0" max="99" step="1" value="${lv}" data-res="${k}" aria-label="${esc(pick(line.name))} ${t('level')}">
        <span class="val">${shown}</span></div>`;
    }).join('');
  }

  function renderSelects() {
    const fuels = Object.entries(D.items).filter(([, it]) => it.heat > 0 && !it.hidden).sort((a, b) => a[1].heat - b[1].heat);
    $('#fuel-select').innerHTML = `<option value="">${esc(t('noFuel'))}</option>` + fuels.map(([id, it]) =>
      `<option value="${id}" ${plan.fuel === id ? 'selected' : ''}>${esc(nm(id))} (${fmt(it.heat)})</option>`).join('');
    const ferts = Object.entries(D.items).filter(([, it]) => it.nutrient > 0 && !it.hidden).sort((a, b) => a[1].nutrient - b[1].nutrient);
    const eff = C.researchValue(D.research.fertilizer, plan.research.fertilizer || 0) / 100;
    $('#fert-select').innerHTML = `<option value="">${esc(t('noFertilizer'))}</option>` + ferts.map(([id, it]) =>
      `<option value="${id}" ${plan.fertilizer === id ? 'selected' : ''}>${esc(nm(id))} (${fmt(it.nutrient * eff)}V, ${fmt(it.nutrientSpeed)}V/s)</option>`).join('');
    $('#byp-select').value = plan.byproducts;
    $('#self-supply').checked = !!plan.selfSupply;
    $('#herb-only').checked = !!plan.herbOnly;
    $('#herb-core').checked = !!plan.herbCore;
    $('#ho-priority').value = plan.hoPriority || 'space';
    $('#ho-leaf').value = plan.hoLeaf || 'noCauldron';
    $('#ho-coin').checked = plan.hoCoin !== false;
    $('#herb-core-wrap').hidden = !plan.herbOnly;
    $('#lang-select').innerHTML = D.langs.map(l => `<option value="${l}" ${l === ui.lang ? 'selected' : ''}>${LANG_LABELS[l] || l}</option>`).join('');
  }

  function renderPlans() {
    const plans = store.get('af.plans', {});
    $('#plan-list').innerHTML = Object.keys(plans).sort().map(name => `
      <div class="plan"><span title="${esc(name)}">${esc(name)}</span>
        <button class="link-btn" data-load="${esc(name)}">${esc(t('loadPlan'))}</button>
        <button class="btn-ghost small" data-del="${esc(name)}" aria-label="${esc(t('deletePlan'))}">✕</button></div>`).join('');
  }

  // ------------------------------------------------------------------ results
  function recipeLabel(r) {
    const ins = r.in.map(i => nm(i.item)).join(' + ');
    return `${r.alt ? '[' + t('alt') + '] ' : ''}${typeName(r.type)}: ${ins || '—'}`;
  }

  function recipeSelect(item) {
    const list = IDX.byMain[item] || [];
    const canCauldron = isCdOutput(item);
    if (!list.length && !canCauldron) return '';
    const cur = (plan.recipes[item]) || C.defaultRecipe(IDX, item);
    let opts = list.map(r => `<option value="${r.id}" ${cur === r.id ? 'selected' : ''}>${esc(recipeLabel(r))}</option>`).join('');
    if (canCauldron) opts += `<option value="cauldron" ${cur === 'cauldron' ? 'selected' : ''}>${esc(cauldronLabel(item))}</option>`;
    const edit = cur === 'cauldron' ? ` <button class="link-btn" data-cd-edit="${item}" title="${esc(t('tabCauldron'))}">✎</button>` : '';
    return `<select data-recipe="${item}">${opts}<option value="raw" ${cur === 'raw' ? 'selected' : ''}>${esc(t('asRaw'))}</option></select>${edit}`;
  }

  function machineCell(step) {
    const list = IDX.machinesByType[step.type] || [];
    if (list.length <= 1) return `<span class="it sm">${ico(D.machines[step.machine] && D.machines[step.machine].icon)}<span>${esc(mn(step.machine))}</span></span>`;
    return `<span class="it sm">${ico(D.machines[step.machine].icon)}<select data-machine="${step.type}">${list.map(id =>
      `<option value="${id}" ${id === step.machine ? 'selected' : ''}>${esc(mn(id))}${D.machines[id].speed !== 1 ? ` ×${D.machines[id].speed}` : ''}${D.machines[id].heat ? ` (${fmt(D.machines[id].heat)}${t('heatUnit')})` : ''}</option>`).join('')}</select></span>`;
  }

  const chip = (item, rate, extra = '') => `<span class="chip" title="${esc(nm(item))}">${itemIco(item)}<b>${fmt(rate)}</b><span class="muted">${esc(nm(item))}</span>${extra}</span>`;
  const pill = (item, rate, sub = '', action = '') => `<div class="pill">${itemIco(item)}<div class="meta"><span>${esc(nm(item))}</span><b>${fmt(rate)}<small class="muted"> ${t('perMin')}</small></b>${sub ? `<small>${sub}</small>` : ''}</div>${action}</div>`;

  // ------------------------------------------------------------------ herb-only planner results
  let hoCache = { key: '', res: null };
  function herbOnlyResult() {
    const leaf = plan.hoLeaf || 'noCauldron';
    const herbs = C.herbItems(D).filter(h => (plan.herbCore || h !== 'WorldTreeCore') && (leaf !== 'none' || h !== 'WorldTreeLeaf'));
    const noCauldron = [...(leaf === 'noCauldron' ? ['WorldTreeLeaf'] : []), ...(plan.hoCoin !== false ? ['CopperCoin'] : [])];
    const priority = plan.hoPriority || 'space';
    const force = plan.hoForce || {};
    const key = JSON.stringify([plan.targets, plan.research, plan.machines, plan.fertilizer, plan.fuel, herbs, noCauldron, priority, force]);
    if (hoCache.key !== key) hoCache = { key, res: C.solveHerbOnly(D, plan, IDX, { herbs, noCauldron, priority, force }) };
    return hoCache.res;
  }

  /** Nutrient points produced by fertilizer targets versus points consumed growing the herbs. */
  function fertBalance(res) {
    const eff = res.ctx.fertEff;
    const made = Object.entries(res.targets).reduce((t2, [id, rate]) => t2 + rate * (D.items[id].nutrient || 0) * eff, 0);
    if (!made) return '';
    const net = made - res.nutrient;
    const ratio = res.nutrient > 0 ? made / res.nutrient : Infinity;
    return `<div class="stat ${net >= 0 ? 'fert-up' : 'fert-down'}"><div class="label">${esc(t('hoFertBalance'))}</div>
      <div class="value">×${isFinite(ratio) ? fmt(ratio) : '∞'}<small>${net >= 0 ? '+' : ''}${fmt(net)}pt${esc(t('hoPerMin'))}</small></div>
      <div class="extra">${esc(t('hoFertBalanceHint', { made: fmt(made), used: fmt(res.nutrient) }))}</div></div>`;
  }

  function renderHerbOnlyResults(el) {
    const res = herbOnlyResult();
    if (!res.ok) {
      let hint = '';
      if (res.reason === 'unreachable' && plan.hoCoin !== false) {
        const leaf = plan.hoLeaf || 'noCauldron';
        const herbs = C.herbItems(D).filter(h => (plan.herbCore || h !== 'WorldTreeCore') && (leaf !== 'none' || h !== 'WorldTreeLeaf'));
        const r2 = C.solveHerbOnly(D, plan, IDX, { herbs, noCauldron: leaf === 'noCauldron' ? ['WorldTreeLeaf'] : [], priority: plan.hoPriority });
        if (r2.ok) hint = `<br>${esc(t('hoCoinUnlock'))}`;
      }
      el.innerHTML = res.reason === 'unreachable'
        ? `<div class="alert">${esc(t('hoUnreachable', { items: res.missing.map(nm).join(', ') }))}${hint}</div>`
        : res.reason === 'forced'
          ? `<div class="alert">${esc(t('hoForcedInfeasible', { items: res.forced.map(nm).join(', ') }))} <button class="link-btn" data-ho-clear="1">${esc(t('hoClearForce'))}</button></div>`
          : `<div class="alert">${esc(t('hoInfeasible'))}</div>`;
      return;
    }
    const recipeSteps = res.steps.filter(s => s.method === 'recipe');
    const machineCount = recipeSteps.reduce((n, s) => n + Math.ceil(s.machines - 1e-9), 0);
    const cauldronCount = res.steps.filter(s => s.method === 'cauldron').reduce((n, s) => n + Math.ceil(s.machines - 1e-9), 0);
    const stat = (label, value, small = '', extra = '') => `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${value}<small>${esc(small)}</small></div>${extra}</div>`;
    const parts = [];
    if (res.split && res.split.length) parts.push(`<div class="alert">${esc(t('hoSplitWarn', { items: res.split.map(nm).join(', ') }))}</div>`);
    parts.push(`<div class="summary">
      ${stat(t('hoSpace'), fmt(res.space), '', `<div class="extra">${esc(t('hoSpaceHint'))}</div>`)}
      ${stat(t('hoMachines'), machineCount, t('unitMachines'))}
      ${stat(t('hoCauldrons'), cauldronCount, t('unitMachines'), `<div class="extra">${esc(t('hoStacks', { n: Math.ceil(cauldronCount / 4) }))}</div>`)}
      ${stat(t('hoNutrient'), fmt(res.nutrient), t('hoPerMin'))}
      ${fertBalance(res)}
      ${stat(t('hoHerbs'), fmt(res.herbTotal), t('hoPerMin'))}
      ${stat(t('heatTotal'), fmt(res.heat), t('heatUnit'), res.fuel && res.heat > 0 ? `<div class="extra">${itemIco(res.fuel)}${esc(nm(res.fuel))} ${fmt(res.fuelPerMin)}${esc(t('perMin'))}</div>` : '')}
    </div>`);
    const isTarget = id => id in res.targets;
    const detail = s => s.method === 'cauldron'
      ? `<span class="badge">${esc(t('hoMethodCauldron'))}</span> <span class="inputs">${s.combo.map(id => `<span class="chip">${itemIco(id)}<span class="muted">${esc(nm(id))}</span></span>`).join('<span class="muted">+</span>')}</span>`
      : `<span class="badge teal">${esc(t('hoMethodRecipe'))}</span> ${esc(recipeLabel(IDX.recipeById[s.recipe]))}`;
    const comboKey = ids => 'cauldron:' + ids.slice().sort().join('+');
    const method = s => {
      const cur = (plan.hoForce || {})[s.item] || '';
      const opts = [['', t('hoAuto')]];
      if (isCdOutput(s.item)) {
        opts.push(['cauldron', t('hoForceCauldron')]);
        const combos = [];
        if (s.method === 'cauldron') combos.push(s.combo);
        const saved = plan.cauldron && plan.cauldron[s.item];
        if (saved && C.cauldronRecipe(D, s.item, saved)) combos.push(saved);
        if (cur.startsWith('cauldron:') && cur !== 'cauldron') combos.push(cur.slice(9).split('+'));
        const seen = new Set();
        for (const c of combos) {
          const k = comboKey(c);
          if (seen.has(k)) continue;
          seen.add(k);
          opts.push([k, `${t('hoMethodCauldron')}: ${c.map(nm).join(' + ')}`]);
        }
      }
      for (const r of IDX.byMain[s.item] || []) {
        if (r.type === 'Cauldron' || r.type === 'Plant') continue;
        opts.push(['recipe:' + r.id, `${t('hoMethodRecipe')}: ${recipeLabel(r)}`]);
      }
      const sel = `<select class="ho-force" data-ho-force="${s.item}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
      return `${sel}${s.forced ? ` <span class="badge pin">${esc(t('hoForced'))}</span>` : ''}<div class="ho-detail">${detail(s)}</div>`;
    };
    const machine = s => s.method === 'cauldron'
      ? `<span class="it sm">${ico(D.machines.Cauldron && D.machines.Cauldron.icon)}<span>${esc(mn('Cauldron'))}</span></span>`
      : machineCell(s);
    const body = ui.view === 'tree' ? renderTree(res) : `<div class="table-wrap"><table class="line">
      <thead><tr><th>${esc(t('colItem'))}</th><th class="num">${esc(t('colRate'))}</th><th>${esc(t('colRecipe'))}</th><th>${esc(t('colMachine'))}</th>
      <th class="num">${esc(t('colCount'))}</th><th>${esc(t('colInputs'))}</th><th class="num">${esc(t('colHeat'))}</th></tr></thead>
      <tbody>${res.steps.map(s => `<tr class="${isTarget(s.item) ? 'target-row' : ''}">
        <td>${itemTag(s.item)}</td>
        <td class="num"><b>${fmt(s.rate)}</b></td>
        <td class="ho-method">${method(s)}</td>
        <td>${machine(s)}</td>
        <td class="num count">${fmt(s.machines)}<span class="ceil">(${Math.ceil(s.machines - 1e-9)})</span></td>
        <td><div class="inputs">${s.inputs.map(i => chip(i.item, i.rate)).join('')}</div></td>
        <td class="num">${s.heat ? fmt(s.heat) : '<span class="muted">—</span>'}</td>
      </tr>`).join('')}</tbody></table></div>`;
    const nForced = Object.keys(plan.hoForce || {}).length;
    parts.push(`<div class="card"><div class="section-head"><h2>${esc(t('productionLine'))}</h2>
      ${nForced ? `<button class="link-btn" data-ho-clear="1">${esc(t('hoClearForce'))} (${nForced})</button>` : ''}
      <div class="seg"><button data-view="table" aria-pressed="${ui.view !== 'tree'}">${esc(t('tableView'))}</button><button data-view="tree" aria-pressed="${ui.view === 'tree'}">${esc(t('treeView'))}</button></div></div>${body}</div>`);
    const herbsHtml = `<div class="chip-list">${res.raw.map(r => {
      const g = r.growers;
      const sub = [r.nutrient ? `${t('hoNutrient')} ${fmt(r.nutrient)}${t('hoPerMin')}` : '', g ? `${mn(g.machine)} × ${fmt(g.count)} (${Math.ceil(g.count - 1e-9)})` : ''].filter(Boolean).join(' · ');
      return pill(r.item, r.rate, esc(sub));
    }).join('')}</div>`;
    const surplusHtml = res.surplus.length ? `<div class="chip-list">${res.surplus.map(r => pill(r.item, r.rate)).join('')}</div>` : `<p class="muted">${esc(t('none'))}</p>`;
    parts.push(`<div class="grid-2"><div class="card"><h2>${esc(t('hoHerbsNeeded'))}</h2><div style="margin-top:10px">${herbsHtml}</div></div>
      <div class="card"><h2>${esc(t('surplus'))}</h2><div style="margin-top:10px">${surplusHtml}</div></div></div>`);
    el.innerHTML = parts.join('');
  }

  function renderResults() {
    const el = $('#results');
    const active = plan.targets.filter(x => x.item && +x.rate > 0);
    if (!active.length) {
      el.innerHTML = `<div class="empty-state">${ico('icons/T_UI_Athanor.png')}<p>${esc(t('emptyPlan'))}</p></div>`;
      return;
    }
    if (plan.herbOnly) { renderHerbOnlyResults(el); return; }
    const res = C.solve(D, plan, IDX);
    const totalMachines = res.steps.reduce((s, x) => s + Math.ceil(x.machines - 1e-9), 0);
    const parts = [];
    if (!res.ok) parts.push(`<div class="alert">${esc(t('notConverged'))}</div>`);

    // summary
    const fuelExtra = res.fuel && res.heat > 0 ? `<div class="extra">${itemIco(res.fuel)}${esc(nm(res.fuel))}</div>` : '';
    const fertExtra = res.fertilizer && res.fertilizerPerMin > 0 ? `<div class="extra">${itemIco(res.fertilizer)}${esc(nm(res.fertilizer))}</div>` : '';
    parts.push(`<div class="summary">
      <div class="stat"><div class="label">${esc(t('totalMachines'))}</div><div class="value">${totalMachines}</div></div>
      <div class="stat"><div class="label">${esc(t('heatTotal'))}</div><div class="value">${fmt(res.heat)}<small>${esc(t('heatUnit'))}</small></div></div>
      <div class="stat"><div class="label">${esc(t('fuelUse'))}</div><div class="value">${res.fuel ? fmt(res.fuelPerMin) : '—'}<small>${esc(t('perMin'))}</small></div>${fuelExtra}</div>
      <div class="stat"><div class="label">${esc(t('fertUse'))}</div><div class="value">${res.fertilizer ? fmt(res.fertilizerPerMin) : '—'}<small>${esc(t('perMin'))}</small></div>${fertExtra}</div>
      <div class="stat"><div class="label">${esc(t('rawCount'))}</div><div class="value">${res.raw.length}</div></div>
    </div>`);

    // production line
    const isTarget = id => id in res.targets;
    const body = ui.view === 'tree' ? renderTree(res) : `<div class="table-wrap"><table class="line">
      <thead><tr><th>${esc(t('colItem'))}</th><th class="num">${esc(t('colRate'))}</th><th>${esc(t('colRecipe'))}</th><th>${esc(t('colMachine'))}</th>
      <th class="num">${esc(t('colCount'))}</th><th>${esc(t('colInputs'))}</th><th class="num">${esc(t('colHeat'))}</th><th class="num" title="${esc(t('beltCap'))}: ${fmt(res.ctx.belt)}${esc(t('perMin'))}">${esc(t('colBelt'))}</th></tr></thead>
      <tbody>${res.steps.map(s => `<tr class="${isTarget(s.item) ? 'target-row' : ''}">
        <td>${itemTag(s.item)}</td>
        <td class="num"><b>${fmt(s.rate)}</b></td>
        <td>${recipeSelect(s.item)}</td>
        <td>${machineCell(s)}</td>
        <td class="num count">${fmt(s.machines)}<span class="ceil">(${Math.ceil(s.machines - 1e-9)})</span></td>
        <td><div class="inputs">${s.inputs.map(i => chip(i.item, i.rate)).join('')}${s.fertilizer ? chip(plan.fertilizer, s.fertilizer) : ''}</div></td>
        <td class="num">${s.heat ? fmt(s.heat) : '<span class="muted">—</span>'}</td>
        <td class="num muted">${fmt(s.rate / res.ctx.belt)}</td>
      </tr>`).join('')}</tbody></table></div>`;
    parts.push(`<div class="card"><div class="section-head"><h2>${esc(t('productionLine'))}</h2>
      <div class="seg"><button data-view="table" aria-pressed="${ui.view !== 'tree'}">${esc(t('tableView'))}</button><button data-view="tree" aria-pressed="${ui.view === 'tree'}">${esc(t('treeView'))}</button></div></div>${body}</div>`);

    // raw + surplus
    const rawHtml = res.raw.length ? `<div class="chip-list">${res.raw.map(r => {
      const can = (IDX.byMain[r.item] || []).length > 0 || isCdOutput(r.item);
      const sub = D.items[r.item].frac > 1 ? esc(t('fractionHint', { n: D.items[r.item].frac })) : '';
      return pill(r.item, r.rate, sub, can ? `<button class="link-btn" data-make="${r.item}">${esc(t('makeIt'))}</button>` : '');
    }).join('')}</div>` : `<p class="muted">${esc(t('none'))}</p>`;
    const surplusHtml = res.surplus.length ? `<div class="chip-list">${res.surplus.map(r => pill(r.item, r.rate)).join('')}</div>` : `<p class="muted">${esc(t('none'))}</p>`;
    parts.push(`<div class="grid-2"><div class="card"><h2>${esc(t('rawInputs'))}</h2><div style="margin-top:10px">${rawHtml}</div></div>
      <div class="card"><h2>${esc(t('surplus'))}</h2><div style="margin-top:10px">${surplusHtml}</div></div></div>`);
    el.innerHTML = parts.join('');
  }

  function renderTree(res) {
    const byItem = Object.fromEntries(res.steps.map(s => [s.item, s]));
    const node = (item, rate, path, depth) => {
      const s = byItem[item];
      const label = `${itemTag(item, 'sm')} <b class="num">${fmt(rate)}</b><span class="node-meta">${esc(t('perMin'))}</span>`;
      if (!s || path.has(item) || s.rate <= 0) {
        return `<details class="leafwrap"><summary class="leaf">${label}${s ? '' : ` <span class="badge teal">${esc(t('rawInputs'))}</span>`}</summary></details>`;
      }
      const k = rate / s.rate;
      const p2 = new Set(path).add(item);
      const meta = `<span class="node-meta">${esc(mn(s.machine))} × ${fmt(s.machines * k)}</span>`;
      const kids = s.inputs.map(i => node(i.item, i.rate * k, p2, depth + 1)).join('');
      return `<details ${depth < 3 ? 'open' : ''}><summary>${label} ${meta}</summary>${kids}</details>`;
    };
    return `<div class="tree">${Object.entries(res.targets).map(([item, rate]) => node(item, rate, new Set(), 0)).join('')}</div>`;
  }

  // ------------------------------------------------------------------ item picker
  let pickerCb = null, pickerTag = '', pickerActive = 0, pickerOpts = {};
  /** opts: { filter(id) -> bool, label(id) -> extra text, sort(a, b) on ids, clear: bool } */
  function openPicker(anchor, cb, opts = {}) {
    pickerCb = cb;
    pickerOpts = opts;
    const p = $('#picker');
    p.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = p.offsetWidth, h = p.offsetHeight;
    p.style.left = Math.max(12, Math.min(r.left, innerWidth - w - 12)) + 'px';
    p.style.top = (r.bottom + 6 + h > innerHeight ? Math.max(12, r.top - h - 6) : r.bottom + 6) + 'px';
    $('#picker-search').value = '';
    pickerTag = '';
    renderPickerTags();
    renderPickerList();
    $('#picker-search').focus();
  }
  function closePicker() { $('#picker').hidden = true; pickerCb = null; }
  function matches(id, q) {
    if (!q) return true;
    q = q.toLowerCase();
    const it = D.items[id];
    return id.toLowerCase().includes(q) || Object.values(it.name).some(n => n.toLowerCase().includes(q));
  }
  function pickerItems() {
    let list = visibleItems();
    if (pickerOpts.filter) list = list.filter(([id]) => pickerOpts.filter(id));
    if (pickerOpts.sort) list = list.slice().sort((a, b) => pickerOpts.sort(a[0], b[0]));
    return list;
  }
  function renderPickerTags() {
    const tags = [...new Set(pickerItems().flatMap(([, it]) => it.tags))];
    $('#picker-tags').innerHTML = `<button data-ptag="" aria-pressed="${!pickerTag}">${esc(t('allTags'))}</button>` +
      tags.map(tg => `<button data-ptag="${tg}" aria-pressed="${pickerTag === tg}">${esc(pick(D.tags[tg]) || tg)}</button>`).join('');
  }
  function renderPickerList() {
    const q = $('#picker-search').value.trim();
    const list = pickerItems().filter(([id, it]) => matches(id, q) && (!pickerTag || it.tags.includes(pickerTag)));
    pickerActive = Math.min(pickerActive, Math.max(0, list.length - 1));
    const extra = id => pickerOpts.label ? `<small class="pick-val">${esc(pickerOpts.label(id))}</small>` : '';
    $('#picker-list').innerHTML = (pickerOpts.clear ? `<button class="pick clear-pick" data-pick="__clear">✕ <span>${esc(t('clear'))}</span></button>` : '') +
      list.map(([id, it], i) =>
        `<button class="pick ${i === pickerActive ? 'active' : ''}" data-pick="${id}" role="option" title="${esc(nm(id))}">${ico(it.icon)}<span>${esc(nm(id))}${extra(id)}</span></button>`).join('');
  }

  // ------------------------------------------------------------------ browser
  function renderBrowserTags() {
    const tags = [...new Set(visibleItems().flatMap(([, it]) => it.tags))];
    $('#db-tags').innerHTML = `<button data-tag="" aria-pressed="${!ui.dbTag}">${esc(t('allTags'))}</button>` +
      tags.map(tg => `<button data-tag="${tg}" aria-pressed="${ui.dbTag === tg}">${esc(pick(D.tags[tg]) || tg)}</button>`).join('');
  }
  function renderBrowserGrid() {
    const q = ui.dbQuery.trim();
    $('#db-grid').innerHTML = visibleItems().filter(([id, it]) => matches(id, q) && (!ui.dbTag || it.tags.includes(ui.dbTag)))
      .map(([id, it]) => `<button class="db-card ${ui.dbItem === id ? 'active' : ''}" data-db="${id}">${ico(it.icon)}<span>${esc(nm(id))}</span></button>`).join('');
  }
  function recipeCard(r) {
    const st = C.recipeStats(D, IDX, plan, r);
    const m = D.machines[st.machine];
    const p = o => o.p != null && o.p < 1 ? ` <span class="badge">${fmt(o.p * 100)}%</span>` : '';
    return `<div class="recipe-card">
      <div class="rc-head">${ico(m && m.icon)}<b>${esc(mn(st.machine))}</b>${r.alt ? `<span class="badge">${esc(t('alt'))}</span>` : ''}
        <span>· ${fmt(st.seconds)}${esc(t('seconds'))} · ${esc(t('perMachine'))} (${esc(t('perMin'))})</span></div>
      <div class="rc-body">${st.inputs.map(i => chip(i.item, i.rate)).join('')}<span class="arrow">→</span>${st.outputs.map(o => chip(o.item, o.rate, p(o))).join('')}</div>
    </div>`;
  }
  function renderBrowserDetail() {
    const el = $('#db-detail');
    const id = ui.dbItem;
    if (!id || !D.items[id]) { el.innerHTML = ''; return; }
    const it = D.items[id];
    const made = (IDX.byMain[id] || []);
    const madeAlso = D.recipes.filter(r => !r.hidden && r.main !== id && r.out.some(o => o.item === id));
    const used = (IDX.usedIn[id] || []);
    const kv = [
      [t('value'), fmt(it.value)],
      it.cauldron && it.cauldron.cost > 0 && !it.liquid ? [t('cauldron') + ' (' + t('value') + ')', fmt(it.cauldron.cost)] : null,
      it.heat ? [t('heatValue'), fmt(it.heat)] : null,
      it.nutrient ? [t('nutrient'), `${fmt(it.nutrient)}V · ${fmt(it.nutrientSpeed)}V/s`] : null,
      it.frac > 1 ? [t('fraction'), `${it.frac} — ${t('fractionHint', { n: it.frac })}`] : null,
    ].filter(Boolean);
    el.innerHTML = `
      <button class="btn-ghost detail-close" data-close-detail="1" aria-label="${esc(t('remove'))}">✕</button>
      <div class="detail-head">${ico(it.icon)}<div><h2>${esc(nm(id))}</h2>
        <div class="tag-row">${it.tags.map(tg => `<span class="badge teal">${esc(pick(D.tags[tg]) || tg)}</span>`).join('')}</div></div></div>
      <dl class="kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <button class="btn" data-plan="${id}">＋ ${esc(t('addToPlanner'))}</button>
      <h3 style="margin-top:14px">${esc(t('madeBy'))}</h3>
      ${made.concat(madeAlso).map(recipeCard).join('')}
      ${isCdOutput(id) ? `<div class="recipe-card"><div class="rc-head">${ico(D.machines.Cauldron && D.machines.Cauldron.icon)}<b>${esc(t('cauldron'))}</b>
        <span>· ${esc(t('cdRange'))}: ${fmt(CI.ranges[id].min)} 〜 ${isFinite(CI.ranges[id].max) ? fmt(CI.ranges[id].max) : '∞'}</span></div>
        <button class="link-btn" data-cd-lookup="${id}">${esc(t('cdRevTitle'))} →</button></div>` : ''}
      ${made.length || madeAlso.length || isCdOutput(id) ? '' : `<p class="muted">${esc(t('noRecipe'))}</p>`}
      <h3 style="margin-top:14px">${esc(t('usedIn'))}</h3>
      ${used.map(recipeCard).join('') || `<p class="muted">${esc(t('none'))}</p>`}`;
  }

  // ------------------------------------------------------------------ cauldron
  const CI = C.cauldronIndex(D);
  const CD_DEFAULT = { slots: ['', '', ''], target: '', out: '', req: ['', ''], exc: ['', ''], mode: 'any', sort: 'value', tags: [] };
  const cd = { ...clone(CD_DEFAULT), ...store.get('af.cauldron', {}) };
  const saveCd = () => store.set('af.cauldron', cd);
  const isCdInput = id => !!CI.inputById[id];
  const isCdOutput = id => !!CI.ranges[id];
  const cdCost = id => (CI.inputById[id] ? CI.inputById[id].cost : 0);
  const cdTarget = id => (D.items[id] && D.items[id].cauldron ? D.items[id].cauldron.target : 0);
  const inputPicker = { filter: isCdInput, label: id => fmt(cdCost(id)), sort: (a, b) => cdCost(a) - cdCost(b), clear: true };
  const outputPicker = { filter: isCdOutput, label: id => fmt(cdTarget(id)), sort: (a, b) => cdTarget(a) - cdTarget(b), clear: true };
  let cdLast = { key: '', res: null };

  /** Current planner combo for a cauldron output: the saved one if it still produces the item, else the cheapest. */
  function cauldronCombo(item) {
    const saved = plan.cauldron && plan.cauldron[item];
    if (saved && C.cauldronRecipe(D, item, saved)) return { inputs: saved, auto: false };
    return { inputs: C.cauldronBest(D, item), auto: true };
  }
  function cauldronLabel(item) {
    const c = cauldronCombo(item);
    if (!c.inputs) return t('cauldron');
    return `${t('cauldron')}: ${c.inputs.map(nm).join(' + ')}${c.auto ? ` (${t('cdAuto')})` : ''}`;
  }

  function cdSlotBtn(id, attrs, placeholder) {
    return id
      ? `<button class="item-btn" ${attrs} title="${esc(nm(id))}">${itemIco(id)}<span>${esc(nm(id))}</span></button>`
      : `<button class="item-btn empty" ${attrs}><span>${esc(placeholder)}</span></button>`;
  }

  function renderCdSlots() {
    $('#cd-slots').innerHTML = cd.slots.map((id, i) => `
      <div class="cd-slot ${id ? '' : 'empty'}">
        <div class="cd-slot-head">${esc(t('cdSlot', { n: i + 1 }))}${i === 2 ? ` <span class="muted">${esc(t('cdOptional'))}</span>` : ''}</div>
        <button class="cd-slot-main" data-cd-slot="${i}">
          ${id ? `${itemIco(id)}<span class="nm">${esc(nm(id))}</span><span class="val">${fmt(cdCost(id))}</span>`
            : `<span class="plus">＋</span><span class="nm muted">${esc(t('cdEmptySlot'))}</span>`}
        </button>
        <div class="cd-slot-tools">${id ? `<button class="btn-ghost" data-cd-step="${i}" data-dir="-1" aria-label="prev">◀</button>
          <button class="btn-ghost" data-cd-step="${i}" data-dir="1" aria-label="next">▶</button>
          <button class="btn-ghost" data-cd-clear="${i}" aria-label="${esc(t('clear'))}">✕</button>` : ''}</div>
      </div>${i < 2 ? '<div class="cd-op">＋</div>' : ''}`).join('');
    $('#cd-target-btn').outerHTML = cdSlotBtn(cd.target, 'id="cd-target-btn"', t('cdTargetNone'));
  }

  function valueBar(outId, T) {
    const r = CI.ranges[outId];
    const target = cdTarget(outId);
    const loT = r.lower ? cdTarget(r.lower) : 0;
    const hiT = r.upper ? cdTarget(r.upper) : Math.max(target * 1.5, r.min * 2, target + 1);
    let a = loT, b = hiT;
    if (T != null) { a = Math.min(a, T); b = Math.max(b, T); }
    const pad = (b - a) * 0.05;
    a = Math.max(0, a - pad);
    b += pad;
    const pos = v => (Math.min(Math.max(v, a), b) - a) / (b - a) * 100;
    const zl = pos(r.min), zr = pos(Math.min(r.max, b));
    const tick = (v, cls, label) => `<div class="cd-tick ${cls}" style="left:${pos(v).toFixed(2)}%"><span>${label}</span></div>`;
    const hit = T != null && T >= r.min && T < r.max;
    return `<div class="cd-bar">
      <div class="cd-track">
        <div class="cd-zone" style="left:${zl.toFixed(2)}%;width:${Math.max(0.5, zr - zl).toFixed(2)}%"></div>
        ${r.lower ? tick(loT, 'nb', fmt(loT)) : ''}
        ${tick(target, 'tg', fmt(target))}
        ${r.upper ? tick(hiT, 'nb', fmt(hiT)) : ''}
        ${T != null ? `<div class="cd-marker ${hit ? 'hit' : 'miss'}" style="left:${pos(T).toFixed(2)}%"><span>${fmt(T)}</span></div>` : ''}
      </div>
      <div class="cd-bar-legend">
        <span>${r.lower ? itemTag(r.lower, 'sm') : ''}</span>
        <span class="muted">${esc(t('cdRange'))}: <b>${fmt(r.min)}</b> 〜 <b>${isFinite(r.max) ? fmt(r.max) : '∞'}</b></span>
        <span>${r.upper ? itemTag(r.upper, 'sm') : ''}</span>
      </div>
    </div>`;
  }

  function cdSuggestions(result) {
    if (!cd.target || cd.target === result) return '';
    const filled = cd.slots.filter(Boolean);
    let base, label;
    if (filled.length === 2) { base = filled; label = t('cdSuggest'); }
    else if (filled.length === 3) { base = cd.slots.slice(0, 2); label = t('cdSuggestReplace'); }
    else return '';
    const slot = filled.length === 2 ? cd.slots.findIndex(x => !x) : 2;
    const list = CI.inputs.filter(x => { const m = C.cauldronMix(D, [...base, x.id]); return m && m.result === cd.target; })
      .sort((x, y) => D.items[x.id].value - D.items[y.id].value).slice(0, 40);
    return `<h3>${esc(label)}</h3>${list.length ? `<div class="chip-list">${list.map(x =>
      `<button class="cd-sugg" data-cd-fill="${slot}" data-item="${x.id}" title="${esc(nm(x.id))}">${itemIco(x.id)}<span>${esc(nm(x.id))}</span><small>${fmt(x.cost)}</small></button>`).join('')}</div>`
      : `<p class="muted">${esc(t('cdNoSuggest'))}</p>`}`;
  }

  function renderCdResult() {
    const el = $('#cd-result');
    const ids = cd.slots.filter(Boolean);
    if (ids.length < 2) {
      el.innerHTML = `<div class="cd-empty muted">${esc(t('cdNeedTwo'))}</div>${cd.target ? valueBar(cd.target, null) : ''}`;
      return;
    }
    const m = C.cauldronMix(D, ids);
    if (!m) { el.innerHTML = `<div class="cd-empty muted">${esc(t('cdNoResult'))}</div>`; return; }
    const ctx = C.context(D, plan);
    const time = m.time / ctx.factory, heat = m.heat * ctx.factory;
    let formula;
    if (m.kind === 'diff2') formula = `${fmt(Math.max(...m.costs))} − ${fmt(Math.min(...m.costs))} = ${fmt(m.T)}`;
    else if (m.kind === 'same2') formula = `${fmt(m.costs[0])} → ${fmt(m.target)}`;
    else formula = `${m.mult !== 1 ? '(' : ''}${m.costs.map(fmt).join(' + ')}${m.mult !== 1 ? `) × ${m.mult}` : ''} = ${fmt(m.T)}`;
    const ok = cd.target && cd.target === m.result;
    const status = cd.target
      ? (ok ? `<div class="cd-status ok">✓ ${esc(t('cdTargetOk'))}</div>`
        : `<div class="cd-status miss">${esc(t('cdTargetMiss', { name: nm(cd.target), min: fmt(CI.ranges[cd.target].min), max: isFinite(CI.ranges[cd.target].max) ? fmt(CI.ranges[cd.target].max) : '∞' }))}</div>`)
      : '';
    const dist = m.distance;
    el.innerHTML = `
      <div class="cd-formula">${formula}</div>
      <div class="cd-out">
        ${ico(D.items[m.result].icon)}
        <div class="cd-out-meta">
          <span class="muted small">${esc(t('cdResult'))}</span>
          <b class="cd-out-name">${esc(nm(m.result))}</b>
          <span class="small">${esc(t('cdTargetValue'))} ${fmt(m.target)} · ${esc(t('cdDistance'))} <b class="${Math.abs(dist) < 1e-9 ? '' : 'acc'}">${dist > 0 ? '+' : ''}${fmt(dist)}</b></span>
        </div>
      </div>
      <div class="cd-stats">
        <div><span class="muted">${esc(t('cdTime'))}</span><b>${fmt(time)}${esc(t('seconds'))}</b><small>${fmt(60 / time)}${esc(t('perMin'))}</small></div>
        <div><span class="muted">${esc(t('cdHeat'))}</span><b>${fmt(heat)}</b><small>${esc(t('heatUnit'))}</small></div>
        <div><span class="muted">${esc(t('cdHeatTotal'))}</span><b>${fmt(heat * time)}</b><small>${esc(t('cdFactoryNote', { p: fmt(ctx.factory * 100) }))}</small></div>
      </div>
      ${status}
      ${valueBar(cd.target || m.result, ids.length === 3 ? m.T : null)}
      ${cdSuggestions(m.result)}
      <div class="cd-actions">
        ${ids.length === 3 ? `<button class="btn" data-cd-use="${m.result}" data-inputs="${ids.join(',')}">${esc(t('cdUseInPlanner'))}</button>` : ''}
        <button class="btn-ghost small" data-plan="${m.result}">＋ ${esc(t('cdAddTarget'))}</button>
      </div>`;
  }

  function renderCdRev() {
    $('#cd-out-btn').outerHTML = cdSlotBtn(cd.out, 'id="cd-out-btn"', t('selectItem'));
    document.querySelectorAll('[data-cd-req]').forEach(b => { b.outerHTML = cdSlotBtn(cd.req[+b.dataset.cdReq], `data-cd-req="${b.dataset.cdReq}"`, '—'); });
    document.querySelectorAll('[data-cd-exc]').forEach(b => { b.outerHTML = cdSlotBtn(cd.exc[+b.dataset.cdExc], `data-cd-exc="${b.dataset.cdExc}"`, '—'); });
    $('#cd-mode').value = cd.mode;
    $('#cd-sort').value = cd.sort;
    const tags = [...new Set(CI.inputs.flatMap(x => x.tags))];
    $('#cd-tags').innerHTML = `<button data-cd-tag="" aria-pressed="${!cd.tags.length}">${esc(t('allTags'))}</button>` +
      tags.map(tg => `<button data-cd-tag="${tg}" aria-pressed="${cd.tags.includes(tg)}">${esc(pick(D.tags[tg]) || tg)}</button>`).join('');
    const el = $('#cd-rev-results');
    if (!cd.out) { el.innerHTML = `<p class="muted">${esc(t('cdSelectOutput'))}</p>`; return; }
    const key = JSON.stringify([cd.out, cd.req, cd.exc, cd.mode, cd.sort, cd.tags]);
    if (cdLast.key !== key) cdLast = { key, res: C.cauldronSearch(D, cd.out, { mode: cd.mode, require: cd.req, exclude: cd.exc, tags: cd.tags, sort: cd.sort, limit: 100 }) };
    const r = cdLast.res;
    const mat = id => `<span class="chip" title="${esc(nm(id))}">${itemIco(id)}<span>${esc(nm(id))}</span><small class="muted">${fmt(cdCost(id))}</small></span>`;
    el.innerHTML = `${valueBar(cd.out, null)}
      <p class="muted small">${esc(t('cdFound', { n: r.total.toLocaleString(), m: r.list.length }))}</p>
      ${r.list.length ? `<div class="table-wrap"><table class="line cd-rev-table"><thead><tr>
        <th>${esc(t('cdMaterials'))}</th><th class="num">${esc(t('cdSum'))}</th><th class="num">${esc(t('cdDistance'))}</th><th class="num">${esc(t('cdMatValue'))}</th><th></th></tr></thead>
        <tbody>${r.list.map(x => `<tr>
          <td><div class="inputs">${x.inputs.map(mat).join('')}</div></td>
          <td class="num">${fmt(x.T)}</td>
          <td class="num">${x.distance > 0 ? '+' : ''}${fmt(x.distance)}</td>
          <td class="num">${fmt(x.value)}</td>
          <td class="num"><button class="link-btn" data-cd-try="${x.inputs.join(',')}">${esc(t('cdTry'))}</button>
            <button class="link-btn" data-cd-use="${cd.out}" data-inputs="${x.inputs.join(',')}">${esc(t('cdUse'))}</button></td>
        </tr>`).join('')}</tbody></table></div>` : ''}`;
  }

  function renderCdTable() {
    const ctx = C.context(D, plan);
    $('#cd-table').innerHTML = `<table class="line"><thead><tr><th>${esc(t('colItem'))}</th><th class="num">${esc(t('cdTargetValue'))}</th>
      <th class="num">${esc(t('cdRange'))}</th><th class="num">${esc(t('cdTime'))}</th><th class="num">${esc(t('cdHeat'))}</th><th></th></tr></thead>
      <tbody>${CI.outputs.map(o => {
        const r = CI.ranges[o.id], tm = C.cauldronTiming(o.target);
        return `<tr><td>${itemTag(o.id)}</td><td class="num">${fmt(o.target)}</td>
          <td class="num">${fmt(r.min)} 〜 ${isFinite(r.max) ? fmt(r.max) : '∞'}</td>
          <td class="num">${fmt(tm.time / ctx.factory)}${esc(t('seconds'))}</td><td class="num">${fmt(tm.heat * ctx.factory)}</td>
          <td class="num"><button class="link-btn" data-cd-lookup="${o.id}">${esc(t('cdRevTitle').split(/[:：]/)[0])}</button></td></tr>`;
      }).join('')}</tbody></table>`;
  }

  function renderCauldron() { renderCdSlots(); renderCdResult(); renderCdRev(); renderHerb(); renderCdTable(); }

  function cdClick(b) {
    const d = b.dataset;
    if (d.cdSlot !== undefined) { const i = +d.cdSlot; openPicker(b, id => { cd.slots[i] = id; saveCd(); renderCauldron(); }, inputPicker); return true; }
    if (d.cdStep !== undefined) {
      const i = +d.cdStep, list = CI.inputs, k = list.findIndex(x => x.id === cd.slots[i]);
      cd.slots[i] = list[(k + (+d.dir) + list.length) % list.length].id;
      saveCd(); renderCdSlots(); renderCdResult(); return true;
    }
    if (d.cdClear !== undefined) { cd.slots[+d.cdClear] = ''; saveCd(); renderCdSlots(); renderCdResult(); return true; }
    if (d.cdFill !== undefined) { cd.slots[+d.cdFill] = d.item; saveCd(); renderCdSlots(); renderCdResult(); return true; }
    if (b.id === 'cd-target-btn') { openPicker(b, id => { cd.target = id; saveCd(); renderCdSlots(); renderCdResult(); }, outputPicker); return true; }
    if (b.id === 'cd-out-btn') { openPicker(b, id => { cd.out = id; saveCd(); renderCdRev(); }, outputPicker); return true; }
    if (d.cdReq !== undefined) { const i = +d.cdReq; openPicker(b, id => { cd.req[i] = id; saveCd(); renderCdRev(); }, inputPicker); return true; }
    if (d.cdExc !== undefined) { const i = +d.cdExc; openPicker(b, id => { cd.exc[i] = id; saveCd(); renderCdRev(); }, inputPicker); return true; }
    if (d.cdTag !== undefined) {
      if (!d.cdTag) cd.tags = [];
      else cd.tags = cd.tags.includes(d.cdTag) ? cd.tags.filter(x => x !== d.cdTag) : [...cd.tags, d.cdTag];
      saveCd(); renderCdRev(); return true;
    }
    if (d.cdTry) {
      cd.slots = d.cdTry.split(',');
      if (cd.out) cd.target = cd.out;
      saveCd(); renderCdSlots(); renderCdResult();
      document.querySelector('.cd-sim').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    }
    if (d.cdUse) {
      plan.cauldron = { ...(plan.cauldron || {}), [d.cdUse]: d.inputs.split(',') };
      plan.recipes[d.cdUse] = 'cauldron';
      if (plan.herbOnly) plan.hoForce = { ...(plan.hoForce || {}), [d.cdUse]: 'cauldron:' + d.inputs.split(',').sort().join('+') };
      update();
      toast(`${t('cdUsed')}: ${nm(d.cdUse)}`);
      return true;
    }
    if (d.cdLookup) {
      cd.out = d.cdLookup;
      cd.target = d.cdLookup;
      saveCd();
      ui.tab = 'cauldron';
      renderTabs(); renderCauldron();
      document.querySelector('.cd-rev').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    }
    if (d.cdEdit) {
      const c = cauldronCombo(d.cdEdit);
      cd.slots = c.inputs ? c.inputs.slice() : ['', '', ''];
      cd.target = d.cdEdit;
      cd.out = d.cdEdit;
      saveCd();
      ui.tab = 'cauldron';
      renderTabs(); renderCauldron();
      return true;
    }
    if (b.id === 'cd-reset') { cd.slots = ['', '', '']; cd.target = ''; saveCd(); renderCdSlots(); renderCdResult(); return true; }
    return false;
  }

  // ------------------------------------------------------------------ herb route finder
  const ALL_HERBS = C.herbItems(D).sort((a, b) => cdCost(a) - cdCost(b));
  const DEFAULT_HERBS = ALL_HERBS.filter(id => cdCost(id) <= cdCost('WorldTreeLeaf') || !D.items.WorldTreeLeaf);
  const HB_METRICS = ['standard', 'nutrient', 'herbs', 'heat', 'time'];
  const hb = { target: '', herbs: DEFAULT_HERBS.slice(), metric: 'standard', allowTwo: false, alt: null, ...store.get('af.herb', {}) };
  if (!HB_METRICS.includes(hb.metric)) hb.metric = 'standard';
  delete hb.fertilizer;
  hb.herbs = hb.herbs.filter(id => ALL_HERBS.includes(id));
  const saveHb = () => store.set('af.herb', hb);
  let hbCache = { key: '', routes: null };
  function hbRoutes() {
    const key = JSON.stringify([hb.herbs.slice().sort(), hb.metric, hb.allowTwo]);
    if (hbCache.key !== key) {
      hbCache = { key, routes: C.herbRoutes(D, { herbs: hb.herbs, metric: hb.metric, allowTwo: hb.allowTwo }) };
    }
    return hbCache.routes;
  }
  /** Routes with the final mix of the target replaced by a user-chosen alternative. */
  function hbEffectiveRoutes() {
    const routes = hbRoutes();
    if (!hb.alt || !hb.target || !routes.best[hb.target]) return routes;
    const m = C.cauldronMix(D, hb.alt);
    if (!m || m.result !== hb.target || hb.alt.some(id => !routes.best[id])) return routes;
    const b = routes.best;
    return { ...routes, best: { ...b, [hb.target]: { ...b[hb.target], combo: hb.alt } } };
  }

  const mixChips = ids => ids.map(id => `<span class="chip" title="${esc(nm(id))}">${itemIco(id)}<span>${esc(nm(id))}</span></span>`).join('<span class="muted">+</span>');

  function hbTree(node, depth) {
    const label = `${itemTag(node.item, 'sm')} <b class="num">×${fmt(node.qty)}</b>`;
    if (node.herb) return `<details class="leafwrap"><summary class="leaf">${label} <span class="badge teal">${esc(pick(D.tags.Herb) || 'Herb')}</span></summary></details>`;
    return `<details ${depth < 2 ? 'open' : ''}><summary>${label}</summary>${node.children.map(c => hbTree(c, depth + 1)).join('')}</details>`;
  }

  function renderHerb() {
    $('#hb-target-btn').outerHTML = cdSlotBtn(hb.target, 'id="hb-target-btn"', t('selectItem'));
    $('#hb-metric').value = hb.metric;
    $('#hb-two').checked = !!hb.allowTwo;
    $('#hb-herbs').innerHTML = ALL_HERBS.map(id => `<button data-hb-herb="${id}" aria-pressed="${hb.herbs.includes(id)}" title="${esc(nm(id))}">
      ${itemIco(id)}<span>${esc(nm(id))}</span><small>${fmt(cdCost(id))}${C.herbNutrient(D, id) ? ` · ${fmt(C.herbNutrient(D, id))}pt` : ''}</small></button>`).join('');
    const routes = hbEffectiveRoutes();
    const base = hbRoutes();
    const ctx = C.context(D, plan);
    // reachable list
    $('#hb-reach').innerHTML = `<table class="line"><thead><tr><th>${esc(t('colItem'))}</th><th class="num">${esc(t('hbBatches'))}</th>
      <th class="num">${esc(t('hbFert'))}</th><th class="num">${esc(t('hbHerbTotal'))}</th><th class="num">${esc(t('hbDepth'))}</th></tr></thead><tbody>${CI.outputs.map(o => {
        const r = base.best[o.id] ? C.herbRoute(D, base, o.id, ctx.factory) : null;
        return `<tr class="${r ? '' : 'muted'}"><td>${r ? `<button class="hb-pick" data-hb-pick="${o.id}">${itemTag(o.id)}</button>` : itemTag(o.id)}</td>
          <td class="num">${r ? fmt(r.batchTotal) : esc(t('hbNotReach'))}</td><td class="num">${r ? fmt(r.nutrient) : '—'}</td><td class="num">${r ? fmt(r.herbTotal) : '—'}</td><td class="num">${r ? r.depth : '—'}</td></tr>`;
      }).join('')}</tbody></table>`;
    const el = $('#hb-result');
    if (!hb.target) { el.innerHTML = `<p class="muted">${esc(t('hbSelectTarget'))}</p>`; return; }
    const r = C.herbRoute(D, routes, hb.target, ctx.factory);
    if (!r) { el.innerHTML = `<div class="cd-status miss">${esc(t('hbUnreachable'))}</div>`; return; }
    const stages = {};
    for (const s of r.steps) (stages[s.depth] = stages[s.depth] || []).push(s);
    const alts = C.herbAlternatives(D, base, hb.target, 8);
    const cur = routes.best[hb.target].combo.join(',');
    el.innerHTML = `
      <div class="summary hb-summary">
        <div class="stat"><div class="label">${esc(t('hbBatches'))}</div><div class="value">${fmt(r.batchTotal)}<small>${esc(t('hbUnit'))}</small></div></div>
        <div class="stat"><div class="label">${esc(t('hbFert'))}</div><div class="value">${fmt(r.nutrient)}<small>${esc(t('hbPts'))}</small></div></div>
        <div class="stat"><div class="label">${esc(t('hbHerbTotal'))}</div><div class="value">${fmt(r.herbTotal)}<small>${esc(t('hbPieces'))}</small></div></div>
        <div class="stat"><div class="label">${esc(t('hbHeat'))}</div><div class="value">${fmt(r.heat)}</div></div>
        <div class="stat"><div class="label">${esc(t('hbTime'))}</div><div class="value">${fmt(r.time / 60)}<small>${esc(t('perMin').replace('/', ''))}</small></div></div>
        <div class="stat"><div class="label">${esc(t('hbDepth'))}</div><div class="value">${r.depth}</div></div>
      </div>
      <h3>${esc(t('hbHerbsNeeded'))}</h3>
      <div class="chip-list">${Object.entries(r.herbs).sort((a, b) => cdCost(a[0]) - cdCost(b[0])).map(([id, n]) => pill(id, n, C.herbNutrient(D, id) ? esc(`${t('hbFert')} ${fmt(n * C.herbNutrient(D, id))}`) : '', '').replace(`<small class="muted"> ${t('perMin')}</small>`, `<small class="muted"> ${esc(t('hbPieces'))}</small>`)).join('')}</div>
      <h3>${esc(t('hbSteps'))}</h3>
      <ol class="hb-steps">${Object.keys(stages).sort((a, b) => a - b).map(d => `
        <li><div class="hb-stage">${esc(t('hbStage', { n: d }))}</div>${stages[d].map(s => `
          <div class="hb-step">${mixChips(s.combo)}<span class="arrow">→</span>${itemTag(s.item, 'sm')}
            <b class="hb-times">${esc(t('hbTimes', { n: fmt(s.n) }))}</b>
            <small class="muted">${fmt(s.time)}${esc(t('seconds'))} · ${fmt(s.heat)}${esc(t('heatUnit'))}</small>
            <button class="link-btn" data-hb-sim="${s.item}" data-combo="${s.combo.join(',')}">${esc(t('cdTry'))}</button></div>`).join('')}</li>`).join('')}
      </ol>
      <details class="hb-tree-wrap"><summary>${esc(t('hbTree'))}</summary><div class="tree">${hbTree(r.tree, 0)}</div></details>
      ${alts.length > 1 ? `<h3>${esc(t('hbAlts'))}</h3><div class="hb-alts">${alts.map((a, i) => {
        const rr = C.herbRoute(D, { ...base, best: { ...base.best, [hb.target]: { ...base.best[hb.target], combo: a.combo } } }, hb.target, ctx.factory);
        const on = a.combo.join(',') === cur;
        return `<div class="hb-alt ${on ? 'on' : ''}">${mixChips(a.combo)}
          <small class="muted">${esc(t('hbBatches'))} ${fmt(rr.batchTotal)} · ${esc(t('hbFert'))} ${fmt(rr.nutrient)} · ${esc(t('hbHerbTotal'))} ${fmt(rr.herbTotal)} · ${esc(t('hbTime'))} ${fmt(rr.time / 60)}${esc(t('perMin').replace('/', ''))} · ${esc(t('hbHeat'))} ${fmt(rr.heat)}</small>
          ${i === 0 ? `<span class="badge teal">${esc(t('hbBestBadge'))}</span>` : ''}
          ${on ? '' : `<button class="link-btn" data-hb-alt="${a.combo.join(',')}">${esc(t('hbShow'))}</button>`}</div>`;
      }).join('')}</div>` : ''}
      <div class="cd-actions">
        <button class="btn" data-hb-use="1">${esc(t('hbUseRoute'))}</button>
        <button class="btn-ghost small" data-hb-sim="${hb.target}" data-combo="${cur}">${esc(t('hbTrySim'))}</button>
      </div>`;
  }

  function hbClick(b) {
    const d = b.dataset;
    if (b.id === 'hb-target-btn') {
      openPicker(b, id => { hb.target = id; hb.alt = null; saveHb(); renderHerb(); }, { ...outputPicker, label: id => {
        const ok = hbRoutes().best[id];
        return ok ? `${fmt(cdTarget(id))}` : `${fmt(cdTarget(id))} · ${t('hbNotReach')}`;
      } });
      return true;
    }
    if (d.hbHerb) {
      hb.herbs = hb.herbs.includes(d.hbHerb) ? hb.herbs.filter(x => x !== d.hbHerb) : [...hb.herbs, d.hbHerb];
      hb.alt = null; saveHb(); renderHerb(); return true;
    }
    if (d.hbPick) { hb.target = d.hbPick; hb.alt = null; saveHb(); renderHerb(); $('#cd-herb').scrollIntoView({ behavior: 'smooth', block: 'start' }); return true; }
    if (d.hbSim) {
      cd.slots = d.combo.split(',');
      cd.target = d.hbSim;
      saveCd(); renderCdSlots(); renderCdResult();
      document.querySelector('.cd-sim').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    }
    if (d.hbAlt) { hb.alt = d.hbAlt.split(','); saveHb(); renderHerb(); return true; }
    if (d.hbUse) {
      const r = C.herbRoute(D, hbEffectiveRoutes(), hb.target);
      if (!r) return true;
      plan.cauldron = { ...(plan.cauldron || {}) };
      for (const s of r.steps) { plan.cauldron[s.item] = s.combo.slice(); plan.recipes[s.item] = 'cauldron'; }
      if (!plan.targets.some(x => x.item === hb.target)) {
        const empty = plan.targets.find(x => !x.item);
        if (empty) empty.item = hb.target; else plan.targets.push({ item: hb.target, rate: 1, unit: 'min' });
      }
      update();
      toast(t('hbRouteUsed'));
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ render all
  function renderTabs() {
    document.querySelectorAll('.tab-btn').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === ui.tab));
    $('#tab-planner').hidden = ui.tab !== 'planner';
    $('#tab-browser').hidden = ui.tab !== 'browser';
    $('#tab-cauldron').hidden = ui.tab !== 'cauldron';
  }
  function renderPlanner() { renderTargets(); renderResearch(); renderSelects(); renderPlans(); renderResults(); }
  function renderBrowser() { renderBrowserTags(); renderBrowserGrid(); renderBrowserDetail(); }
  function renderAll() { applyTexts(); renderTabs(); renderPlanner(); renderBrowser(); renderCauldron(); }
  function update() { persist(); renderTargets(); renderResearch(); renderSelects(); renderResults(); if (ui.tab === 'browser') renderBrowserDetail(); if (ui.tab === 'cauldron') { renderCdResult(); renderCdTable(); } }

  // ------------------------------------------------------------------ events
  document.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) {
      if (!$('#picker').hidden && !e.target.closest('#picker')) closePicker();
      return;
    }
    if (b.dataset.tab) { ui.tab = b.dataset.tab; renderTabs(); if (ui.tab === 'browser') renderBrowser(); if (ui.tab === 'cauldron') renderCauldron(); return; }
    if (b.dataset.pick) { const cb = pickerCb; closePicker(); if (cb) cb(b.dataset.pick === '__clear' ? '' : b.dataset.pick); return; }
    if (b.dataset.ptag !== undefined) { pickerTag = b.dataset.ptag; pickerActive = 0; renderPickerTags(); renderPickerList(); return; }
    if (!$('#picker').hidden && !b.closest('#picker')) closePicker();
    if (hbClick(b) || cdClick(b)) return;
    const row = b.closest('.target');
    if (row && b.dataset.act === 'pick-target') {
      const i = +row.dataset.i;
      openPicker(b, id => { plan.targets[i].item = id; update(); });
      return;
    }
    if (row && b.dataset.act === 'remove') {
      plan.targets.splice(+row.dataset.i, 1);
      if (!plan.targets.length) plan.targets.push({ item: '', rate: 10, unit: 'min' });
      update();
      return;
    }
    if (b.id === 'add-target') {
      plan.targets.push({ item: '', rate: 10, unit: 'min' });
      renderTargets();
      const btns = document.querySelectorAll('#targets .item-btn');
      const last = btns[btns.length - 1];
      openPicker(last, id => { plan.targets[plan.targets.length - 1].item = id; update(); });
      return;
    }
    if (b.id === 'reset-btn') { plan = clone(DEFAULT_PLAN); plan.targets.push({ item: '', rate: 10, unit: 'min' }); update(); return; }
    if (b.dataset.view) { ui.view = b.dataset.view; store.set('af.view', ui.view); renderResults(); return; }
    if (b.dataset.make) {
      const list = IDX.byMain[b.dataset.make] || [];
      plan.recipes[b.dataset.make] = list.length ? list[0].id : 'cauldron';
      update();
      return;
    }
    if (b.dataset.tag !== undefined) { ui.dbTag = b.dataset.tag; renderBrowserTags(); renderBrowserGrid(); return; }
    if (b.dataset.db) { ui.dbItem = b.dataset.db; renderBrowserGrid(); renderBrowserDetail(); $('#db-detail').scrollTop = 0; return; }
    if (b.dataset.closeDetail) { ui.dbItem = null; renderBrowserGrid(); renderBrowserDetail(); return; }
    if (b.dataset.plan) {
      const empty = plan.targets.find(x => !x.item);
      if (empty) empty.item = b.dataset.plan; else plan.targets.push({ item: b.dataset.plan, rate: 10, unit: 'min' });
      ui.tab = 'planner';
      renderTabs();
      update();
      return;
    }
    if (b.dataset.hoClear) { plan.hoForce = {}; update(); return; }
    if (b.id === 'theme-btn') {
      const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('af.theme', next); } catch (err) { /* ignore */ }
      return;
    }
    if (b.id === 'share-btn') {
      persist();
      const done = () => toast(t('copied'));
      if (navigator.clipboard) navigator.clipboard.writeText(location.href).then(done, () => prompt('URL', location.href));
      else prompt('URL', location.href);
      return;
    }
    if (b.id === 'save-plan') {
      const name = $('#plan-name').value.trim() || plan.targets.filter(x => x.item).map(x => nm(x.item)).join(', ') || 'plan';
      const plans = store.get('af.plans', {});
      plans[name] = compactPlan();
      store.set('af.plans', plans);
      $('#plan-name').value = '';
      renderPlans();
      toast(t('savePlan') + ': ' + name);
      return;
    }
    if (b.dataset.load) {
      const p = store.get('af.plans', {})[b.dataset.load];
      if (p) { plan = { ...clone(DEFAULT_PLAN), ...clone(p) }; if (!plan.targets.length) plan.targets.push({ item: '', rate: 10, unit: 'min' }); update(); }
      return;
    }
    if (b.dataset.del) {
      const plans = store.get('af.plans', {});
      delete plans[b.dataset.del];
      store.set('af.plans', plans);
      renderPlans();
    }
  });

  document.addEventListener('change', e => {
    const el = e.target;
    const row = el.closest('.target');
    if (row && el.dataset.act === 'unit') { plan.targets[+row.dataset.i].unit = el.value; update(); return; }
    if (el.dataset.recipe) { plan.recipes[el.dataset.recipe] = el.value; update(); return; }
    if (el.dataset.hoForce) {
      plan.hoForce = { ...(plan.hoForce || {}) };
      if (el.value) plan.hoForce[el.dataset.hoForce] = el.value; else delete plan.hoForce[el.dataset.hoForce];
      update();
      return;
    }
    if (el.dataset.machine) { plan.machines[el.dataset.machine] = el.value; update(); return; }
    if (el.id === 'fuel-select') { plan.fuel = el.value; update(); return; }
    if (el.id === 'fert-select') { plan.fertilizer = el.value; update(); return; }
    if (el.id === 'byp-select') { plan.byproducts = el.value; update(); return; }
    if (el.id === 'self-supply') { plan.selfSupply = el.checked; update(); return; }
    if (el.id === 'herb-only') { plan.herbOnly = el.checked; update(); return; }
    if (el.id === 'herb-core') { plan.herbCore = el.checked; update(); return; }
    if (el.id === 'ho-priority') { plan.hoPriority = el.value; update(); return; }
    if (el.id === 'ho-leaf') { plan.hoLeaf = el.value; update(); return; }
    if (el.id === 'ho-coin') { plan.hoCoin = el.checked; update(); return; }
    if (el.id === 'hb-metric') { hb.metric = el.value; hb.alt = null; saveHb(); renderHerb(); return; }
    if (el.id === 'hb-two') { hb.allowTwo = el.checked; hb.alt = null; saveHb(); renderHerb(); return; }
    if (el.id === 'cd-mode') { cd.mode = el.value; saveCd(); renderCdRev(); return; }
    if (el.id === 'cd-sort') { cd.sort = el.value; saveCd(); renderCdRev(); return; }
    if (el.id === 'lang-select') { ui.lang = el.value; store.set('af.lang', ui.lang); renderAll(); }
  });

  let inputTimer;
  document.addEventListener('input', e => {
    const el = e.target;
    const row = el.closest('.target');
    if (row && el.dataset.act === 'rate') {
      plan.targets[+row.dataset.i].rate = el.value;
      clearTimeout(inputTimer);
      inputTimer = setTimeout(() => { persist(); renderResults(); }, 120);
      return;
    }
    if (el.dataset.res) {
      plan.research[el.dataset.res] = Math.max(0, parseInt(el.value, 10) || 0);
      clearTimeout(inputTimer);
      inputTimer = setTimeout(() => {
        persist();
        const line = D.research[el.dataset.res];
        const v = C.researchValue(line, plan.research[el.dataset.res]);
        el.parentElement.querySelector('.val').textContent = el.dataset.res === 'logistics' ? `${fmt(v)}${t('perMin')}` : `${fmt(v)}%`;
        if (el.dataset.res === 'fertilizer') renderSelects();
        renderResults();
      }, 120);
      return;
    }
    if (el.id === 'picker-search') { pickerActive = 0; renderPickerList(); return; }
    if (el.id === 'db-search') { ui.dbQuery = el.value; renderBrowserGrid(); }
  });

  document.addEventListener('keydown', e => {
    if ($('#picker').hidden) return;
    const items = [...document.querySelectorAll('#picker-list .pick')];
    if (e.key === 'Escape') { closePicker(); return; }
    if (e.key === 'Enter' && items[pickerActive]) { e.preventDefault(); items[pickerActive].click(); return; }
    const cols = Math.max(1, Math.round($('#picker-list').clientWidth / 122));
    const move = { ArrowDown: cols, ArrowUp: -cols, ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (move && document.activeElement === $('#picker-search') && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) e.preventDefault();
    if (move && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || document.activeElement !== $('#picker-search'))) {
      pickerActive = Math.max(0, Math.min(items.length - 1, pickerActive + move));
      items.forEach((x, i) => x.classList.toggle('active', i === pickerActive));
      if (items[pickerActive]) items[pickerActive].scrollIntoView({ block: 'nearest' });
    }
  });

  renderAll();
  persist();
})();
