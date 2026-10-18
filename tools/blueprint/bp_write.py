"""Write-back test: re-encode an Alchemy Factory blueprint (unchanged, and with one building moved)."""
import base64, ctypes, os, struct, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bp_decode, bp_parse  # noqa: E402

oo = ctypes.WinDLL(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'extractor', 'bin', 'Release', 'net10.0', 'oodle-data-shared.dll'))
_need = oo.OodleLZ_GetCompressedBufferSizeNeeded
_need.restype = ctypes.c_int64
_need.argtypes = [ctypes.c_int, ctypes.c_int64]
_comp = oo.OodleLZ_Compress
_comp.restype = ctypes.c_int64
_comp.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int64, ctypes.c_void_p, ctypes.c_int,
                  ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int64]
KRAKEN, LEVEL_NORMAL = 8, 4
FOOTER_MAGIC = 0x5042AFD5  # last 8 bytes: u32 len(header + payload), u32 magic


def compress(raw):
    buf = ctypes.create_string_buffer(_need(KRAKEN, len(raw)))
    n = _comp(KRAKEN, raw, len(raw), buf, LEVEL_NORMAL, None, None, None, None, 0)
    assert n > 0, n
    return buf.raw[:n]


def fstring(s):
    try:
        b = s.encode('ascii') + b'\0'
        return struct.pack('<i', len(b)) + b
    except UnicodeEncodeError:
        b = s.encode('utf-16-le') + b'\0\0'
        return struct.pack('<i', -(len(b) // 2)) + b


def tag_value_span(hdr, name):
    """(start, end, size_offset) of the value of top-level tag `name` in the header."""
    r = bp_parse.R(hdr)
    while True:
        tag_start = r.p
        nm = r.fstr()
        if nm in ('None', ''):
            raise KeyError(name)
        r.typename()
        size_off = r.p
        size = r.i32()
        flags = r.u8()
        if flags & 0x01: r.i32()
        if flags & 0x02: r.take(16)
        if flags & 0x04:
            ext = r.u8()
            if ext & 0x02: r.u8()
        if nm == name:
            return r.p, r.p + size, size_off
        r.p += size


def set_value(hdr, name, value_bytes):
    start, end, size_off = tag_value_span(hdr, name)
    hdr = hdr[:start] + value_bytes + hdr[end:]
    return hdr[:size_off] + struct.pack('<i', len(value_bytes)) + hdr[size_off + 4:]


def set_title(hdr, title):
    # FText: flags=2, history None (-1), has culture-invariant string, FString
    return set_value(hdr, 'Title', struct.pack('<ib', 2, -1) + struct.pack('<i', 1) + fstring(title))


def new_name():
    return base64.urlsafe_b64encode(os.urandom(16)).rstrip(b'=').decode()


def write(src_png, raw, title, out_dir):
    d = open(src_png, 'rb').read()
    iend = d.rfind(b'IEND') + 8
    png, tail = d[:iend], d[iend:]
    hdr = tail[:tail.find(b'None\x00') + 5]
    comp = compress(raw)
    assert bp_check(raw, comp)
    hdr = set_value(hdr, 'CompressedSize', struct.pack('<q', len(comp)))
    hdr = set_value(hdr, 'UncompressedSize', struct.pack('<q', len(raw)))
    hdr = set_title(hdr, title)
    out = os.path.join(out_dir, new_name() + '.png')
    blob = hdr + comp
    open(out, 'wb').write(png + blob + struct.pack('<II', len(blob), FOOTER_MAGIC))
    return out


def bp_check(raw, comp):
    out = ctypes.create_string_buffer(len(raw))
    n = bp_decode.f(comp, len(comp), out, len(raw), 1, 0, 0, None, 0, None, None, None, 0, 3)
    return n == len(raw) and out.raw == raw


def move_first(raw, old_pivot, new_pivot, old_pos, new_pos):
    """Patch one building's RelativeGridGroup.Pivot and BuildPos in place (same byte length)."""
    a, b = struct.pack('<iii', *old_pivot), struct.pack('<iii', *new_pivot)
    p = raw.find(b'RelativeGridGroup\x00')
    k = raw.find(a, p)
    assert k > 0 and k - p < 400, 'pivot not found near RelativeGridGroup'
    raw = raw[:k] + b + raw[k + 12:]
    c, e = struct.pack('<ddd', *old_pos), struct.pack('<ddd', *new_pos)
    assert raw.count(c) == 1, raw.count(c)
    return raw.replace(c, e)


if __name__ == '__main__':
    src, out_dir = sys.argv[1], sys.argv[2]
    _, raw, _, _ = bp_decode.blueprint(src)
    # sanity: the original stream had nothing after the compressed payload
    d = open(src, 'rb').read(); tail = d[d.rfind(b'IEND') + 8:]
    hdr = tail[:tail.find(b'None\x00') + 5]
    cs = struct.unpack('<q', hdr[tag_value_span(hdr, 'CompressedSize')[0]:][:8])[0]
    assert len(tail) == len(hdr) + cs + 8, (len(tail), len(hdr), cs)
    assert struct.unpack('<II', tail[-8:]) == (len(hdr) + cs, FOOTER_MAGIC)
    same = write(src, raw, '1 (copy)', out_dir)
    moved_raw = move_first(raw, (5, 2, 0), (5, 3, 0), (2437.5, 2062.5, 100.0), (2437.5, 2087.5, 100.0))
    moved = write(src, moved_raw, '1 (moved)', out_dir)
    print('unchanged ->', same)
    print('moved     ->', moved)
