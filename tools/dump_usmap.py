"""Rebuild a .usmap type-mappings file from the UHT reflection tables compiled into a UE5 shipping exe.

Usage: python -I dump_usmap.py <game.exe> <out.usmap> [schema.json]

UE5 cooked assets use unversioned property serialization, which needs the property schema of every
struct/class to be read. Normally that is dumped at runtime (UE4SS / Dumper-7); here it is read
statically from the UECodeGen_Private::F*Params tables instead, so it can be re-run after every game
update without launching the game.
"""
import json
import re
import struct
import sys

from pe import Image

IDENT = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')

# EPropertyGenFlags (low 6 bits) -> usmap EPropertyType name
GEN = {
    0x00: 'ByteProperty', 0x01: 'Int8Property', 0x02: 'Int16Property', 0x03: 'IntProperty',
    0x04: 'Int64Property', 0x05: 'UInt16Property', 0x06: 'UInt32Property', 0x07: 'UInt64Property',
    0x0A: 'FloatProperty', 0x0B: 'DoubleProperty', 0x0C: 'BoolProperty', 0x0D: 'SoftObjectProperty',
    0x0E: 'WeakObjectProperty', 0x0F: 'LazyObjectProperty', 0x10: 'SoftObjectProperty',
    0x11: 'ObjectProperty', 0x12: 'ObjectProperty', 0x13: 'InterfaceProperty', 0x14: 'NameProperty',
    0x15: 'StrProperty', 0x16: 'ArrayProperty', 0x17: 'MapProperty', 0x18: 'SetProperty',
    0x19: 'StructProperty', 0x1A: 'DelegateProperty', 0x1B: 'MulticastDelegateProperty',
    0x1C: 'MulticastDelegateProperty', 0x1D: 'TextProperty', 0x1E: 'EnumProperty',
    0x1F: 'FieldPathProperty', 0x20: 'DoubleProperty', 0x21: 'Utf8StrProperty', 0x22: 'AnsiStrProperty',
    0x23: 'OptionalProperty',
}
USMAP_TYPES = [
    'ByteProperty', 'BoolProperty', 'IntProperty', 'FloatProperty', 'ObjectProperty', 'NameProperty',
    'DelegateProperty', 'DoubleProperty', 'ArrayProperty', 'StructProperty', 'StrProperty', 'TextProperty',
    'InterfaceProperty', 'MulticastDelegateProperty', 'WeakObjectProperty', 'LazyObjectProperty',
    'AssetObjectProperty', 'SoftObjectProperty', 'UInt64Property', 'UInt32Property', 'UInt16Property',
    'Int64Property', 'Int16Property', 'Int8Property', 'MapProperty', 'SetProperty', 'EnumProperty',
    'FieldPathProperty', 'OptionalProperty', 'Utf8StrProperty', 'AnsiStrProperty',
]


