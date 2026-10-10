"""
PORT detail pass: stencilled signage, windows, hazard paint, fittings and floor marks.

Exec'd by build_port.py after roundkit_dh.py, so it shares that namespace (poly, Frame, F, lathe,
tube, srgb, ...). Nothing here emits a collider, so port.json and the map hash do not change.

Everything that stands proud of a collider is in one of two keys the ghost probes do not look at:

    fit    fittings: window frames, ladders, conduit, castings, straps (a tinted, slightly metallic mesh)
    mark   decals: stencils, text, hazard paint, floor stains (a tinted mesh with a polygon offset)

Text is a 5x7 pixel face merged into runs of quads, so a container name is a few dozen faces.
"""

pbox = _vbox0                    # the plain box: 5 faces, no rounding, for parts smaller than a hand

YEL = srgb(0xd9a521)
BLK = srgb(0x1b1c1e)
WHT = srgb(0xe4e1d6)
RED = srgb(0xb3332a)
PLATE = srgb(0x22282d)
GLASS = srgb(0x1b2733)
GLASS_HI = srgb(0x3a5063)
GREY = srgb(0x70757a)
STEELC = srgb(0x474d54)
DARKC = srgb(0x2a2e32)
RIBC = srgb(0x2f3832)
JOINT = srgb(0x3b3d3c)

FACE_YAW = {'+z': 0.0, '-z': math.pi, '+x': math.pi / 2, '-x': -math.pi / 2}
# local x (left to right seen from outside) as a multiple of the canonical x (z faces) or z (x faces)
FACE_SIGN = {'+z': 1.0, '-z': -1.0, '+x': -1.0, '-x': 1.0}

_FONT = {k: v.split('/') for k, v in {
    'A': '01110/10001/10001/11111/10001/10001/10001',
    'B': '11110/10001/10001/11110/10001/10001/11110',
    'C': '01110/10001/10000/10000/10000/10001/01110',
    'D': '11100/10010/10001/10001/10001/10010/11100',
    'E': '11111/10000/10000/11110/10000/10000/11111',
    'F': '11111/10000/10000/11110/10000/10000/10000',
    'G': '01110/10001/10000/10111/10001/10001/01111',
    'H': '10001/10001/10001/11111/10001/10001/10001',
    'I': '01110/00100/00100/00100/00100/00100/01110',
    'J': '00111/00010/00010/00010/00010/10010/01100',
    'K': '10001/10010/10100/11000/10100/10010/10001',
    'L': '10000/10000/10000/10000/10000/10000/11111',
    'M': '10001/11011/10101/10101/10001/10001/10001',
    'N': '10001/11001/10101/10011/10001/10001/10001',
    'O': '01110/10001/10001/10001/10001/10001/01110',
    'P': '11110/10001/10001/11110/10000/10000/10000',
    'Q': '01110/10001/10001/10001/10101/10010/01101',
    'R': '11110/10001/10001/11110/10100/10010/10001',
    'S': '01111/10000/10000/01110/00001/00001/11110',
    'T': '11111/00100/00100/00100/00100/00100/00100',
    'U': '10001/10001/10001/10001/10001/10001/01110',
    'V': '10001/10001/10001/10001/10001/01010/00100',
    'W': '10001/10001/10001/10101/10101/10101/01010',
    'X': '10001/10001/01010/00100/01010/10001/10001',
    'Y': '10001/10001/01010/00100/00100/00100/00100',
    'Z': '11111/00001/00010/00100/01000/10000/11111',
    '0': '01110/10001/10011/10101/11001/10001/01110',
    '1': '00100/01100/00100/00100/00100/00100/01110',
    '2': '01110/10001/00001/00010/00100/01000/11111',
    '3': '11110/00001/00001/01110/00001/00001/11110',
    '4': '00010/00110/01010/10010/11111/00010/00010',
    '5': '11111/10000/11110/00001/00001/10001/01110',
    '6': '00110/01000/10000/11110/10001/10001/01110',
    '7': '11111/00001/00010/00100/01000/01000/01000',
    '8': '01110/10001/10001/01110/10001/10001/01110',
    '9': '01110/10001/10001/01111/00001/00010/01100',
    '-': '00000/00000/00000/11111/00000/00000/00000',
    '!': '00100/00100/00100/00100/00100/00000/00100',
}.items()}


def turn(fr, d):
    """The same origin, turned d radians about the vertical: another face of the same box."""
    return Frame(fr.o[0], fr.o[1], fr.o[2], fr.yaw + d)


def face_at(s, normal, pos, y=0.0):
    """A frame on a wall face of the canonical (s = 1) layout, mirrored for s = -1: local +z out of
    the face, local x left to right seen from outside. pos is the face's z (z faces) or x (x faces)."""
    if normal[1] == 'z':
        return F(s, 0.0, pos, FACE_YAW[normal], y)
    return F(s, pos, 0.0, FACE_YAW[normal], y)


def rect(fr, u0, y0, u1, y1, z, tint, key='mark'):
    poly(key, fr, [(u0, y0, z), (u1, y0, z), (u1, y1, z), (u0, y1, z)], tint)


def upoly(fr, pts, tint, key='mark'):
    """A decal on a surface that faces up (a floor, a ramp), wound whichever way that needs."""
    if newell(pts)[1] < 0:
        pts = pts[::-1]
    poly(key, fr, pts, tint)


def flat_mark(x0, z0, x1, z1, y, tint):
    xa, xb = sorted((x0, x1))
    za, zb = sorted((z0, z1))
    poly('mark', Frame(), [(xa, y, zb), (xb, y, zb), (xb, y, za), (xa, y, za)], tint)


