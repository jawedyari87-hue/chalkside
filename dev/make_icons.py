"""Draw the Chalkside app icons (a chalk square-root sign on a slate board).

Standard library only: run `py -3 dev/make_icons.py` from the tutor folder.
"""

import math
import struct
import zlib
from pathlib import Path

SLATE = (0x21, 0x3A, 0x33)
CHALK = (0xED, 0xF1, 0xE7)
# The same path as the brand mark in index.html, on a 32-unit grid.
ROOT = [(6.5, 17.5), (9.5, 15.9), (13.1, 23.5), (18.5, 8.0), (26.0, 8.0)]
STROKE = 2.4


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def rounded_rect_sd(px, py, size, radius):
    # Signed distance to a rounded square covering [0, size].
    c = size / 2
    qx = abs(px - c) - (c - radius)
    qy = abs(py - c) - (c - radius)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    inside = min(max(qx, qy), 0.0)
    return outside + inside - radius


def render(size, maskable):
    glyph_scale = size / 32 * (0.78 if maskable else 1.0)
    offset = (size - 32 * glyph_scale) / 2 if maskable else 0.0
    pts = [(x * glyph_scale + offset, y * glyph_scale + offset + (size * 0.02 if maskable else 0)) for x, y in ROOT]
    half = STROKE * glyph_scale / 2
    radius = size * 0.22
    rows = []
    for y in range(size):
        row = bytearray([0])
        py = y + 0.5
        for x in range(size):
            px = x + 0.5
            if maskable:
                bg_a = 1.0
            else:
                bg_a = max(0.0, min(1.0, 0.5 - rounded_rect_sd(px, py, size, radius)))
            d = min(seg_dist(px, py, *pts[i], *pts[i + 1]) for i in range(len(pts) - 1))
            ink = max(0.0, min(1.0, half - d + 0.5)) * bg_a
            r = SLATE[0] * (1 - ink) + CHALK[0] * ink
            g = SLATE[1] * (1 - ink) + CHALK[1] * ink
            b = SLATE[2] * (1 - ink) + CHALK[2] * ink
            row += bytes((round(r), round(g), round(b), round(bg_a * 255)))
        rows.append(bytes(row))
    return b"".join(rows)


def png(size, raw):
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    out = Path(__file__).resolve().parent.parent / "icons"
    out.mkdir(exist_ok=True)
    for name, size, maskable in [("icon-192.png", 192, False), ("icon-512.png", 512, False), ("maskable-512.png", 512, True)]:
        (out / name).write_bytes(png(size, render(size, maskable)))
        print("wrote", out / name)


if __name__ == "__main__":
    main()
