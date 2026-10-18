import ctypes, struct, sys, os, glob
DLL = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'extractor', 'bin', 'Release', 'net10.0', 'oodle-data-shared.dll')
oo = ctypes.WinDLL(DLL)
f = oo.OodleLZ_Decompress
f.restype = ctypes.c_int64
f.argtypes = [ctypes.c_void_p, ctypes.c_int64, ctypes.c_void_p, ctypes.c_int64, ctypes.c_int, ctypes.c_int, ctypes.c_int,
              ctypes.c_void_p, ctypes.c_int64, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int64, ctypes.c_int]

def blueprint(path):
    d = open(path, 'rb').read()
    t = d[d.rfind(b'IEND') + 8:]
    def i64(name):
        k = t.find(name.encode() + b'\x00')
        k = t.find(b'Int64Property', k)
        # tag: type FString, int32 0, byte 0, int32 size(8), byte flags, value
        v = t[k + 14 + 4 + 4 + 1: k + 14 + 4 + 4 + 1 + 8]
        return struct.unpack('<q', v)[0]
    csize, usize = i64('CompressedSize'), i64('UncompressedSize')
    start = t.find(b'None\x00') + 5
    comp = t[start:start + csize]
    out = ctypes.create_string_buffer(usize)
    n = f(comp, len(comp), out, usize, 1, 0, 0, None, 0, None, None, None, 0, 3)
    return t[:start], out.raw[:n], csize, usize

if __name__ == '__main__':
    src = os.path.expandvars(r'%LOCALAPPDATA%\AlchemyFactory\Saved\Blueprints')
    for p in sorted(glob.glob(os.path.join(src, '*.png'))):
        hdr, raw, cs, us = blueprint(p)
        name = os.path.basename(p)[:-4]
        open(os.path.join(sys.argv[1], name + '.bin'), 'wb').write(raw)
        print(name, 'compressed', cs, 'raw', us, 'decoded', len(raw))