def _runs(text, ph):
    """Pixel runs of a string in the 5x7 face, in metres: (u0, v0, u1, v1), centred on u = 0."""
    px = ph / 7.0
    text = text.upper()
    total = (len(text) * 6 - 1) * px
    out = []
    for row in range(7):
        v0 = (6 - row) * px
        for ci, ch in enumerate(text):
            g = _FONT.get(ch)
            if g is None:
                continue
            start = None
            for col in range(6):
                on = col < 5 and g[row][col] == '1'
                if on and start is None:
                    start = col
                elif not on and start is not None:
                    out.append((-total / 2 + (ci * 6 + start) * px, v0, -total / 2 + (ci * 6 + col) * px, v0 + px))
                    start = None
    return out


def text_w(text, ph):
    return (len(text) * 6 - 1) * ph / 7.0


def label(fr, u, y, z, text, ph, tint):
    """Stencilled text on a vertical face: centred on local x = u, baseline at y, z off the surface."""
    for u0, v0, u1, v1 in _runs(text, ph):
        rect(fr, u + u0, y + v0, u + u1, y + v1, z, tint)


def floor_label(fr, text, ph, tint):
    """Text painted on a floor: reads along the frame's x, its top toward the frame's -z."""
    for u0, v0, u1, v1 in _runs(text, ph):
        poly('mark', fr, [(u0, 0.0, -v0), (u1, 0.0, -v0), (u1, 0.0, -v1), (u0, 0.0, -v1)], tint)


def hazard_v(fr, u0, u1, y0, y1, z, seg=0.3):
    """A yellow and black striped post or jamb, alternating up its height."""
    n = max(1, int(round((y1 - y0) / seg)))
    h = (y1 - y0) / n
    for i in range(n):
        rect(fr, u0, y0 + i * h, u1, y0 + (i + 1) * h, z, YEL if i % 2 == 0 else BLK)


def window(fr, u, y, w, h, z):
    """A framed pane with a streak of sky in it."""
    rect(fr, u - w / 2, y, u + w / 2, y + h, z + 0.004, GLASS)
    rect(fr, u - w / 2 + 0.1, y + h * 0.1, u - w / 2 + 0.1 + w * 0.14, y + h * 0.9, z + 0.008, GLASS_HI)
    # the frame is painted on (a box each would cost five times the vertices), the sill stands out
    rect(fr, u - w / 2 - 0.07, y + h, u + w / 2 + 0.07, y + h + 0.07, z + 0.004, STEELC)
    rect(fr, u - w / 2 - 0.07, y, u - w / 2, y + h, z + 0.004, STEELC)
    rect(fr, u + w / 2, y, u + w / 2 + 0.07, y + h, z + 0.004, STEELC)
    rect(fr, u - 0.02, y, u + 0.02, y + h, z + 0.006, STEELC)                           # mullion
    rect(fr, u - w / 2 - 0.1, y - 0.07, u + w / 2 + 0.1, y, z + 0.004, GREY)            # sill


def wall_dress(s, normal, pos, a0, a1, gaps, H, T=0.5, lin=1.8, labels=None, windows=True, ribs=True):
    """Seams, windows, door frames and bay numbers on one face of a clad wall.
    (a0, a1) is the wall's run along its axis and gaps the door openings in it, in canonical
    coordinates; T is its thickness and lin the height of the lintel over an opening."""
    fr = face_at(s, normal, pos)
    k = FACE_SIGN[normal]
    cuts = [a0]
    for g0, g1 in gaps:
        cuts += [g0, g1]
    cuts.append(a1)
    for i in range(0, len(cuts), 2):
        u0, u1 = sorted((k * cuts[i], k * cuts[i + 1]))
        if u1 - u0 < 1.0:
            continue
        if ribs:
            u = u0 + 0.5
            while u < u1 - 0.3:
                rect(fr, u - 0.015, 0.15, u + 0.015, 3.0, 0.003, RIBC)
                u += 1.0
        if windows:
            # an even count keeps the panes off the mid-span steel column (clad walls have one
            # every 6 m, from their ends)
            span = u1 - u0
            n = max(2, 2 * round(span / 6.8)) if span >= 4.5 else (1 if span >= 2.6 else 0)
            for j in range(n):
                window(fr, u0 + span * (j + 0.5) / n, 3.55, 1.7, 1.0, 0.0)
    for gi, (g0, g1) in enumerate(gaps):
        ua, ub = sorted((k * g0, k * g1))
        uc = (ua + ub) / 2
        hazard_v(fr, ua - 0.3, ua, 0.0, H - lin, 0.008)
        hazard_v(fr, ub, ub + 0.3, 0.0, H - lin, 0.008)
        # the steel jambs of the opening and a header, on the edge of the gap
        for u in (ua, ub):
            pbox('fit', fr, u + (0.05 if u == ua else -0.05), (H - lin) / 2, -T / 2, 0.1, H - lin, T + 0.08, STEELC, skip=())
        # a plate on the lintel and the bay's number on it
        rect(fr, uc - 1.6, H - lin + 0.35, uc + 1.6, H - lin + 1.1, 0.008, PLATE)
        if labels and gi < len(labels):
            label(fr, uc, H - lin + 0.52, 0.012, labels[gi], 0.38, YEL)
        # a wall pack over each side of the opening
        for u in (ua - 0.9, ub + 0.9):
            rbox('fit', fr, u, H - lin - 0.25, 0.14, 0.42, 0.2, 0.28, 0.04, GREY, skip=())
            rect(fr, u - 0.15, H - lin - 0.31, u + 0.15, H - lin - 0.19, 0.282, srgb(0xfff1d6), key='lamp')


# ------------------------------------------------------------------ containers, crates, barriers

