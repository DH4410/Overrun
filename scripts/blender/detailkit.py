"""
detailkit: the small pieces every detail pass (depotdetail.py, snowdetail.py, ...) is made of.

Exec'd by a detail script after the map's own kit and roundkit_dh.py, so it shares that namespace
(poly, Frame, F, lathe, tube, torus, srgb, newell, _vbox0 ...). It execs markkit.py with that
file's `rect` renamed `mrect`, because urbankit.py owns the name `rect` in some maps, and then adds:

    seed(n)               a deterministic 0..1 stream, so a rebuild is byte for byte the same
    pbox                  a plain six-face visual box, for hardware too small to round
    label / fw            sign text from the glyph atlas (src/typeAtlas.js) and a fit-to-width height
    circle / quadp        a disc and a polygon in a vertical frame
    fquad / ring_decal    a rectangle and a ring on a floor, deck or ramp
    blob                  an irregular stain
    pole                  a thin round upright (a marker pole, a stake, a post)

Keys (the map's MATERIALS and mapXxx.js must have them): fit = tinted hardware, mark = matte decals,
glyph = lit decals, tmark / tglyph = atlas text, painted and lit. Nothing here emits a collider.
Decals that share a key share one polygon offset, so layer them at least 4 mm apart.
"""
import re as _re

exec(_re.sub(r'\brect\(', 'mrect(', open(os.path.join(REPO, 'scripts', 'blender', 'markkit.py')).read()))

M_WHT = srgb(0xe6e3d8)
M_BLK = srgb(0x15171a)
M_BLUE = srgb(0x1b4a8c)
M_RED = srgb(0xb3281f)
M_YEL = srgb(0xd9a900)
M_GRN = srgb(0x1f8a4c)
M_STEEL = srgb(0x474d54)
M_DARK = srgb(0x2a2e32)
M_INK = srgb(0x4a4d50)

_rs = [1]


def seed(n):
    _rs[0] = n


def rnd():
    """The next number of the stream, 0..1."""
    _rs[0] = (_rs[0] * 1103515245 + 12345) & 0x7FFFFFFF
    return _rs[0] / 0x7FFFFFFF


def pbox(key, fr, cx, cy, cz, w, h, d, tint=WHITE, skip=()):
    """A plain visual box, all six faces unless skipped: the parts here are small and loose."""
    _vbox0(key, fr, cx, cy, cz, w, h, d, tint, skip)


def label(fr, u, y, z, text, ph, tint):
    type_label(fr, u, y, z, text, ph, tint, 'tmark')


def fw(text, maxw, ph):
    """The letter height that makes text fit maxw, capped at ph."""
    return min(ph, maxw * 7.0 / (len(text) * 6 - 1))


def circle(fr, u, y, z, r, tint, key='mark', n=16):
    poly(key, fr, [(u + r * math.cos(2 * math.pi * i / n), y + r * math.sin(2 * math.pi * i / n), z) for i in range(n)], tint)


def quadp(fr, pts, z, tint, key='mark'):
    """A polygon from 2-D points in the frame's x-y, wound to face +z."""
    p3 = [(x, y, z) for x, y in pts]
    if newell(p3)[2] < 0:
        p3.reverse()
    poly(key, fr, p3, tint)


def fquad(fr, x0, z0, x1, z1, y, tint, key='mark'):
    """A decal lying on a floor or a deck, corners in the frame's x and z."""
    upoly(fr, [(x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1)], tint, key)


def ring_decal(fr, cx, cz, r, y, tint, n=16):
    upoly(fr, [(cx + r * math.cos(2 * math.pi * i / n), y, cz + r * math.sin(2 * math.pi * i / n)) for i in range(n)], tint)


def blob(fr, cx, cz, r, tint, y=0.0, n=9, jitter=0.35):
    """An irregular stain: a ring of points with a different radius each."""
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        rr = r * (1.0 - jitter + jitter * 2 * rnd())
        pts.append((cx + rr * math.cos(a), y, cz + rr * math.sin(a)))
    upoly(fr, pts, tint)


def pole(fr, x, z, h, r, tint, y0=0.0, n=5):
    """A thin round upright from y0 to y0 + h at local (x, z)."""
    tube('fit', fr, [(x, y0, z), (x, y0 + h, z)], r, n=n, tint=tint, caps=True)
