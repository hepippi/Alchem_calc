"""Parse Alchemy Factory blueprint PNGs: header + Oodle-compressed UE tagged-property payload -> JSON."""
import glob, json, os, struct, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bp_decode import blueprint  # noqa: E402

NATIVE = {
    'Vector': '<ddd', 'Rotator': '<ddd', 'Quat': '<dddd', 'Vector2D': '<dd', 'IntPoint': '<ii', 'IntVector': '<iii',
    'Color': '<BBBB', 'LinearColor': '<ffff', 'Guid': '<IIII', 'DateTime': '<q', 'Timespan': '<q',
}


class R:
    def __init__(self, b, p=0):
        self.b, self.p = b, p

    def take(self, n):
        v = self.b[self.p:self.p + n]
        self.p += n
        return v

    def i32(self): return struct.unpack('<i', self.take(4))[0]
    def u8(self): return self.take(1)[0]

    def fstr(self):
        n = self.i32()
        if n == 0:
            return ''
        if n < 0:
            return self.take(-n * 2)[:-2].decode('utf-16-le')
        return self.take(n)[:-1].decode('utf-8', 'replace')

    def typename(self):
        name = self.fstr()
        cnt = self.i32()
        return [name] + [self.typename() for _ in range(cnt)]


def scalar(r, t, size):
    if t == 'IntProperty': return r.i32()
    if t == 'Int64Property': return struct.unpack('<q', r.take(8))[0]
    if t == 'UInt32Property': return struct.unpack('<I', r.take(4))[0]
    if t == 'FloatProperty': return struct.unpack('<f', r.take(4))[0]
    if t == 'DoubleProperty': return struct.unpack('<d', r.take(8))[0]
    if t in ('NameProperty', 'StrProperty', 'EnumProperty'): return r.fstr()
    if t == 'ByteProperty':
        return r.fstr() if size > 1 else r.u8()
    return r.take(size).hex()


def element(r, tn, size=None):
    """Value of one array/set/map element with type node tn."""
    t = tn[0]
    if t == 'StructProperty':
        sname = tn[1][0]
        if sname in NATIVE:
            fmt = NATIVE[sname]
            return list(struct.unpack(fmt, r.take(struct.calcsize(fmt))))
        return props(r)
    if t == 'BoolProperty': return bool(r.u8())
    if t == 'ByteProperty': return r.u8() if len(tn) == 1 or tn[1][0] == 'None' else r.fstr()
    return scalar(r, t, size or 0)


def value(r, tn, size, flags):
    t = tn[0]
    end = r.p + size
    try:
        if t == 'BoolProperty': return bool(flags & 0x10)
        if t == 'StructProperty':
            sname = tn[1][0]
            if sname in NATIVE and size == struct.calcsize(NATIVE[sname]):
                return list(struct.unpack(NATIVE[sname], r.take(size)))
            return props(r)
        if t in ('ArrayProperty', 'SetProperty'):
            if t == 'SetProperty': r.i32()  # removed keys
            n = r.i32()
            inner = tn[1]
            per = (size - 4) // n if n and inner[0] not in ('StructProperty', 'StrProperty', 'NameProperty', 'EnumProperty') else None
            return [element(r, inner, per) for _ in range(n)]
        if t == 'MapProperty':
            r.i32()
            n = r.i32()
            return [[element(r, tn[1]), element(r, tn[2])] for _ in range(n)]
        if t in ('TextProperty', 'ObjectProperty', 'SoftObjectProperty'):
            return {'raw': r.take(size).hex()}
        return scalar(r, t, size)
    finally:
        r.p = end


def props(r):
    out = {}
    while True:
        name = r.fstr()
        if name == 'None' or name == '':
            return out
        tn = r.typename()
        size = r.i32()
        flags = r.u8()
        if flags & 0x01: r.i32()
        if flags & 0x02: r.take(16)
        if flags & 0x04:
            ext = r.u8()
            if ext & 0x02: r.u8()
        v = value(r, tn, size, flags)
        if name in out:
            if not isinstance(out[name], list) or not out.get('__multi_' + name):
                out[name] = [out[name]]
                out['__multi_' + name] = True
            out[name].append(v)
        else:
            out[name] = v


def parse(path):
    hdr, raw, _, _ = blueprint(path)
    header = props(R(hdr))
    body = props(R(raw))
    return {'header': header, 'body': body}


if __name__ == '__main__':
    src = os.path.expandvars(r'%LOCALAPPDATA%\AlchemyFactory\Saved\Blueprints')
    outdir = sys.argv[1]
    for p in sorted(glob.glob(os.path.join(src, '*.png'))):
        bp = parse(p)
        name = os.path.basename(p)[:-4]
        json.dump(bp, open(os.path.join(outdir, name + '.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        b = bp['body']
        print(name, 'header keys', list(bp['header'].keys()), 'body keys', list(b.keys()), 'buildings', len(b.get('Buildings', [])))