_NAMES = ('NORDLINE', 'ATLAS', 'HALCYON', 'ORCA LINE', 'VEGA', 'KESTREL', 'MERIDIAN', 'TIDEWAY', 'BOREAL', 'SOLENT')
_PREFIX = ('NLXU', 'ATLU', 'HCYU', 'ORCU')
_cd = [0]
_cr = [0]


def container_detail(fr, tint):
    """Corner castings, forklift pockets, the line's name and ID, and rust streaks down the sides."""
    n = _cd[0]
    _cd[0] += 1
    L, W, H = C_L, C_W, C_H
    lum = 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2]
    ink = srgb(0x15171a) if lum > 0.16 else srgb(0xe9e6dc)
    rust = tuple(c * 0.6 for c in tint)
    name = _NAMES[(n * 3) % len(_NAMES)]
    code = '%06d' % ((n * 7919 + 1234) % 1000000)
    ph = min(0.5, 4.0 * 7.0 / (len(name) * 6 - 1))
    for side, yaw in ((1, 0.0), (-1, math.pi)):
        sf = turn(fr, yaw)
        z = W / 2
        for k in range(2):
            ux = (((n * 37 + k * 53) % 100) / 100.0 - 0.5) * (L - 1.4)
            ln = 0.35 + ((n * 17 + k * 29) % 10) / 10.0 * 0.9
            rect(sf, ux - 0.045, H - 0.14 - ln, ux + 0.045, H - 0.14, z + 0.003, rust)
        if (n % 2 == 0) == (side > 0):
            # every other box carries its line's name, on one side (text is most of this file's size)
            label(sf, -0.55 * side, 1.5, z + 0.006, name, ph, ink)
        for x in (-1.05, 1.05):
            rect(sf, x - 0.21, 0.035, x + 0.21, 0.125, z + 0.004, srgb(0x0d0e10))
    if n % 2:
        label(turn(fr, -math.pi / 2), 0, H - 0.5, L / 2 + 0.004, code, 0.14, ink)
    cast = srgb(0x3a3d41)
    for sx in (-1, 1):
        for sz in (-1, 1):
            for yy in (0.085, H - 0.085):
                hide = ('-y', '-x' if sx > 0 else '+x', '-z' if sz > 0 else '+z')
                pbox('fit', fr, sx * (L / 2 - 0.08), yy, sz * (W / 2 - 0.08), 0.19, 0.17, 0.19, cast, skip=hide)


def crate_detail(fr, size, h):
    """A steel strap round each crate, a shipping label and a stencilled arrow."""
    n = _cr[0]
    _cr[0] += 1
    hs = size / 2
    strap = srgb(0x3b3f44)
    for side in range(4):
        sf = turn(fr, side * math.pi / 2)
        rect(sf, -hs, h * 0.475, hs, h * 0.525, hs + 0.003, strap)
        if side % 2:
            continue
        o = -1 if (n + side) % 4 == 0 else 1
        rect(sf, o * size * 0.2 - 0.17, h * 0.58, o * size * 0.2 + 0.17, h * 0.8, hs + 0.004, WHT)
        for j in range(4):
            rect(sf, o * size * 0.2 - 0.14 + j * 0.075, h * 0.6, o * size * 0.2 - 0.12 + j * 0.075, h * 0.78, hs + 0.007, BLK)
        ux = -o * size * 0.24
        rect(sf, ux - 0.025, h * 0.58, ux + 0.025, h * 0.74, hs + 0.004, BLK)
        poly('mark', sf, [(ux - 0.09, h * 0.74, hs + 0.004), (ux + 0.09, h * 0.74, hs + 0.004), (ux, h * 0.88, hs + 0.004)], BLK)


def barrier_detail(fr, length):
    """Lift holes in both faces and a reflector on each end."""
    def jx(y):
        for (xa, ya), (xb, yb) in zip(_JR, _JR[1:]):
            if ya <= y <= yb and yb > ya:
                return xa + (xb - xa) * (y - ya) / (yb - ya)
        return 0.1
    y0, y1 = 0.4, 0.52
    for sx in (-1, 1):
        for zc in (-length / 2 + 0.45, length / 2 - 0.45):
            q = [(sx * (jx(y0) + 0.004), y0, zc + 0.11), (sx * (jx(y0) + 0.004), y0, zc - 0.11),
                 (sx * (jx(y1) + 0.004), y1, zc - 0.11), (sx * (jx(y1) + 0.004), y1, zc + 0.11)]
            poly('mark', fr, q if sx > 0 else q[::-1], srgb(0x131416))
    for turn_by, col in ((0.0, RED), (math.pi, WHT)):
        rect(turn(fr, turn_by), -0.06, 0.5, 0.06, 0.6, length / 2 + 0.004, col)


def lamp_detail(fr, h):
    """A service ladder up the mast, a hazard collar, a junction box and a visor on each lamp."""
    top = h - 1.3
    for sx in (-1, 1):
        pbox('fit', fr, sx * 0.16, (1.4 + top) / 2, 0.2, 0.03, top - 1.4, 0.03, STEELC, skip=())
    y = 1.6
    while y < top:
        pbox('fit', fr, 0, y, 0.2, 0.32, 0.025, 0.025, STEELC, skip=())
        y += 0.55
    for yb in (1.9, 4.1, 6.3, 8.5):
        if yb < top:
            pbox('fit', fr, 0, yb, 0.12, 0.34, 0.03, 0.14, STEELC, skip=())
    for i in range(4):
        y0 = 1.25 + i * 0.14
        r0 = 0.115 - 0.015 * (y0 - 1.2) / 0.8
        r1 = 0.115 - 0.015 * (y0 + 0.14 - 1.2) / 0.8
        lathe('fit', fr, 0, 0, [(r0 + 0.005, y0), (r1 + 0.005, y0 + 0.14)], 12, tint=YEL if i % 2 == 0 else BLK)
    rbox('fit', fr, 0, 2.3, -0.17, 0.22, 0.34, 0.14, 0.02, GREY, skip=())
    for sx in (-0.45, 0.45):
        pbox('fit', fr, sx, h + 0.2, 1.05, 0.8, 0.04, 0.45, DARKC, skip=())


