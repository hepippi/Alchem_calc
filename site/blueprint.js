/* Alchemy Factory blueprint reader (in-game "設計図" PNG files). No DOM. */
(function (root) {
  'use strict';

  // File layout: thumbnail PNG | UE tagged-property header | Oodle Kraken payload | u32 len(header+payload) | u32 magic
  const FOOTER_MAGIC = 0x5042AFD5;
  const CELL = 25; // world units per grid cell
  const NATIVE = { // structs serialized as raw fields, not tagged properties
    Vector: ['f64', 3], Rotator: ['f64', 3], Quat: ['f64', 4], Vector2D: ['f64', 2],
    IntPoint: ['i32', 2], IntVector: ['i32', 3], Color: ['u8', 4], LinearColor: ['f32', 4], Guid: ['u32', 4],
    DateTime: ['i64', 1], Timespan: ['i64', 1],
  };
  const SIZE = { f64: 8, f32: 4, i32: 4, u32: 4, u8: 1, i64: 8 };

  class Reader {
    constructor(bytes) { this.b = bytes; this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.p = 0; }
    i32() { const x = this.v.getInt32(this.p, true); this.p += 4; return x; }
    u8() { return this.b[this.p++]; }
    num(kind) {
      const p = this.p;
      this.p += SIZE[kind];
      switch (kind) {
        case 'f64': return this.v.getFloat64(p, true);
        case 'f32': return this.v.getFloat32(p, true);
        case 'i32': return this.v.getInt32(p, true);
        case 'u32': return this.v.getUint32(p, true);
        case 'u8': return this.b[p];
        default: return Number(this.v.getBigInt64(p, true));
      }
    }
    fstr() {
      const n = this.i32();
      if (n === 0) return '';
      if (n < 0) {
        const s = new TextDecoder('utf-16le').decode(this.b.subarray(this.p, this.p - 2 * n - 2));
        this.p += -2 * n;
        return s;
      }
      const s = new TextDecoder().decode(this.b.subarray(this.p, this.p + n - 1));
      this.p += n;
      return s;
    }
    typeName() {
      const name = this.fstr();
      const n = this.i32();
      const params = [];
      for (let i = 0; i < n; i++) params.push(this.typeName());
      return [name, params];
    }
  }

  function nativeStruct(r, name) {
    const [kind, n] = NATIVE[name];
    const out = [];
    for (let i = 0; i < n; i++) out.push(r.num(kind));
    return out;
  }

  /** FText: only the forms blueprints use (culture-invariant string / plain base text). */
  function text(r, size) {
    const end = r.p + size;
    r.i32(); // flags
    const history = (r.u8() << 24) >> 24;
    let s = '';
    if (history === -1) { if (r.i32()) s = r.fstr(); } else if (history === 0) { r.fstr(); r.fstr(); s = r.fstr(); }
    r.p = end;
    return s;
  }

  function scalar(r, type, size) {
    switch (type) {
      case 'IntProperty': return r.i32();
      case 'Int64Property': return r.num('i64');
      case 'UInt32Property': return r.num('u32');
      case 'FloatProperty': return r.num('f32');
      case 'DoubleProperty': return r.num('f64');
      case 'NameProperty': case 'StrProperty': case 'EnumProperty': return r.fstr();
      case 'ByteProperty': return size > 1 ? r.fstr() : r.u8();
      default: r.p += size; return null;
    }
  }

  function element(r, tn) {
    const [t, params] = tn;
    if (t === 'StructProperty') return NATIVE[params[0][0]] ? nativeStruct(r, params[0][0]) : props(r);
    if (t === 'BoolProperty') return !!r.u8();
    if (t === 'ByteProperty') return params.length && params[0][0] !== 'None' ? r.fstr() : r.u8();
    if (t === 'IntProperty' || t === 'FloatProperty' || t === 'DoubleProperty' || t === 'Int64Property' || t === 'UInt32Property') return scalar(r, t, 0);
    return scalar(r, t, 0);
  }

  function value(r, tn, size, flags) {
    const [t, params] = tn;
    const end = r.p + size;
    let v;
    if (t === 'BoolProperty') v = !!(flags & 0x10);
    else if (t === 'StructProperty') {
      const s = params[0][0];
      v = NATIVE[s] ? nativeStruct(r, s) : props(r);
    } else if (t === 'ArrayProperty' || t === 'SetProperty') {
      if (t === 'SetProperty') r.i32();
      const n = r.i32();
      v = [];
      for (let i = 0; i < n; i++) v.push(element(r, params[0]));
    } else if (t === 'MapProperty') {
      r.i32();
      const n = r.i32();
      v = [];
      for (let i = 0; i < n; i++) v.push([element(r, params[0]), element(r, params[1])]);
    } else if (t === 'TextProperty') v = text(r, size);
    else v = scalar(r, t, size);
    r.p = end;
    return v;
  }

  /** Tagged property list until "None". Repeated names (static arrays) become arrays. */
  function props(r) {
    const out = {};
    for (;;) {
      const name = r.fstr();
      if (name === 'None' || name === '') return out;
      const tn = r.typeName();
      const size = r.i32();
      const flags = r.u8();
      if (flags & 0x01) r.i32();
      if (flags & 0x02) r.p += 16;
      if (flags & 0x04) { const ext = r.u8(); if (ext & 0x02) r.u8(); }
      const v = value(r, tn, size, flags);
      if (name in out) {
        if (!Array.isArray(out[name]) || !out['__arr_' + name]) { out[name] = [out[name]]; out['__arr_' + name] = true; }
        out[name].push(v);
      } else out[name] = v;
    }
  }

  let oozPromise = null;
  function ooz() {
    if (!oozPromise) oozPromise = root.__ooz ? Promise.resolve(root.__ooz) : import(new URL('vendor/ooz-wasm/index.js', document.baseURI).href);
    return oozPromise;
  }

  const enumTail = s => (typeof s === 'string' ? s.split('::').pop() : s);
  const nameOrNull = s => (s && s !== 'None' ? s : null);

  /** Parse a blueprint file (ArrayBuffer / Uint8Array) into a compact model. */
  async function parse(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 16 || dv.getUint32(bytes.length - 4, true) !== FOOTER_MAGIC) throw new Error('not-blueprint');
    const len = dv.getUint32(bytes.length - 8, true);
    const blob = bytes.subarray(bytes.length - 8 - len, bytes.length - 8);
    const hr = new Reader(blob);
    const header = props(hr);
    const cs = header.CompressedSize, us = header.UncompressedSize;
    const payload = blob.subarray(hr.p, hr.p + cs);
    const { decompress } = await ooz();
    const raw = decompress(payload, us);
    const body = props(new Reader(raw));
    const grid = body.ParentGridGroup || { Pivot: [0, 0, 0], GridArea: [1, 1] };
    const buildings = (body.Buildings || []).map((b, i) => {
      const bb = b.building || {};
      const rel = b.RelativeGridGroup || { Pivot: [0, 0, 0], GridArea: [1, 1] };
      const caul = Array.isArray(b.CauldronFilterName) ? b.CauldronFilterName : [b.CauldronFilterName];
      return {
        i, id: bb.BuildingName, rot: enumTail(bb.GridRotation) || 'NoRotation',
        x: rel.Pivot[0], y: rel.Pivot[1], z: rel.Pivot[2], w: rel.GridArea[0], d: rel.GridArea[1],
        pos: bb.BuildPos, recipe: nameOrNull(b.RecipeName), seed: nameOrNull(b.SeedName),
        filter: nameOrNull(b.FilterName), cauldron: caul.map(nameOrNull).filter(Boolean),
        supply: nameOrNull(b.SupplyName), coin: nameOrNull(b.CoinName), notice: b.NoticeString || '',
      };
    });
    return {
      title: header.Title || '', description: header.Description || '', icon: nameOrNull(header.ItemName),
      version: header.Version, size: { w: grid.GridArea[0], d: grid.GridArea[1] }, origin: grid.Pivot,
      buildings, catapults: body.RelationCatapults || [], rawSize: us,
    };
  }

  const api = { parse, props, Reader, FOOTER_MAGIC, CELL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AFBlueprint = api;
})(typeof window !== 'undefined' ? window : globalThis);
