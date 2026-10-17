"""Minimal helpers for reading static UE reflection data out of the shipping exe."""
import bisect
import struct

import pefile


class Image:
    def __init__(self, path):
        self.pe = pefile.PE(path, fast_load=True)
        self.base = self.pe.OPTIONAL_HEADER.ImageBase
        self.data = open(path, 'rb').read()
        self.sections = []
        for s in self.pe.sections:
            name = s.Name.rstrip(b'\0').decode()
            va = self.base + s.VirtualAddress
            self.sections.append((va, va + max(s.Misc_VirtualSize, s.SizeOfRawData), s.PointerToRawData, s.SizeOfRawData, name))
        self.sections.sort()
        self._starts = [s[0] for s in self.sections]
        self._funcs = None

    def func_bounds(self, va):
        """(begin, end) of the function containing va, from the .pdata exception table."""
        if self._funcs is None:
            sec = next(s for s in self.sections if s[4] == '.pdata')
            raw = self.data[sec[2]:sec[2] + sec[3]]
            entries = sorted(struct.unpack_from('<II', raw, i) for i in range(0, len(raw) - 11, 12))
            self._funcs = [(b + self.base, e + self.base) for b, e in entries if b and e > b]
            self._fstarts = [f[0] for f in self._funcs]
        i = bisect.bisect_right(self._fstarts, va) - 1
        if i >= 0 and self._funcs[i][0] <= va < self._funcs[i][1]:
            return self._funcs[i]
        return None

    def section_of(self, va):
        if va is None:
            return None
        i = bisect.bisect_right(self._starts, va) - 1
        if i < 0:
            return None
        s = self.sections[i]
        return s if s[0] <= va < s[1] else None

    def off(self, va):
        s = self.section_of(va)
        if not s or va - s[0] >= s[3]:
            return None
        return s[2] + (va - s[0])

    def read(self, va, n):
        o = self.off(va)
        if o is None:
            return None
        return self.data[o:o + n]

    def u64(self, va):
        b = self.read(va, 8)
        return struct.unpack('<Q', b)[0] if b and len(b) == 8 else None

    def u32(self, va):
        return struct.unpack('<I', self.read(va, 4))[0]

    def u16(self, va):
        return struct.unpack('<H', self.read(va, 2))[0]

    def u8(self, va):
        return self.read(va, 1)[0]

    def cstr(self, va, limit=256):
        b = self.read(va, limit)
        if b is None:
            return None
        end = b.find(b'\0')
        if end <= 0:
            return None
        try:
            s = b[:end].decode('utf-8')
        except UnicodeDecodeError:
            return None
        return s if s.isprintable() else None

    def is_code(self, va):
        s = self.section_of(va)
        return bool(s) and s[4] == '.text'

    def is_data(self, va):
        s = self.section_of(va)
        return bool(s) and s[4] in ('.rdata', '.data')

    def find_all(self, needle, section_names=None):
        for va, end, raw, size, name in self.sections:
            if section_names and name not in section_names:
                continue
            chunk = self.data[raw:raw + size]
            i = chunk.find(needle)
            while i >= 0:
                yield va + i
                i = chunk.find(needle, i + 1)

    def rip_targets(self, func_va, max_len=160):
        """Yield targets of RIP-relative memory operands in the first bytes of a function (rough scan)."""
        code = self.read(func_va, max_len)
        if not code:
            return
        for i in range(len(code) - 6):
            modrm = code[i + 1] if i + 1 < len(code) else 0
            op = code[i]
            # lea/mov r64, [rip+disp32] with REX.W prefix: 48/4C 8D|8B modrm(00 reg 101)
            if op in (0x48, 0x4C) and code[i + 1] in (0x8D, 0x8B) and (code[i + 2] & 0xC7) == 0x05:
                disp = struct.unpack('<i', code[i + 3:i + 7])[0]
                yield code[i + 1], func_va + i + 7 + disp
            # call/jmp rel32
            if op in (0xE8, 0xE9):
                disp = struct.unpack('<i', code[i + 1:i + 5])[0]
                yield op, func_va + i + 5 + disp