def floodlight_detail(fr):
    pbox('fit', fr, 0, 1.4, 0.3, 0.78, 0.04, 0.5, DARKC, skip=())
    pbox('fit', fr, 0, 0.95, 0.08, 0.06, 0.06, 0.2, STEELC, skip=())


def rack_detail(fr, length, depth, bays, bay):
    """Column guards on every upright and a labelled carton in every bay."""
    for i in range(bays + 1):
        zc = max(-length / 2 + 0.05, min(length / 2 - 0.05, -length / 2 + i * bay))
        for sx in (-1, 1):
            pbox('fit', fr, sx * (depth / 2 - 0.03), 0.2, zc, 0.14, 0.4, 0.14, YEL, skip=())
    xf = (depth - 0.18) / 2 + 0.004
    for side, yaw in ((1, math.pi / 2), (-1, -math.pi / 2)):
        sf = turn(fr, yaw)
        for i in range(bays):
            zc = -length / 2 + (i + 0.5) * bay
            u = -zc if side > 0 else zc
            for yb in (0.18, 1.18, 2.18):
                y = yb + 0.38
                rect(sf, u - 0.15, y, u + 0.15, y + 0.17, xf, WHT)
                for j in range(5):
                    rect(sf, u - 0.12 + j * 0.05, y + 0.03, u - 0.105 + j * 0.05, y + 0.14, xf + 0.003, BLK)


# ------------------------------------------------------------------ sheds and warehouse

def bay_outline(s, x0, z0, x1, z1, w=0.1):
    """A yellow floor-paint outline (canonical coordinates, mirrored for s = -1)."""
    for a, b, c, d in ((x0, z0, x1, z0 + w), (x0, z1 - w, x1, z1), (x0, z0, x0 + w, z1), (x1 - w, z0, x1, z1)):
        flat('lines', s * a, s * b, s * c, s * d, 0.008)


def downpipe(fr, u, zoff, h, r=0.06):
    lathe('fit', fr, u, zoff, [(r, 0.0), (r, h)], 10, tint=GREY, caps=(False, True))
    for y in (1.2, 2.8, 4.4):
        if y < h:
            lathe('fit', fr, u, zoff, [(r + 0.025, y), (r + 0.025, y + 0.05)], 10, tint=STEELC, caps=(True, True))


def cabinet(fr, u, y, w=0.9, h=1.4, d=0.25, name='480V'):
    rbox('fit', fr, u, y + h / 2, d / 2, w, h, d, 0.03, GREY, skip=())
    rect(fr, u - 0.12, y + h * 0.62, u + 0.12, y + h * 0.62 + 0.24, d + 0.004, YEL)
    label(fr, u, y + h * 0.62 + 0.04, d + 0.007, '!', 0.16, BLK)
    label(fr, u, y + h * 0.35, d + 0.004, name, 0.1, BLK)
    lathe('fit', fr, u + w * 0.3, d, [(0.025, y + 0.2), (0.025, y + h - 0.2)], 8, tint=STEELC, caps=(True, True))


def extinguisher(fr, u):
    lathe('fit', fr, u, 0.08, [(0.0, 0.95), (0.075, 0.95), (0.08, 1.0), (0.08, 1.35), (0.04, 1.43), (0.0, 1.45)], 12, tint=RED)
    rect(fr, u - 0.2, 1.62, u + 0.2, 2.02, 0.004, RED)
    label(fr, u, 1.7, 0.007, 'FIRE', 0.1, WHT)
    rect(fr, u - 0.02, 1.76 + 0.12, u + 0.02, 1.76 + 0.24, 0.007, WHT)


def shed_detail(s):
    z0, z1, SH, t = 27.0, HZ, 6.0, 0.6
    gaps = [(-11.0, -6.0), (6.0, 11.0)]
    bays = ('BAY 1', 'BAY 2') if s > 0 else ('BAY 3', 'BAY 4')
    wall_dress(s, '-z', z0 - t / 2, -15.0, 15.0, gaps, SH, T=t, lin=1.6, labels=bays)
    wall_dress(s, '+z', z0 + t / 2, -15.0, 15.0, gaps, SH, T=t, lin=1.6)
    for nm, pos in (('+x', 15.0 + t / 2), ('-x', -15.0 - t / 2), ('-x', 15.0 - t / 2), ('+x', -15.0 + t / 2)):
        wall_dress(s, nm, pos, z0 + 0.3, z1, [], SH, T=t)
    # downpipes on the outside of the two long walls, cable trays and cabinets on the inside
    for nm, pos in (('+x', 15.0 + t / 2), ('-x', -15.0 - t / 2)):
        fr = face_at(s, nm, pos)
        for z in (28.6, 36.4):
            downpipe(fr, FACE_SIGN[nm] * z, 0.09, SH - 0.2)
    for nm, pos in (('-x', 15.0 - t / 2), ('+x', -15.0 + t / 2)):
        fr = face_at(s, nm, pos)
        uc = FACE_SIGN[nm] * (z0 + z1) / 2
        pbox('fit', fr, uc, 4.85, 0.14, 10.2, 0.08, 0.28, STEELC, skip=())
        pbox('fit', fr, uc, 4.95, 0.04, 10.2, 0.06, 0.06, DARKC, skip=())
        for i in range(-4, 5):
            pbox('fit', fr, uc + i * 1.2, 4.7, 0.08, 0.05, 0.3, 0.12, STEELC, skip=())
    inn = face_at(s, '+z', z0 + t / 2)
    extinguisher(inn, -13.4)
    extinguisher(inn, 13.4)
    cabinet(inn, 0.0, 0.6)
    # numbers painted on the floor of each bay and the yellow marks the forklifts keep to
    for i, x in enumerate((-8.5, 8.5)):
        floor_label(F(s, x + 1.3, z0 - 1.6, math.pi, 0.012), 'B%d' % (i + 1 + (0 if s > 0 else 2)), 0.9, WHT)
    bay_outline(s, -4.5, 33.4, -1.5, 35.4)
    bay_outline(s, 1.5, 33.4, 4.5, 35.4)
    bay_outline(s, -12.4, 35.0, -10.0, 37.4)
    bay_outline(s, 10.0, 35.0, 12.4, 37.4)


