/* Production solver for the Alchemy Factory calculator. Pure functions, no DOM. */
(function (root) {
  'use strict';

  // Engine-side constants that are not exposed in the game data tables.
  const PARADOX_TYPE = 'Paradox';          // paradox crucible ignores factory efficiency
  const HEATER_IDLE = { Crucible: 0.4 };   // heat/s burned by the heater under a machine (default 1)
  const SKILL_TYPES = { Extract: 'alchemy', Distill: 'alchemy', AdDistill: 'alchemy' };

  /** Value of a research line at a level: base + sum of the per-level steps (last step repeats). */
  function researchValue(line, level) {
    let v = line.base;
    for (let i = 0; i < level; i++) v += line.steps[Math.min(i, line.steps.length - 1)];
    return v;
  }

  function buildIndex(data) {
    const byMain = {};
    const usedIn = {};
    for (const r of data.recipes) {
      if (r.hidden) continue;
      (byMain[r.main] = byMain[r.main] || []).push(r);
      for (const i of r.in) (usedIn[i.item] = usedIn[i.item] || []).push(r);
    }
    const machinesByType = {};
    for (const [id, m] of Object.entries(data.machines)) {
      for (const t of m.types) (machinesByType[t] = machinesByType[t] || []).push(id);
    }
    for (const list of Object.values(machinesByType)) list.sort((a, b) => data.machines[a].order - data.machines[b].order);
    const recipeById = Object.fromEntries(data.recipes.map(r => [r.id, r]));
    const plantBySeed = data.plants;
    const plantByProduct = {};
    for (const [seed, p] of Object.entries(data.plants)) plantByProduct[p.plant] = { seed, ...p };
    return { byMain, usedIn, machinesByType, recipeById, plantByProduct };
  }

  /** Default recipe: first visible non-alternate recipe; items with only alternates default to raw. */
  function defaultRecipe(idx, item) {
    const list = idx.byMain[item] || [];
    const main = list.find(r => !r.alt);
    return main ? main.id : 'raw';
  }

  function chosenRecipe(data, idx, plan, item) {
    const id = (plan.recipes && plan.recipes[item]) || defaultRecipe(idx, item);
    if (id === 'raw') return null;
    if (id === 'cauldron') {
      const combo = (plan.cauldron && plan.cauldron[item]) || cauldronBest(data, item);
      return cauldronRecipe(data, item, combo) || cauldronRecipe(data, item, cauldronBest(data, item));
    }
    const r = idx.recipeById[id];
    return r && !r.hidden && r.main === item ? r : (idx.byMain[item] || [])[0] || null;
  }

  function chosenMachine(data, idx, plan, type) {
    const list = idx.machinesByType[type] || [];
    const want = plan.machines && plan.machines[type];
    return list.includes(want) ? want : list[0];
  }

  function context(data, plan) {
    const r = plan.research || {};
    const lv = k => Math.max(0, parseInt(r[k], 10) || 0);
    const R = data.research;
    return {
      factory: researchValue(R.factory, lv('factory')) / 100,
      fuelEff: researchValue(R.fuel, lv('fuel')) / 100,
      fertEff: researchValue(R.fertilizer, lv('fertilizer')) / 100,
      alchemy: researchValue(R.alchemy, lv('alchemy')) / 100,
      belt: researchValue(R.logistics, lv('logistics')),
    };
  }

  // ------------------------------------------------------------------ cauldron
  // Craft time / heat by output target value: piecewise linear (community formula; the craft
  // times reproduce the four cauldron recipes shipped in DT_EnemyCrafting exactly).
  const CAULDRON_TIME = [[1, 100, 3, 6], [100, 1e3, 6, 12], [1e3, 1e4, 12, 24], [1e4, 1e6, 24, 60]];
  const CAULDRON_HEAT = [[1, 100, 1, 20], [100, 1e3, 20, 200], [1e3, 1e4, 200, 1500], [1e4, 1e6, 1500, 1e4]];
  const lerpTable = (tbl, v, fallback) => {
    for (const [a, b, c, d] of tbl) if (v >= a && v <= b) return c + (v - a) / (b - a) * (d - c);
    return fallback;
  };

  /** Base (factory efficiency 100%) craft seconds and heat/s of a cauldron batch producing `target` value. */
  function cauldronTiming(target) {
    return { time: lerpTable(CAULDRON_TIME, target, 3), heat: lerpTable(CAULDRON_HEAT, target, 1) };
  }

  const cauldronCache = new WeakMap();
  function cauldronIndex(data) {
    if (cauldronCache.has(data)) return cauldronCache.get(data);
    const outputs = Object.entries(data.items)
      .filter(([, it]) => it.cauldron && it.cauldron.coef > 0 && !it.hidden)
      .map(([id, it]) => ({ id, target: it.cauldron.target, coef: it.cauldron.coef, order: it.order }))
      .sort((a, b) => a.target - b.target || a.order - b.order);
    const inputs = Object.entries(data.items)
      .filter(([, it]) => it.cauldron && it.cauldron.cost > 0 && !it.liquid && !it.hidden)
      .map(([id, it]) => ({ id, cost: it.cauldron.cost, value: it.value, tags: it.tags, order: it.order }))
      .sort((a, b) => a.cost - b.cost || a.order - b.order);
    // value window [min, max) in which each output wins the 3-material comparison
    const ranges = {};
    outputs.forEach((o, i) => {
      const lo = outputs[i - 1], hi = outputs[i + 1];
      ranges[o.id] = {
        min: lo ? (o.target * o.coef + lo.target * lo.coef) / (o.coef + lo.coef) : 0,
        max: hi ? (o.target * o.coef + hi.target * hi.coef) / (o.coef + hi.coef) : Infinity,
        lower: lo ? lo.id : null, upper: hi ? hi.id : null,
      };
    });
    const idx = { outputs, inputs, ranges, inputById: Object.fromEntries(inputs.map(x => [x.id, x])), best: {} };
    cauldronCache.set(data, idx);
    return idx;
  }

  /** Value the cauldron compares for 3 materials: duplicates are penalised (x0.65 for a pair, x0.5 for a triple). */
  function cauldronValue3(costs, ids) {
    const sum = costs[0] + costs[1] + costs[2];
    if (ids[0] === ids[1] && ids[1] === ids[2]) return { T: sum * 0.5, mult: 0.5 };
    if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) return { T: sum * 0.65, mult: 0.65 };
    return { T: sum, mult: 1 };
  }

  function nearestOutput(cidx, T, maxTarget = Infinity) {
    let best = null, bestD = Infinity;
    for (const o of cidx.outputs) {
      if (o.target > maxTarget) continue;
      const d = Math.abs(T - o.target) * o.coef;
      if (d < bestD - 1e-9 || (Math.abs(d - bestD) < 1e-9 && best && o.order < best.order)) { best = o; bestD = d; }
    }
    return best;
  }

  /**
   * Result of throwing 2 or 3 materials into a cauldron.
   * 3 materials: T = sum of values (duplicate penalty), output = nearest target.
   * 2 materials (community-verified): same item -> next higher target; different -> T = max - min, nearest target <= max.
   */
  function cauldronMix(data, ids) {
    const cidx = cauldronIndex(data);
    ids = ids.filter(Boolean);
    if (ids.length < 2 || ids.some(id => !cidx.inputById[id])) return null;
    const costs = ids.map(id => cidx.inputById[id].cost);
    let T, mult = 1, kind, result;
    if (ids.length === 3) {
      ({ T, mult } = cauldronValue3(costs, ids));
      kind = mult === 1 ? 'sum' : mult === 0.65 ? 'pair' : 'triple';
      result = nearestOutput(cidx, T);
    } else if (ids[0] === ids[1]) {
      T = costs[0];
      kind = 'same2';
      result = cidx.outputs.find(o => o.target > T && o.id !== ids[0]) || null;
    } else {
      const hi = Math.max(costs[0], costs[1]);
      T = hi - Math.min(costs[0], costs[1]);
      kind = 'diff2';
      result = nearestOutput(cidx, T, hi);
    }
    if (!result) return null;
    const it = data.items[result.id];
    return { inputs: ids, costs, T, mult, kind, result: result.id, target: it.cauldron.target, distance: T - it.cauldron.target, ...cauldronTiming(it.cauldron.target) };
  }

  /**
   * All 3-material combinations that produce `out`.
   * opts: { mode:'any'|'unique'|'same', require:[ids], exclude:[ids], tags:[tag], sort:'value'|'distance', limit }
   */
  function cauldronSearch(data, out, opts = {}) {
    const cidx = cauldronIndex(data);
    const range = cidx.ranges[out];
    if (!range) return { total: 0, list: [] };
    const mode = opts.mode || 'any';
    const need = (opts.require || []).filter(Boolean);
    const exclude = new Set((opts.exclude || []).filter(Boolean));
    const tags = opts.tags && opts.tags.length ? new Set(opts.tags) : null;
    const pool = cidx.inputs.filter(x => !exclude.has(x.id) && (!tags || x.tags.some(t => tags.has(t)) || need.includes(x.id)));
    const target = data.items[out].cauldron.target;
    const found = [];
    const eps = 1e-9;
    const consider = (a, b, c) => {
      const ids = [a.id, b.id, c.id];
      const { T } = cauldronValue3([a.cost, b.cost, c.cost], ids);
      if (T < range.min - eps || T > range.max + eps) return;
      if (need.length && !need.every(r => ids.filter(x => x === r).length >= need.filter(x => x === r).length)) return;
      // exact check at the window edges (ties go to the lower item ID)
      if ((T - range.min < 1e-6 || range.max - T < 1e-6) && nearestOutput(cidx, T).id !== out) return;
      found.push({ inputs: ids, T, distance: T - target, value: a.value + b.value + c.value });
    };
    const n = pool.length;
    if (mode === 'same') {
      for (const a of pool) consider(a, a, a);
    } else {
      for (let i = 0; i < n; i++) {
        for (let j = mode === 'any' ? i : i + 1; j < n; j++) {
          for (let k = mode === 'any' ? j : j + 1; k < n; k++) consider(pool[i], pool[j], pool[k]);
        }
      }
    }
    const byDist = (x, y) => Math.abs(x.distance) - Math.abs(y.distance) || x.value - y.value;
    const byValue = (x, y) => x.value - y.value || Math.abs(x.distance) - Math.abs(y.distance);
    found.sort(opts.sort === 'distance' ? byDist : byValue);
    return { total: found.length, list: found.slice(0, opts.limit || 200) };
  }

  /** Items whose default production chain consumes `out` (using them in a cauldron for `out` would loop). */
  function consumersOf(data, out) {
    const idx = buildIndex(data);
    const memo = {};
    const uses = (item, seen) => {
      if (item === out) return true;
      if (item in memo) return memo[item];
      if (seen.has(item)) return false;
      seen.add(item);
      const id = defaultRecipe(idx, item);
      const r = id !== 'raw' && idx.recipeById[id];
      const res = !!r && r.in.some(i => uses(i.item, seen));
      seen.delete(item);
      return (memo[item] = res);
    };
    return cauldronIndex(data).inputs.map(x => x.id).filter(id => uses(id, new Set()));
  }

  /** Cheapest combination (by item base value) that makes `out` without looping back through `out`. */
  function cauldronBest(data, out) {
    const cidx = cauldronIndex(data);
    if (!(out in cidx.best)) {
      let r = cauldronSearch(data, out, { mode: 'any', exclude: consumersOf(data, out), sort: 'value', limit: 1 });
      if (!r.list.length) r = cauldronSearch(data, out, { mode: 'any', exclude: [out], sort: 'value', limit: 1 });
      cidx.best[out] = r.list[0] ? r.list[0].inputs : null;
    }
    return cidx.best[out];
  }

  /** Herbs that can start a herb-only cauldron route: cultivated herbs (they have growth data) the cauldron accepts. */
  function herbItems(data) {
    const cidx = cauldronIndex(data);
    const grown = new Set((data.growth || []).flatMap(g => [g.plant, g.side]).filter(Boolean));
    return cidx.inputs.filter(x => x.tags.includes('Herb') && grown.has(x.id)).map(x => x.id);
  }

  /**
   * Nutrients needed to grow one herb (0 for herbs that are not grown, e.g. gloom fungus).
   * A growth cycle needs nutrientPerItem x num; when it also yields a side product (gentian nectar,
   * world tree core) the total is shared between the harvested items in proportion to their value.
   */
  function herbNutrient(data, id) {
    let best = Infinity;
    for (const g of data.growth || []) {
      if (g.plant !== id && g.side !== id) continue;
      const total = g.nutrientPerItem * g.num;
      const v = x => (data.items[x] ? data.items[x].value : 0) || 1;
      const pool = g.num * v(g.plant) + (g.side ? g.sideNum * v(g.side) : 0);
      best = Math.min(best, total * v(id) / pool);
    }
    return isFinite(best) ? best : 0;
  }

  // Route cost vector: [herbs, batches, time(s), heat, herb value, nutrient points]; compared
  // lexicographically in the order of the chosen priority.
  const HERB_KEYS = { herbs: 0, batches: 1, time: 2, heat: 3, value: 4, nutrient: 5 };
  const HERB_ORDER = {
    // default: fewest cauldron batches -> fewest fertilizer points -> fewest herbs -> least heat -> shortest time
    standard: ['batches', 'nutrient', 'herbs', 'heat', 'time', 'value'],
    nutrient: ['nutrient', 'batches', 'herbs', 'heat', 'time', 'value'],
    herbs: ['herbs', 'batches', 'nutrient', 'heat', 'time', 'value'],
    heat: ['heat', 'batches', 'nutrient', 'herbs', 'time', 'value'],
    time: ['time', 'batches', 'nutrient', 'herbs', 'heat', 'value'],
  };
  function herbComparator(metric) {
    const order = (HERB_ORDER[metric] || HERB_ORDER.standard).map(k => HERB_KEYS[k]);
    return (a, b) => {
      for (const i of order) {
        const d = a[i] - b[i];
        if (Math.abs(d) > 1e-9 * Math.max(1, Math.abs(a[i]), Math.abs(b[i]))) return d;
      }
      return 0;
    };
  }
  const vecAdd = (vs, extra) => extra.map((x, i) => vs.reduce((s, v) => s + v[i], x));
  function batchVec(data, out) {
    const tm = cauldronTiming(data.items[out].cauldron.target);
    return [0, 1, tm.time, tm.time * tm.heat, 0, 0];
  }

  /**
   * Best way to make every cauldron output using only the given herbs plus cauldron outputs
   * (multi-step cauldron chains). Generalised Dijkstra over the "3 materials -> 1 output" hypergraph,
   * run as repeated relaxation until no route improves.
   * opts: { herbs:[ids], metric:'standard'|'nutrient'|'herbs'|'heat'|'time', allowTwo:boolean }
   * Fertilizer is measured in nutrient points consumed (independent of which fertilizer supplies them).
   * Returns { best: { item: { vec, cost, batches, combo|null } }, herbs, metric }.
   */
  function herbRoutes(data, opts = {}) {
    const cidx = cauldronIndex(data);
    const herbs = (opts.herbs || herbItems(data)).filter(id => cidx.inputById[id]);
    const metric = HERB_ORDER[opts.metric] ? opts.metric : 'standard';
    const cmp = herbComparator(metric);
    const primary = HERB_KEYS[HERB_ORDER[metric][0]];
    const best = {};
    const set = (item, vec, combo) => { best[item] = { vec, cost: vec[primary], batches: vec[1], combo }; };
    for (const h of herbs) set(h, [1, 0, 0, 0, data.items[h].value, herbNutrient(data, h)], null);
    const step = {};
    for (const o of cidx.outputs) step[o.id] = batchVec(data, o.id);
    for (let pass = 0; pass < 60; pass++) {
      const pool = Object.keys(best).filter(id => cidx.inputById[id]);
      const c = pool.map(id => cidx.inputById[id].cost);
      let changed = false;
      const offer = (ids, out) => {
        if (!out || herbs.includes(out)) return;
        const vec = vecAdd(ids.map(id => best[id].vec), step[out]);
        if (!best[out] || cmp(vec, best[out].vec) < 0) { set(out, vec, ids); changed = true; }
      };
      const n = pool.length;
      for (let i = 0; i < n; i++) {
        for (let j = i; j < n; j++) {
          if (opts.allowTwo) {
            const m = cauldronMix(data, [pool[i], pool[j]]);
            if (m) offer([pool[i], pool[j]], m.result);
          }
          for (let k = j; k < n; k++) {
            const ids = [pool[i], pool[j], pool[k]];
            const o = nearestOutput(cidx, cauldronValue3([c[i], c[j], c[k]], ids).T);
            offer(ids, o && o.id);
          }
        }
      }
      if (!changed) break;
    }
    return { best, herbs, metric };
  }

  /** Expand the route to `target`: herb totals, cauldron batches per item (deepest first) and the tree. */
  function herbRoute(data, routes, target, factory = 1) {
    const { best } = routes;
    if (!best[target]) return null;
    const herbs = {}, batches = {}, depth = {};
    const depthOf = (id, seen = new Set()) => {
      if (id in depth) return depth[id];
      const b = best[id];
      if (!b.combo || seen.has(id)) return (depth[id] = 0);
      seen.add(id);
      return (depth[id] = 1 + Math.max(...b.combo.map(x => depthOf(x, seen))));
    };
    const walk = (id, qty) => {
      const b = best[id];
      if (!b.combo) { herbs[id] = (herbs[id] || 0) + qty; return { item: id, qty, herb: true }; }
      batches[id] = (batches[id] || 0) + qty;
      return { item: id, qty, combo: b.combo, children: b.combo.map(x => walk(x, qty)) };
    };
    const tree = walk(target, 1);
    depthOf(target);
    let time = 0, heat = 0;
    const steps = Object.entries(batches).map(([item, n]) => {
      const tm = cauldronTiming(data.items[item].cauldron.target);
      time += n * tm.time / factory;
      heat += n * tm.time * tm.heat; // heat/s scales up and time down by the same factor
      return { item, n, combo: best[item].combo, depth: depth[item], time: tm.time / factory, heat: tm.heat * factory };
    }).sort((a, b) => a.depth - b.depth || a.item.localeCompare(b.item));
    return {
      target, tree, steps, herbs, depth: depth[target], time, heat,
      herbTotal: Object.values(herbs).reduce((s, n) => s + n, 0),
      batchTotal: Object.values(batches).reduce((s, n) => s + n, 0),
      herbValue: Object.entries(herbs).reduce((s, [id, n]) => s + n * data.items[id].value, 0),
      nutrient: Object.entries(herbs).reduce((s, [id, n]) => s + n * herbNutrient(data, id), 0),
    };
  }

  /** Other final-step combinations for `target`, ranked with the same metric as the routes. */
  function herbAlternatives(data, routes, target, limit = 8) {
    const cidx = cauldronIndex(data);
    const { best } = routes;
    const cmp = herbComparator(routes.metric);
    const step = batchVec(data, target);
    const pool = Object.keys(best).filter(id => cidx.inputById[id] && id !== target);
    const list = [];
    const n = pool.length;
    for (let i = 0; i < n; i++) for (let j = i; j < n; j++) for (let k = j; k < n; k++) {
      const ids = [pool[i], pool[j], pool[k]];
      const o = nearestOutput(cidx, cauldronValue3(ids.map(id => cidx.inputById[id].cost), ids).T);
      if (o && o.id === target) list.push({ combo: ids, vec: vecAdd(ids.map(id => best[id].vec), step) });
    }
    return list.sort((a, b) => cmp(a.vec, b.vec)).slice(0, limit);
  }

  /** Recipe-shaped description of a cauldron batch so the planner can treat it like any other recipe. */
  function cauldronRecipe(data, out, inputs) {
    const mix = inputs && cauldronMix(data, inputs);
    if (!mix || mix.result !== out) return null;
    const counts = {};
    for (const id of inputs) counts[id] = (counts[id] || 0) + 1;
    return {
      id: 'cauldron', main: out, type: 'Cauldron', time: mix.time, heat: mix.heat, cauldron: inputs.slice(),
      in: Object.entries(counts).map(([item, n]) => ({ item, n })), out: [{ item: out, n: 1 }],
      alt: true, hidden: false,
    };
  }

  /**
   * Effective numbers for running recipe r on its chosen machine.
   * Returns per-craft inputs/outputs and how many crafts per minute one machine performs.
   */
  function effective(data, idx, plan, ctx, r) {
    const fert = plan.fertilizer && data.items[plan.fertilizer];
    const plant = r.type === 'Plant' ? idx.plantByProduct[r.main] : null;
    const nursery = plant && fert && fert.nutrient > 0 && fert.nutrientSpeed > 0;
    const type = nursery ? 'Nursery' : r.type;
    const machineId = chosenMachine(data, idx, plan, type);
    const machine = data.machines[machineId] || { heat: 0, speed: 1, types: [type] };
    const mult = SKILL_TYPES[r.type] ? ctx[SKILL_TYPES[r.type]] : 1;
    const out = r.out.map(o => ({ item: o.item, n: o.n * mult, p: o.p }));
    const mainOut = out.filter(o => o.item === r.main).reduce((s, o) => s + o.n, 0);
    let craftsPerMin;
    let fertPerCraft = 0;
    if (nursery) {
      // nutrient-limited growth: items/min = 60 * nutrient speed / nutrients per item, capped by the belt
      const itemsPerMin = Math.min(60 * fert.nutrientSpeed * ctx.factory / plant.nutrientPerItem, ctx.belt);
      craftsPerMin = itemsPerMin / mainOut;
      fertPerCraft = mainOut * plant.nutrientPerItem / (fert.nutrient * ctx.fertEff);
    } else {
      const speed = machine.speed * (r.type === PARADOX_TYPE ? 1 : ctx.factory);
      craftsPerMin = 60 / r.time * speed;
    }
    let heatPerMachine = machine.heat > 0
      ? (machine.heat + (HEATER_IDLE[machineId] ?? 1)) * (r.type === PARADOX_TYPE ? 1 : ctx.factory)
      : 0;
    if (r.type === 'Cauldron') {
      const it = data.items[r.main];
      heatPerMachine = (r.heat ?? cauldronTiming(it && it.cauldron ? it.cauldron.target : 1).heat) * ctx.factory;
    }
    return { recipe: r, machineId, machine, out, mainOut, craftsPerMin, heatPerMachine, fertPerCraft, nursery };
  }

  /**
   * Solve a plan.
   * plan = { targets:[{item, rate, unit:'min'|'machines'}], recipes:{item:recipeId|'raw'},
   *          machines:{craftType:machineId}, research:{factory, fuel, fertilizer, alchemy, logistics},
   *          fuel, fertilizer, byproducts:'recycle'|'show', selfSupply:boolean }
   */
  function solve(data, plan, idx) {
    idx = idx || buildIndex(data);
    const ctx = context(data, plan);
    const recycle = plan.byproducts !== 'show';
    const fuel = plan.fuel && data.items[plan.fuel] && data.items[plan.fuel].heat > 0 ? plan.fuel : null;
    const fertId = plan.fertilizer && data.items[plan.fertilizer] ? plan.fertilizer : null;

    const effCache = {};
    const eff = item => {
      if (!(item in effCache)) {
        const r = chosenRecipe(data, idx, plan, item);
        effCache[item] = r ? effective(data, idx, plan, ctx, r) : null;
      }
      return effCache[item];
    };

    const target = {};
    for (const t of plan.targets || []) {
      if (!t.item || !data.items[t.item]) continue;
      let rate = Math.max(0, +t.rate || 0);
      if (t.unit === 'machines') {
        const e = eff(t.item);
        rate = e ? rate * e.craftsPerMin * e.mainOut : 0;
      }
      target[t.item] = (target[t.item] || 0) + rate;
    }

    let crafts = {};   // item -> crafts/min of its chosen recipe
    let demand = {}, byp = {}, heat = 0, fertUse = 0;
    let converged = false, iter = 0;
    for (; iter < 1000; iter++) {
      demand = { ...target };
      byp = {};
      heat = 0;
      fertUse = 0;
      for (const [item, n] of Object.entries(crafts)) {
        if (n <= 0) continue;
        const e = eff(item);
        for (const i of e.recipe.in) demand[i.item] = (demand[i.item] || 0) + n * i.n;
        for (const o of e.out) if (o.item !== item) byp[o.item] = (byp[o.item] || 0) + n * o.n;
        heat += n / e.craftsPerMin * e.heatPerMachine;
        fertUse += n * e.fertPerCraft;
      }
      if (plan.selfSupply) {
        if (fuel && heat > 0) demand[fuel] = (demand[fuel] || 0) + heat * 60 / (data.items[fuel].heat * ctx.fuelEff);
        if (fertId && fertUse > 0) demand[fertId] = (demand[fertId] || 0) + fertUse;
      }
      const next = {};
      let delta = 0, scale = 0;
      for (const item of new Set([...Object.keys(demand), ...Object.keys(byp)])) {
        const e = eff(item);
        if (!e || e.mainOut <= 0) continue;
        const net = (demand[item] || 0) - (recycle ? (byp[item] || 0) : 0);
        const n = Math.max(0, net) / e.mainOut;
        if (n > 0) next[item] = n;
        delta = Math.max(delta, Math.abs(n - (crafts[item] || 0)));
        scale = Math.max(scale, n);
      }
      crafts = next;
      if (scale > 1e12) break;
      if (delta <= 1e-10 * Math.max(1, scale)) { converged = true; break; }
    }

    // ---- assemble result
    const fuelPerMin = fuel && heat > 0 ? heat * 60 / (data.items[fuel].heat * ctx.fuelEff) : 0;
    const steps = [];
    for (const [item, n] of Object.entries(crafts)) {
      const e = eff(item);
      const machines = n / e.craftsPerMin;
      steps.push({
        item, recipe: e.recipe.id, type: e.nursery ? 'Nursery' : e.recipe.type, machine: e.machineId,
        crafts: n, rate: n * e.mainOut, machines, heat: machines * e.heatPerMachine,
        inputs: e.recipe.in.map(i => ({ item: i.item, rate: n * i.n })),
        outputs: e.out.map(o => ({ item: o.item, rate: n * o.n, p: o.p })),
        fertilizer: e.nursery ? n * e.fertPerCraft : 0,
      });
    }
    // order: targets first, then by longest distance from a target
    const depth = {};
    const visit = (item, d, seen) => {
      if (seen.has(item) || (depth[item] ?? -1) >= d) return;
      depth[item] = d;
      const s = steps.find(x => x.item === item);
      if (!s) return;
      seen.add(item);
      for (const i of s.inputs) visit(i.item, d + 1, seen);
      seen.delete(item);
    };
    for (const t of Object.keys(target)) visit(t, 0, new Set());
    steps.sort((a, b) => (depth[a.item] ?? 99) - (depth[b.item] ?? 99) || b.rate - a.rate);

    const raw = [], surplus = [];
    for (const item of new Set([...Object.keys(demand), ...Object.keys(byp)])) {
      const need = (demand[item] || 0) - (recycle ? (byp[item] || 0) : 0);
      if (!eff(item) && need > 1e-9) raw.push({ item, rate: need });
      const extra = recycle ? (crafts[item] ? 0 : -need) : (byp[item] || 0);
      if (extra > 1e-9) surplus.push({ item, rate: extra });
    }
    raw.sort((a, b) => b.rate - a.rate);
    surplus.sort((a, b) => b.rate - a.rate);

    return {
      ok: converged, iterations: iter, ctx, targets: target, steps, raw, surplus, depth,
      heat, fuel, fuelPerMin, fertilizer: fertId, fertilizerPerMin: fertUse, selfSupply: !!plan.selfSupply,
      demand, byproducts: byp,
    };
  }

  /** Per-machine throughput summary of a recipe (used by the item browser). */
  function recipeStats(data, idx, plan, r) {
    const ctx = context(data, plan);
    const e = effective(data, idx, plan, ctx, r);
    return {
      machine: e.machineId, nursery: e.nursery,
      inputs: r.in.map(i => ({ item: i.item, rate: i.n * e.craftsPerMin })),
      outputs: e.out.map(o => ({ item: o.item, rate: o.n * e.craftsPerMin, p: o.p })),
      seconds: 60 / e.craftsPerMin, heat: e.heatPerMachine,
    };
  }

  const api = {
    solve, buildIndex, defaultRecipe, chosenRecipe, chosenMachine, researchValue, recipeStats, context,
    cauldronIndex, cauldronMix, cauldronSearch, cauldronBest, cauldronRecipe, cauldronTiming,
    herbItems, herbRoutes, herbRoute, herbAlternatives, herbNutrient,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AFCalc = api;
})(typeof window !== 'undefined' ? window : globalThis);