class Dumper:
    def __init__(self, exe):
        self.img = Image(exe)
        self.structs = {}   # params va -> dict
        self.classes = {}   # params va -> dict
        self.enums = {}     # name -> [(name, value)]
        self._func_cache = {}

    # ---- helpers ----
    def ident(self, va):
        if not va or not self.img.is_data(va):
            return None
        s = self.img.cstr(va, 200)
        return s if s and IDENT.match(s) else None

    def wident(self, va):
        b = self.img.read(va, 256)
        if not b:
            return None
        end = 0
        while end + 1 < len(b) and (b[end] or b[end + 1]):
            end += 2
        try:
            s = b[:end].decode('utf-16-le')
        except UnicodeDecodeError:
            return None
        return s if s and IDENT.match(s) else None

    def func_refs(self, func, depth=0):
        """RIP-relative data references in a small function, following one jmp thunk."""
        key = (func, depth)
        if key in self._func_cache:
            return self._func_cache[key]
        out = []
        code = self.img.read(func, 200) or b''
        end = code.find(b'\xc3')
        limit = end if end > 0 else len(code)
        for kind, tgt in self.img.rip_targets(func, limit + 1):
            if kind in (0xE8, 0xE9):
                if depth < 1 and kind == 0xE9 and self.img.is_code(tgt):
                    out.extend(self.func_refs(tgt, depth + 1))
                continue
            out.append(tgt)
        self._func_cache[key] = out
        return out

    # ---- struct params ----
    def is_struct_params(self, va):
        img = self.img
        name = self.ident(img.u64(va + 0x18))
        if not name:
            return False
        outer, sup, ops, props = (img.u64(va + o) for o in (0, 8, 0x10, 0x20))
        if not outer or not img.is_code(outer):
            return False
        if sup and not img.is_code(sup):
            return False
        if ops and not img.is_code(ops):
            return False
        n = img.u16(va + 0x28)
        if n > 2000 or (n and not (props and img.is_data(props))):
            return False
        if img.u8(va + 0x2C) not in (1, 2, 4, 8, 16, 32, 64):
            return False
        return True

    def struct_from_func(self, func):
        for t in self.func_refs(func):
            if t in self.structs or (self.img.is_data(t) and self.is_struct_params(t)):
                return self.load_struct(t)
        return None

    def load_struct(self, va):
        if va in self.structs:
            return self.structs[va]
        img = self.img
        info = {'name': self.ident(img.u64(va + 0x18)), 'super': None, 'props': [], 'va': va}
        self.structs[va] = info
        sup = img.u64(va + 8)
        if sup:
            s = self.struct_from_func(sup)
            info['super'] = s['name'] if s else None
        try:
            info['props'] = self.load_props(img.u64(va + 0x20), img.u16(va + 0x28))
        except Exception as e:  # noqa: BLE001 - heuristic scan, skip junk candidates
            info['error'] = str(e)
        return info

    # ---- enum params ----
    def enum_from_func(self, func):
        img = self.img
        for t in self.func_refs(func):
            if not img.is_data(t):
                continue
            name = self.ident(img.u64(t + 0x10))
            if not name or not img.u64(t) or not img.is_code(img.u64(t)):
                continue
            count = struct.unpack('<h', img.read(t + 0x2C, 2))[0]
            arr = img.u64(t + 0x20)
            if count < 0 or count > 4000 or (count and not img.is_data(arr)):
                continue
            if name not in self.enums:
                entries = []
                for i in range(count):
                    en = img.cstr(img.u64(arr + 16 * i))
                    val = struct.unpack('<q', img.read(arr + 16 * i + 8, 8))[0]
                    entries.append((en.split('::')[-1] if en else f'V{i}', val))
                self.enums[name] = entries
            return name
        return None

    # ---- properties ----
    def load_props(self, arr, n):
        """Mirror ConstructFProperties: walk the param array backwards, inner props precede their owner."""
        img = self.img
        ptrs = [img.u64(arr + 8 * i) for i in range(n)]
        stack = list(ptrs)
        out = []

        def take():
            return self.load_prop(stack.pop(), take)

        while stack:
            out.append(take())
        out.reverse()
        return out

    def load_prop(self, p, take):
        img = self.img
        name = img.cstr(img.u64(p))
        if not name:
            raise ValueError(f'bad property params at {p:#x}')
        gen = img.u8(p + 0x18) & 0x3F
        typ = GEN.get(gen)
        if typ is None:
            raise ValueError(f'unknown gen flag {gen:#x} for {name} at {p:#x}')
        prop = {'name': name, 'type': typ, 'dim': min(max(img.u16(p + 0x30), 1), 255)}
        if gen == 0x0C:  # bool params have no offset field; dim still at +0x30
            pass
        elif typ == 'StructProperty':
            s = self.struct_from_func(img.u64(p + 0x38))
            prop['struct'] = s['name'] if s else None
            if not s:
                print(f'warn: unresolved struct for {name} at {p:#x}', file=sys.stderr)
        elif typ == 'ByteProperty':
            f = img.u64(p + 0x38)
            if f and img.is_code(f):
                prop['enum'] = self.enum_from_func(f)
        elif typ == 'EnumProperty':
            f = img.u64(p + 0x38)
            prop['enum'] = self.enum_from_func(f) if f and img.is_code(f) else None
            prop['inner'] = take()
        elif typ in ('ArrayProperty', 'SetProperty', 'OptionalProperty'):
            prop['inner'] = take()
        elif typ == 'MapProperty':
            prop['key'] = take()
            prop['value'] = take()
        return prop

    # ---- class params ----
    def scan(self):
        img = self.img
        for va0, end, raw, size, sec in img.sections:
            if sec != '.data':
                continue
            for off in range(0, size - 0x40, 8):
                va = va0 + off
                if img.is_data(img.u64(va + 0x18) or 0) and self.is_struct_params(va):
                    self.load_struct(va)
        self.scan_classes()

    def is_class_params(self, va):
        img = self.img
        f = img.u64(va)
        if not f or not img.is_code(f):
            return False
        cfg = img.u64(va + 8)
        if cfg and not self.ident(cfg):
            return False
        cpp = img.u64(va + 0x10)
        if not cpp or not img.is_data(cpp):
            return False
        for o in (0x18, 0x20, 0x28, 0x30):
            q = img.u64(va + o)
            if q and not img.is_data(q):
                return False
        bits = img.u32(va + 0x38)
        ndeps, nfuncs, nprops, nifaces = bits & 0xF, (bits >> 4) & 0x7FF, (bits >> 15) & 0x7FF, bits >> 26
        if ndeps == 0 or not img.u64(va + 0x18):
            return False
        if (nprops > 0) != bool(img.u64(va + 0x28)):
            return False
        if (nfuncs > 0) != bool(img.u64(va + 0x20)):
            return False
        if (nifaces > 0) != bool(img.u64(va + 0x30)):
            return False
        return True

    def class_name(self, static_class_func):
        """StaticClass() -> (jmp) GetPrivateStaticClass(), whose first wide identifier literal is the class name."""
        img = self.img
        f = static_class_func
        for _ in range(2):
            code = img.read(f, 5)
            if code and code[0] == 0xE9:
                f = f + 5 + struct.unpack('<i', code[1:5])[0]
        bounds = img.func_bounds(f)
        if not bounds:
            return None
        start, end = bounds
        for kind, t in img.rip_targets(start, end - start):
            if kind in (0x8D, 0x8B) and img.is_data(t):
                w = self.wident(t)
                if w:
                    return w
        return None

    def scan_classes(self):
        img = self.img
        cands = []
        for va0, end, raw, size, sec in img.sections:
            if sec not in ('.data', '.rdata'):
                continue
            for off in range(0, size - 0x40, 8):
                va = va0 + off
                if self.is_class_params(va):
                    cands.append(va)
        # map: construct func (has lea to params) -> params, discovered lazily via deps
        self._class_cands = set(cands)
        for va in cands:
            self.load_class(va)

    def class_from_func(self, func):
        for t in self.func_refs(func):
            if t in self._class_cands:
                return self.load_class(t)
        return None

    def load_class(self, va):
        if va in self.classes:
            return self.classes[va]
        img = self.img
        info = {'name': None, 'super': None, 'props': [], 'va': va}
        self.classes[va] = info
        try:
            info['name'] = self.class_name(img.u64(va))
            bits = img.u32(va + 0x38)
            deps = img.u64(va + 0x18)
            first = img.u64(deps)
            if first and img.is_code(first):
                s = self.class_from_func(first)
                info['super'] = s['name'] if s else None
            nprops = (bits >> 15) & 0x7FF
            if nprops:
                info['props'] = self.load_props(img.u64(va + 0x28), nprops)
        except Exception as e:  # noqa: BLE001 - heuristic scan, skip junk candidates
            info['error'] = str(e)
        return info