def warehouse_detail(s):
    x0, x1, z0, z1, H, T = -46.0, -20.0, 6.0, 24.0, 6.0, 0.5
    wall_dress(s, '-z', z0 - T / 2, x0, x1, [(-36.0, -32.0)], H, T=T, labels=('DOCK 1',))
    wall_dress(s, '+z', z0 + T / 2, x0, x1, [(-36.0, -32.0)], H, T=T)
    wall_dress(s, '+z', z1 + T / 2, x0, x1, [(-42.0, -38.0)], H, T=T, labels=('DOCK 2',))
    wall_dress(s, '-z', z1 - T / 2, x0, x1, [(-42.0, -38.0)], H, T=T)
    wall_dress(s, '+x', x1 + T / 2, z0, z1, [(13.0, 17.0)], H, T=T, labels=('DOCK 3',))
    wall_dress(s, '-x', x1 - T / 2, z0, z1, [(13.0, 17.0)], H, T=T)
    wall_dress(s, '-x', x0 - T / 2, z0, z1, [(10.0, 13.5)], H, T=T, labels=('DOCK 4',))
    wall_dress(s, '+x', x0 + T / 2, z0, z1, [(10.0, 13.5)], H, T=T)
    # the building's name, big, under the windows of the long wall facing the plaza
    out = face_at(s, '-z', z0 - T / 2)
    label(out, 26.0, 0.8, 0.006, 'WHSE %d' % (4 if s > 0 else 5), 1.3, WHT)
    inn = face_at(s, '-z', z1 - T / 2)
    cabinet(inn, 28.0, 0.6, name='MCC 2')
    extinguisher(inn, 25.0)
    for nm, pos in (('-z', z0 - T / 2), ('+z', z1 + T / 2)):
        fr = face_at(s, nm, pos)
        for z in (-45.2, -20.8):
            downpipe(fr, FACE_SIGN[nm] * z, 0.09, H - 0.2)
    # a walkway and a bay number painted on the floor
    floor_label(F(s, -29.0, 7.2, math.pi, 0.012), 'W%d' % (4 if s > 0 else 5), 1.2, WHT)
    bay_outline(s, -35.0, 19.2, -29.5, 22.8)
    bay_outline(s, -28.5, 19.2, -26.0, 22.8)


# ------------------------------------------------------------------ dock, ramp, parapet

def parapet_detail(fr2):
    """Black chevrons on both faces of the yellow parapet."""
    for sf in (fr2, turn(fr2, math.pi)):
        for i in range(16):
            x0 = -4.0 + i * 0.5
            poly('mark', sf, [(x0, 0.12, 0.254), (x0 + 0.2, 0.12, 0.254), (x0 + 0.4, 0.88, 0.254), (x0 + 0.2, 0.88, 0.254)], BLK)


def ramp_detail(fr, hw, run, rise):
    """Cross grooves for grip along the slope."""
    n = int(run / 0.45)
    for i in range(1, n):
        za, zb = run * i / n - 0.025, run * i / n + 0.025
        ya, yb = rise * za / run + 0.006, rise * zb / run + 0.006
        upoly(fr, [(-hw + 0.25, ya, za), (hw - 0.25, ya, za), (hw - 0.25, yb, zb), (-hw + 0.25, yb, zb)], DARKC)


def dock_detail():
    DH = 1.4
    # a white safety line round the top, broken where the ramps land
    for x0, z0, x1, z1 in ((-7.5, 4.45, 2.0, 4.55), (7.0, 4.45, 7.5, 4.55), (-7.5, -4.55, -7.0, -4.45), (-2.0, -4.55, 7.5, -4.45),
                           (7.45, -4.5, 7.55, 4.5), (-7.55, -4.5, -7.45, 4.5)):
        flat_mark(x0, z0, x1, z1, DH + 0.006, WHT)
    floor_label(Frame(0.0, DH + 0.01, 1.6, 0.0), 'DOCK A', 0.9, WHT)
    floor_label(Frame(0.0, DH + 0.01, -1.6, math.pi), 'DOCK B', 0.9, WHT)
    # berth numbers between the fenders, and a ladder down each end
    for s in (1, -1):
        fr = face_at(s, '+z', 5.0)
        for k, xc in enumerate((-6.0, -4.0, -2.0, 0.0)):
            label(fr, xc, 0.45, 0.004, str(k + 1 + (0 if s > 0 else 4)), 0.5, WHT)
        lf = face_at(s, '+x', 8.0)
        rect(lf, 2.2, 0.1, 2.8, DH, 0.004, PLATE)
        for u in (2.3, 2.7):
            pbox('fit', lf, u, (DH + 0.9) / 2, 0.1, 0.04, DH + 0.9 - 0.1, 0.04, STEELC, skip=())
        y = 0.3
        while y < DH:
            pbox('fit', lf, 2.5, y, 0.07, 0.4, 0.03, 0.03, STEELC, skip=())
            y += 0.28
    # a drain on the deck and the manhole beside it
    flat_mark(-6.5, -0.5, -5.7, 0.5, DH + 0.006, STEELC)
    for i in range(6):
        flat_mark(-6.45 + i * 0.135, -0.46, -6.37 + i * 0.135, 0.46, DH + 0.012, BLK)


# ------------------------------------------------------------------ gantry crane

def gantry_detail(s):
    TOP = 13.0
    fr0 = F(s, 0.0, 0.0)
    for lz in (1.0, 28.5):
        for lx in (32.5, 47.0):
            fr = F(s, lx, lz)
            for side in range(4):
                sf = turn(fr, side * math.pi / 2)
                hazard_v(sf, -0.28, 0.28, 0.0, 1.8, 0.504, 0.3)
            # a ladder up the inside of the leg
            lf = turn(fr, math.pi if lx < 40 else 0.0)
            for u in (-0.2, 0.2):
                pbox('fit', lf, u, (1.0 + TOP - 0.5) / 2, 0.58, 0.04, TOP - 1.5, 0.04, STEELC, skip=())
            y = 1.1
            while y < TOP - 0.6:
                pbox('fit', lf, 0, y, 0.58, 0.4, 0.03, 0.03, STEELC, skip=())
                y += 0.55
            pbox('fit', fr, 0, TOP + 1.3, 0, 1.15, 0.1, 1.15, DARKC, skip=())
        # X-bracing across each pair of legs
        for (xa, ya, xb, yb) in ((32.5, 3.4, 47.0, TOP - 0.4), (47.0, 3.4, 32.5, TOP - 0.4)):
            tube('fit', fr0, [(xa, ya, lz), (xb, yb, lz)], 0.1, 6, tint=YEL)
    for lx in (32.5, 47.0):
        for (za, zb) in ((1.0, 28.5), (28.5, 1.0)):
            tube('fit', fr0, [(lx, 3.4, za), (lx, TOP - 0.4, zb)], 0.1, 6, tint=YEL)
    # warning light on the trolley, a window in the cab, and a container hung from the spreader
    cab = F(s, 39.75, 12.0)
    rect(turn(cab, math.pi / 2), -0.9, TOP - 1.3, 0.9, TOP - 0.3, 4.1 + 0.004, GLASS)
    lathe('lamp', cab, -6.5, 0.0, [(0.2, TOP + 3.2), (0.2, TOP + 3.5), (0.0, TOP + 3.7)], 10)
    # a container on the spreader, 7 m up: out of reach, so it is not a collider
    pbox('fit', cab, -3.0, 9.75, 0, 6.1, 0.3, 2.5, DARKC, skip=())
    vbox('far', cab, -3.0, 8.3, 0, 6.06, 2.59, 2.44, tint=CONTAINER_COLOURS[(s * 3 + 5) % len(CONTAINER_COLOURS)])
    for dx in (-2.7, 2.7):
        for dz in (-0.9, 0.9):
            tube('fit', cab, [(-3.0 + dx, 9.9, dz), (-3.0 + dx * 0.9, TOP + 2.6, dz * 0.4)], 0.035, 5, tint=DARKC, caps=False)


# ------------------------------------------------------------------ perimeter

def gate(fr):
    w, h = 10.0, 5.2
    rect(fr, -w / 2, 0.0, w / 2, h, 0.01, srgb(0x3f4e5a))
    u = -w / 2 + 0.2
    while u < w / 2 - 0.1:
        rect(fr, u, 0.0, u + 0.04, h, 0.015, srgb(0x2b3640))
        u += 0.2
    hazard_v(fr, -w / 2 - 0.35, -w / 2, 0.0, h, 0.01, 0.35)
    hazard_v(fr, w / 2, w / 2 + 0.35, 0.0, h, 0.01, 0.35)
    pbox('fit', fr, 0, h + 0.4, 0.22, w + 0.8, 0.8, 0.45, STEELC, skip=())
    label(fr, 0, h + 0.18, 0.455, 'GATE', 0.45, YEL)
    pbox('fit', fr, 0, 0.12, 0.12, w, 0.24, 0.24, YEL, skip=())
    for u in (-w / 2 - 0.5, w / 2 + 0.5):
        lathe('fit', fr, u, 0.3, [(0.12, 0.0), (0.12, 1.1), (0.0, 1.2)], 10, tint=YEL)