class UsmapWriter:
    def __init__(self):
        self.names = []
        self.index = {}

    def name(self, s):
        if s not in self.index:
            self.index[s] = len(self.names)
            self.names.append(s)
        return self.index[s]

    def ptype(self, p):
        t = p['type']
        if t == 'ByteProperty' and p.get('enum'):
            return struct.pack('<B', USMAP_TYPES.index('EnumProperty')) + self.ptype({'type': 'ByteProperty'}) + struct.pack('<i', self.name(p['enum']))
        b = struct.pack('<B', USMAP_TYPES.index(t))
        if t == 'EnumProperty':
            b += self.ptype(p['inner']) + struct.pack('<i', self.name(p.get('enum') or 'None'))
        elif t == 'StructProperty':
            b += struct.pack('<i', self.name(p.get('struct') or 'None'))
        elif t in ('ArrayProperty', 'SetProperty', 'OptionalProperty'):
            b += self.ptype(p['inner'])
        elif t == 'MapProperty':
            b += self.ptype(p['key']) + self.ptype(p['value'])
        return b

    def build(self, types, enums):
        enum_blob = b''
        for en, entries in enums.items():
            enum_blob += struct.pack('<i', self.name(en)) + struct.pack('<B', min(len(entries), 255))
            for n, _v in entries[:255]:
                enum_blob += struct.pack('<i', self.name(n))
        struct_blob = b''
        for t in types:
            props = t['props']
            total = sum(max(p['dim'], 1) for p in props)
            struct_blob += struct.pack('<i', self.name(t['name']))
            struct_blob += struct.pack('<i', self.name(t['super']) if t['super'] else -1)
            struct_blob += struct.pack('<HH', total, len(props))
            idx = 0
            for p in props:
                dim = max(p['dim'], 1)
                struct_blob += struct.pack('<HBi', idx, dim, self.name(p['name']))
                struct_blob += self.ptype(p)
                idx += dim
        name_blob = struct.pack('<I', len(self.names))
        for n in self.names:
            e = n.encode('utf-8')
            name_blob += struct.pack('<B', len(e)) + e
        body = name_blob + struct.pack('<I', len(enums)) + enum_blob + struct.pack('<I', len(types)) + struct_blob
        return struct.pack('<HBBII', 0x30C4, 0, 0, len(body), len(body)) + body


def main():
    exe, out = sys.argv[1], sys.argv[2]
    d = Dumper(exe)
    d.scan()
    types, seen = [], set()
    for info in list(d.structs.values()) + list(d.classes.values()):
        if not info.get('name') or info.get('error') or info['name'] in seen:
            continue
        seen.add(info['name'])
        types.append(info)
    print(f'structs={len(d.structs)} classes={len(d.classes)} types={len(types)} enums={len(d.enums)}')
    open(out, 'wb').write(UsmapWriter().build(types, d.enums))
    if len(sys.argv) > 3:
        json.dump({'types': [{k: v for k, v in t.items() if k != 'va'} for t in types], 'enums': d.enums},
                  open(sys.argv[3], 'w', encoding='utf-8'), indent=1)


if __name__ == '__main__':
    main()