def perimeter_detail():
    t = 1.5
    for normal, pos, a0, a1, letter in (('-x', HX, -HZ, HZ, 'E'), ('+x', -HX, -HZ, HZ, 'W'),
                                        ('+z', -HZ, -HX, HX, 'N'), ('-z', HZ, -HX, HX, 'S')):
        fr = face_at(1, normal, pos)
        ulo, uhi = sorted((FACE_SIGN[normal] * a0, FACE_SIGN[normal] * a1))
        ltot = (a1 - a0) + 2 * t
        n = max(1, round(ltot / 6.0))
        for y in (1.2, 3.4, 5.6):
            rect(fr, ulo, y - 0.02, uhi, y + 0.02, 0.003, JOINT)
        pbox('fit', fr, (ulo + uhi) / 2, 6.15, 0.06, uhi - ulo, 0.07, 0.07, STEELC, skip=())
        for i in range(n):
            um = -ltot / 2 + ltot * (i + 0.5) / n
            if um < ulo + 0.4 or um > uhi - 0.4:
                continue
            at_gate = normal in ('-x', '+x') and abs(um) < 6.0
            if not at_gate:
                rect(fr, um - 0.02, 0.0, um + 0.02, WALL_H - 0.4, 0.003, JOINT)
            for du in (-1.5, 1.5):
                pbox('fit', fr, um + du, 6.15, 0.03, 0.05, 0.12, 0.04, STEELC, skip=())
            if i % 3 == 1 and not at_gate:
                rect(fr, um - 0.85, 3.9, um + 0.85, 4.75, 0.01, YEL)
                label(fr, um, 3.99, 0.014, '%s-%02d' % (letter, i + 1), 0.5, BLK)
            if i % 4 == 0:
                rbox('fit', fr, um + 0.7, 5.85, 0.1, 0.36, 0.3, 0.2, 0.03, GREY, skip=())
            if i % 5 == 2:
                pbox('fit', fr, um, 5.3, 0.22, 0.1, 0.1, 0.44, DARKC, skip=())
                rbox('fit', fr, um, 5.3, 0.55, 0.18, 0.16, 0.45, 0.03, srgb(0xc7c9c4), skip=())
        if normal in ('-x', '+x'):
            gate(fr)
    razor_wire()


def razor_wire():
    """Concertina along the top of the wall: a coil of thin tube, and posts every 3 m."""
    ex, ez = HX + 0.75, HZ + 0.75
    y = WALL_H + 0.2 + 0.3
    fr = Frame()
    corners = [(-ex, -ez), (ex, -ez), (ex, ez), (-ex, ez), (-ex, -ez)]
    for (xa, za), (xb, zb) in zip(corners, corners[1:]):
        length = math.hypot(xb - xa, zb - za)
        dx, dz = (xb - xa) / length, (zb - za) / length
        nx, nz = -dz, dx
        steps = int(length / 0.3)
        path = []
        for i in range(steps + 1):
            d = i * length / steps
            a = 2 * math.pi * d / 1.2
            r = 0.27
            path.append((xa + dx * d + nx * r * math.cos(a), y + r * math.sin(a), za + dz * d + nz * r * math.cos(a)))
        tube('fit', fr, path, 0.02, 3, tint=GREY, caps=False)
        for i in range(int(length / 3.0) + 1):
            d = i * 3.0
            pbox('fit', fr, xa + dx * d, WALL_H + 0.2 + 0.25, za + dz * d, 0.05, 0.5, 0.05, STEELC)


# ------------------------------------------------------------------ the ground

def floor_marks():
    OIL = srgb(0x191a1d)
    PATCH = srgb(0x585b60)
    TRACK = srgb(0x36383b)
    PAINT = srgb(0xd0d2cd)

    def blob(fr, x, z, r, seed, tint):
        pts = []
        for k in range(12):
            a = 2 * math.pi * k / 12
            rr = r * (0.7 + 0.5 * _hash3(seed, k, 7))
            pts.append((x + rr * math.cos(a), z + rr * math.sin(a) * 0.8))
        upoly(fr, [(px, 0.0, pz) for px, pz in pts], tint)

    def strip(fr, pts, w, tint):
        for (xa, za), (xb, zb) in zip(pts, pts[1:]):
            d = math.hypot(xb - xa, zb - za)
            nx, nz = -(zb - za) / d * w / 2, (xb - xa) / d * w / 2
            upoly(fr, [(xa - nx, 0.0, za - nz), (xb - nx, 0.0, zb - nz), (xb + nx, 0.0, zb + nz), (xa + nx, 0.0, za + nz)], tint)

    def arrow(fr, x, z, yaw, tint):
        c, sn = math.cos(yaw), math.sin(yaw)
        # shaft and head in a local (right, forward) frame, forward = -z at yaw 0
        pts = [(-0.12, 0.0), (0.12, 0.0), (0.12, 1.2), (0.45, 1.2), (0.0, 2.0), (-0.45, 1.2), (-0.12, 1.2)]
        out = [(x + px * c - (-py) * sn, 0.0, z + px * sn + (-py) * c) for px, py in pts]
        upoly(fr, [out[0], out[1], out[2], out[6]], tint)         # shaft
        upoly(fr, [out[3], out[4], out[5]], tint)                 # head

    def per_side(s):
        fr = F(s, 0.0, 0.0, 0.0, 0.01)
        # expansion joints in the apron in front of each shed
        for i in range(-4, 5):
            flat_mark(s * (i * 4.25) - 0.015, s * 23.5, s * (i * 4.25) + 0.015, s * HZ, 0.01, JOINT)
        for z in (26.5, 30.0, 33.5, 37.0):
            flat_mark(s * -17.0, s * z - 0.015, s * 17.0, s * z + 0.015, 0.01, JOINT)
        # oil, patched asphalt and a crack or two
        for i, (x, z, r) in enumerate(((-6.5, 17.5, 0.9), (10.5, 8.0, 0.7), (24.5, -9.0, 1.1), (31.0, 18.0, 0.8),
                                      (-22.0, 27.0, 0.7), (-3.5, 33.5, 0.6), (17.5, 27.5, 0.9), (-33.0, 2.5, 0.8))):
            blob(fr, x, z, r, i + (0 if s > 0 else 9), OIL)
        for i, (x, z, w, d) in enumerate(((-15.0, 10.0, 2.4, 1.5), (17.0, 15.0, 1.8, 2.6), (30.0, -4.0, 3.0, 1.4), (-8.0, 26.0, 2.0, 1.2))):
            upoly(fr, [(x - w / 2, 0.0, z - d / 2), (x + w / 2, 0.0, z - d / 2), (x + w / 2, 0.0, z + d / 2), (x - w / 2, 0.0, z + d / 2)], PATCH)
        strip(fr, [(-19.0, 14.0), (-17.2, 14.8), (-16.0, 13.9), (-14.1, 14.6), (-12.8, 15.9)], 0.04, OIL)
        strip(fr, [(18.0, -8.0), (19.4, -7.1), (20.1, -5.5), (21.8, -4.9)], 0.04, OIL)
        # two pairs of tyre tracks swinging out of the container yard
        for off in (-0.9, 0.9):
            strip(fr, [(24.0 + 14 * t / 8, 14.0 + off + 3.5 * math.sin(t / 8 * 2.6)) for t in range(9)], 0.22, TRACK)
            strip(fr, [(-4.0 + 12 * t / 8, 21.0 + off + 2.0 * math.sin(t / 8 * 3.0)) for t in range(9)], 0.22, TRACK)
        # drains, with their slots, and a manhole
        for x, z in ((0.0, 9.0), (-16.5, 0.0), (23.0, 29.0), (-9.0, 31.0)):
            upoly(fr, [(x - 0.4, 0.0, z - 0.25), (x + 0.4, 0.0, z - 0.25), (x + 0.4, 0.0, z + 0.25), (x - 0.4, 0.0, z + 0.25)], STEELC)
            for j in range(6):
                upoly(fr, [(x - 0.3 + j * 0.12, 0.0, z - 0.2), (x - 0.25 + j * 0.12, 0.0, z - 0.2),
                           (x - 0.25 + j * 0.12, 0.0, z + 0.2), (x - 0.3 + j * 0.12, 0.0, z + 0.2)], BLK)
        for x, z in ((-9.0, 17.0), (17.0, -9.0)):
            upoly(fr, [(x + 0.4 * math.cos(2 * math.pi * k / 14), 0.0, z + 0.4 * math.sin(2 * math.pi * k / 14)) for k in range(14)], DARKC)
            upoly(fr, [(x + 0.3 * math.cos(2 * math.pi * k / 14), 0.0, z + 0.3 * math.sin(2 * math.pi * k / 14)) for k in range(14)], STEELC)
        # lane arrows in the approach, and bay names in the container yard
        for x in (-6.0, 6.0):
            arrow(fr, x, 20.5, math.pi, PAINT)
        arrow(fr, -9.0, 8.0, math.pi, PAINT)
        floor_label(F(s, 28.0, -6.0, 0.0, 0.012), 'Y1', 1.0, PAINT)
        floor_label(F(s, 36.0, -8.0, 0.0, 0.012), 'Y2', 1.0, PAINT)
        floor_label(F(s, -24.0, 29.0, 0.0, 0.012), 'P%d' % (1 if s > 0 else 2), 1.0, PAINT)
    both(per_side)


# ------------------------------------------------------------------ beyond the wall

def backdrop_detail():
    qx = HX + 22
    red = srgb(0xc3462f)
    for zc in (-50, 5, 60):
        cr = Frame(qx + 4, 0, zc)
        for (dx0, dz0, dx1, dz1) in ((-8, -8, 8, -8), (-8, 8, 8, 8), (-8, -8, -8, 8), (8, -8, 8, 8)):
            for (ya, yb) in ((2.0, 20.0), (22.0, 41.0)):
                tube('far', cr, [(dx0, ya, dz0), (dx1, yb, dz1)], 0.28, 6, tint=red)
                tube('far', cr, [(dx1, ya, dz1), (dx0, yb, dz0)], 0.28, 6, tint=red)
        for y in (21.0, 41.5):
            vbox('far', cr, 0, y, -8, 16, 0.6, 0.6, tint=red)
            vbox('far', cr, 0, y, 8, 16, 0.6, 0.6, tint=red)
            vbox('far', cr, -8, y, 0, 0.6, 0.6, 16, tint=red)
            vbox('far', cr, 8, y, 0, 0.6, 0.6, 16, tint=red)
        for sz in (-1, 1):
            path = [(-20.0 + 3.8 * i, 44.9 if i % 2 == 0 else 47.1, sz * 2.55) for i in range(21)]
            tube('far', cr, path, 0.14, 4, tint=red, caps=False)
        tube('far', cr, [(-4, 64, 0), (57, 47.5, 0)], 0.18, 5, tint=srgb(0x30343a))
        tube('far', cr, [(-4, 64, 0), (-22, 46, 0)], 0.18, 5, tint=srgb(0x30343a))
    # the ship: a block of bridge windows, the funnel, a mast
    hull_x = qx + 16
    for row in range(5):
        vbox('far', Frame(), hull_x - 13.1, 14.0 + row * 3.4, 78, 0.3, 1.2, 13.0, tint=srgb(0x232a31))
    lathe('far', Frame(), hull_x + 2.0, 78, [(3.0, 32.0), (3.0, 38.0), (2.7, 38.5)], 14, tint=red, caps=(False, True))
    tube('far', Frame(), [(hull_x, 32.0, 72), (hull_x, 46.0, 72)], 0.25, 6, tint=srgb(0xd8dadc))
    # the west warehouses: ribs and roller doors on the face toward the yard
    for zc, w, d, h in ((-40, 40, 26, 16), (0, 40, 30, 19), (38, 40, 24, 15)):
        xf = -HX - 30 + w / 2
        for i in range(int(d / 2.5)):
            vbox('far', Frame(), xf + 0.07, h / 2, zc - d / 2 + 1.25 + i * 2.5, 0.14, h, 0.18, tint=srgb(0x7b8288))
        for dz in (-d / 4, d / 4):
            vbox('far', Frame(), xf + 0.05, 2.6, zc + dz, 0.1, 5.2, 5.0, tint=srgb(0x4b5258))
