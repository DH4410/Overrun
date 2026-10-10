"""
DEPOT detail pass: bay and pilaster plates, safety signs, roller-door ribs and signals, floor paint,
container names, crate stencils, a gantry crane, truss gussets, a safety banner and the site office's
window frames and signs.

Exec'd by build_depot.py after roundkit_dh.py, so it shares that namespace (poly, Frame, F, lathe,
tube, srgb, face_fn, onface, ...). Nothing here emits a collider, so depot.json and the map hash do
not change. Everything that stands proud of a collider is in a key the ghost probes do not look at:

    fit     small hardware and the crane (tinted per piece, slightly metallic)
    mark    matte decals: plates, paint, stains (Lambert, polygon offset, tinted)
    glyph   lit decals: signal lamps and pale door lights (unlit)
    tmark   painted text, one atlas quad per character (markkit.py type_label, src/typeAtlas.js)
    tglyph  lit text

Decals that overlap are layered at least 4 mm apart, since each key shares one polygon offset.
Pieces that exist in both halves are emitted once per half (both()) in the half's own coordinates.
"""
import re as _re

# urbankit.py owns the name `rect` (the site office uses it); the decal kit's rect becomes `mrect`.
exec(_re.sub(r'\brect\(', 'mrect(', open(os.path.join(REPO, 'scripts', 'blender', 'markkit.py')).read()))

M_WHT = srgb(0xe6e3d8)
M_BLK = srgb(0x15171a)
M_PLATE = srgb(0x1a1e22)
M_BLUE = srgb(0x1b4a8c)
M_RED = srgb(0xb3281f)
M_YEL = srgb(0xd9a900)
M_GRN = srgb(0x1f8a4c)
M_WALKWAY = srgb(0x1e6b3c)
M_GREY = srgb(0x70757a)
M_STEEL = srgb(0x474d54)
M_DARK = srgb(0x2a2e32)
M_INK = srgb(0x4a4d50)
M_STAIN = srgb(0x2b2925)
M_LIGHT = srgb(0xa9afb5)
M_CRANE = srgb(0xc29a0c)

_rs = [20241010]


def rnd():
    """A deterministic 0..1 stream, so a rebuild is byte for byte the same."""
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


def clip_x(pts, a, b):
    """Clip a convex polygon of (x, y, z) to a <= x <= b."""
    def cut(poly_, inside, hit):
        out = []
        for i, p in enumerate(poly_):
            q = poly_[(i + 1) % len(poly_)]
            pi, qi = inside(p), inside(q)
            if pi:
                out.append(p)
            if pi != qi:
                out.append(hit(p, q))
        return out

    def at(xc):
        return lambda p, q: (xc, p[1], p[2] + (q[2] - p[2]) * (xc - p[0]) / (q[0] - p[0]))
    out = cut(pts, lambda p: p[0] >= a, at(a))
    return cut(out, lambda p: p[0] <= b, at(b)) if out else out


FACE_LETTER = {'+x': 'W', '-x': 'E', '+z': 'N', '-z': 'S'}
WALL_RECT = {'+x': (-HX - 0.6, -HX, -HZ, HZ), '-x': (HX, HX + 0.6, -HZ, HZ),
             '+z': (-HX, HX, -HZ - 0.6, -HZ), '-z': (-HX, HX, HZ, HZ + 0.6)}


def pilasters(face):
    """(t, world point) of each pilaster on a wall face, the way shell() places them."""
    L, P = face_fn(face, *WALL_RECT[face])
    gap = 4.2 if face in ('+z', '-z') else 3.6
    out = []
    k = 3.0
    while k < L - 0.5:
        if abs(k - L / 2) >= gap - 0.5:
            out.append((k, P(k, 0.0)))
        k += 6.0
    return out


# ------------------------------------------------------------------ safety signs

def sign_ppe(fr, u, y):
    circle(fr, u, y, 0.006, 0.22, M_BLUE)
    quadp(fr, [(u + 0.13 * math.cos(math.pi * i / 10), y - 0.03 + 0.13 * math.sin(math.pi * i / 10)) for i in range(11)], 0.011, M_WHT)
    mrect(fr, u - 0.17, y - 0.065, u + 0.17, y - 0.03, 0.011, M_WHT)
    mrect(fr, u - 0.02, y - 0.03, u + 0.02, y + 0.08, 0.016, M_BLUE)
    label(fr, u, y - 0.36, 0.006, 'HARD HATS', fw('HARD HATS', 0.5, 0.07), M_BLK)


def sign_speed(fr, u, y):
    circle(fr, u, y, 0.006, 0.23, M_RED)
    circle(fr, u, y, 0.011, 0.165, M_WHT)
    label(fr, u, y - 0.1, 0.016, '5', 0.2, M_BLK)
    label(fr, u, y - 0.36, 0.006, 'KM/H', 0.07, M_BLK)


def sign_forklift(fr, u, y):
    quadp(fr, [(u - 0.27, y - 0.18), (u + 0.27, y - 0.18), (u, y + 0.28)], 0.006, M_YEL)
    quadp(fr, [(u - 0.2, y - 0.14), (u + 0.2, y - 0.14), (u, y + 0.2)], 0.011, M_BLK)
    quadp(fr, [(u - 0.15, y - 0.12), (u + 0.15, y - 0.12), (u, y + 0.15)], 0.016, M_YEL)
    label(fr, u, y - 0.1, 0.021, '!', 0.17, M_BLK)
    label(fr, u, y - 0.34, 0.006, 'FORKLIFTS', fw('FORKLIFTS', 0.55, 0.07), M_BLK)


SIGNS = (sign_ppe, sign_speed, sign_forklift)


def pilaster_detail(pf, face, n):
    """Hazard guard, plate and height ticks on the front of a wall pilaster (its flat front is at 0.37)."""
    z = 0.374
    for i in range(4):
        mrect(pf, -0.17, 0.62 + i * 0.15, 0.17, 0.62 + (i + 1) * 0.15, z, M_YEL if i % 2 == 0 else M_BLK)
    mrect(pf, -0.17, 1.55, 0.17, 1.78, z, M_BLUE)
    label(pf, 0.0, 1.62, z + 0.004, '%s%d' % (FACE_LETTER[face], n), 0.1, M_WHT)
    for y, txt in ((2.0, '2M'), (3.0, '3M')):
        mrect(pf, -0.17, y - 0.008, 0.0, y + 0.008, z, M_BLK)
        label(pf, 0.08, y - 0.04, z, txt, 0.06, M_BLK)


def bay_detail(fr, u, bay, wall_id):
    """What sits between two pilasters, under the clerestory: a bay number, a sign, the cabinet's or
    the extinguisher's plates, a box painted on the floor, and dirt streaks under the window."""
    label(fr, u - 1.7, 1.92, 0.006, 'BAY %d' % (bay + 1), 0.24, M_INK)
    label(fr, u - 1.7, 1.78, 0.006, wall_id, 0.08, M_INK)
    SIGNS[bay % 3](fr, u + 1.7, 2.45)
    if bay % 2 == 0:
        # the cabinet's front is at 0.26, its yellow bar at 0.292
        label(fr, u, 1.75, 0.298, 'DB %d' % (bay + 1), 0.1, M_WHT)
        quadp(fr, [(u - 0.12, 1.36), (u + 0.12, 1.36), (u, 1.58)], 0.298, M_YEL)
        quadp(fr, [(u - 0.075, 1.385), (u + 0.075, 1.385), (u, 1.52)], 0.302, M_BLK)
        label(fr, u, 1.65, 0.298, '415V', 0.065, M_YEL)
        box_c = M_YEL
    else:
        mrect(fr, u - 0.25, 0.38, u + 0.25, 0.56, 0.008, M_RED)
        label(fr, u, 0.44, 0.013, 'FIRE', fw('FIRE', 0.28, 0.1), M_WHT)
        box_c = M_RED
    f0 = Frame(fr.o[0], 0.011, fr.o[2], fr.yaw)
    bx0, bx1, bz0, bz1 = u - 0.7, u + 0.7, 0.06, 0.85
    for (a, b, c, d) in ((bx0, bz0, bx1, bz0 + 0.06), (bx0, bz1 - 0.06, bx1, bz1),
                         (bx0, bz0, bx0 + 0.06, bz1), (bx1 - 0.06, bz0, bx1, bz1)):
        fquad(f0, a, b, c, d, 0.0, box_c)
    for dx in (-1.0, -0.3, 0.55, 1.1):
        h = 0.5 + 1.0 * rnd()
        mrect(fr, u + dx - 0.04, 4.45 - h, u + dx + 0.04, 4.45, 0.004, srgb(0x77736a))


def pipe_bands(fr, L, gap):
    """Coloured service bands on the two wall pipes (y 3.4 r 0.07 and y 3.8 r 0.045, at 0.48)."""
    cols = (M_YEL, M_BLUE, M_RED, M_GRN)
    i = 0
    for a, b in ((-L / 2 + 0.2, -gap), (gap, L / 2 - 0.2)):
        t = a + 1.4
        while t < b - 0.6:
            lathe('fit', fr, 3.4, 0.48, [(0.082, t - 0.06), (0.082, t + 0.06)], 8, cols[i % 4], ax='x')
            lathe('fit', fr, 3.8, 0.48, [(0.057, t - 0.06), (0.057, t + 0.06)], 8, cols[(i + 2) % 4], ax='x')
            t += 3.0
            i += 1


def walls():
    for face, rect4 in WALL_RECT.items():
        L, P = face_fn(face, *rect4)
        gap = 4.2 if face in ('+z', '-z') else 3.6
        fr = onface(face, P, L / 2)
        pipe_bands(fr, L, gap)
        k, bay, pn = 3.0, 0, 0
        while k < L - 0.5:
            if abs(k - L / 2) >= gap - 0.5:
                pn += 1
                pilaster_detail(onface(face, P, k), face, pn)
            if k + 3.0 < L - 0.5:
                mid = k + 3.0
                dist = abs(mid - L / 2)
                door_here = (face in ('+z', '-z') and dist < 4.6) or (face in ('+x', '-x') and dist < 3.6)
                if not door_here:
                    bay_detail(fr, mid - L / 2, bay, FACE_LETTER[face])
                bay += 1
            k += 6.0
        if face in ('+z', '-z'):
            # the name of the place, in the strip between the clerestories and the cornice
            label(fr, 0.0, 6.25, 0.006, 'OVERRUN FREIGHT DEPOT', 0.3, M_INK)


# ------------------------------------------------------------------ doors

def door_bands(fr, x0, x1, y0, y1, step, z):
    """Ribs on a roller shutter leaf: bands of two slightly different greys, so it reads as slats."""
    n = int(round((y1 - y0) / step))
    h = (y1 - y0) / n
    for i in range(n):
        mrect(fr, x0, y0 + i * h, x1, y0 + (i + 1) * h - 0.01, z, srgb(0x3b4148) if i % 2 == 0 else srgb(0x30363c))


def traffic_light(fr, u, y):
    pbox('fit', fr, u, y, 0.1, 0.26, 0.64, 0.16, M_BLK)
    circle(fr, u, y + 0.18, 0.186, 0.075, srgb(0x4a1512), 'glyph', 10)
    circle(fr, u, y - 0.18, 0.186, 0.075, srgb(0x2fe070), 'glyph', 10)
    pbox('fit', fr, u, y + 0.36, 0.1, 0.32, 0.04, 0.2, M_BLK)


def control_box(fr, u, y):
    pbox('fit', fr, u, y, 0.07, 0.3, 0.44, 0.14, M_STEEL)
    for i, c in enumerate((srgb(0x2fe070), srgb(0xe03a2a), srgb(0xe8c020))):
        circle(fr, u, y + 0.12 - i * 0.12, 0.142, 0.035, c, 'glyph', 8)
    label(fr, u, y - 0.36, 0.006, 'DOOR', 0.07, M_WHT)


def hatch(fr, x0, x1, depth):
    """Yellow diagonal stripes on the floor in front of a door: fr is on the door plane, local +z
    into the hall, and the stripes lie between local z 0.15 and 0.15 + depth."""
    ff = Frame(fr.o[0], 0.011, fr.o[2], fr.yaw)
    i = 0
    while x0 - depth + i * 0.8 < x1:
        a = x0 - depth + i * 0.8
        quad = [(a, 0.0, 0.15), (a + 0.4, 0.0, 0.15), (a + 0.4 + depth, 0.0, 0.15 + depth), (a + depth, 0.0, 0.15 + depth)]
        q = clip_x(quad, x0, x1)
        if len(q) >= 3:
            upoly(ff, q, M_YEL)
        i += 1
    fquad(ff, x0, 0.15, x1, 0.2, 0.0, M_YEL)
    fquad(ff, x0, 0.15 + depth, x1, 0.2 + depth, 0.0, M_YEL)


def doors():
    for sz in (-1, 1):
        zf = sz * (HZ - 2 * TRIM)
        fr = Frame(0, 0, zf, 0.0 if sz < 0 else math.pi)       # local +z points into the hall
        door_bands(fr, -3.4, 3.4, 0.08, 4.6, 0.31, 0.02)
        for i in range(4):                                       # rust running down the leaf
            ux = -2.6 + i * 1.75 + rnd() * 0.5
            mrect(fr, ux - 0.05, 0.3 + rnd() * 1.0, ux + 0.05, 4.4 - rnd() * 0.8, 0.026, srgb(0x4b3427))
        for j in range(5):                                       # daylight lights across the leaf
            mrect(fr, -3.1 + j * 1.28, 3.55, -2.1 + j * 1.28, 3.8, 0.03, srgb(0x6c7f90), 'glyph')
        label(fr, 0.0, 2.1, 0.034, 'DOCK %d' % (1 if sz < 0 else 2), 0.62, M_YEL)
        label(fr, 0.0, 1.55, 0.034, 'KEEP CLEAR', 0.2, M_WHT)
        control_box(fr, 4.45, 1.1)
        traffic_light(fr, -4.45, 2.5)
        hatch(fr, -3.4, 3.4, 2.0)
        pbox('fit', fr, 0, 0.012, 0.05, 6.8, 0.024, 0.3, M_STEEL)     # threshold plate
    for sx in (-1, 1):
        xf = sx * (HX - 2 * TRIM)
        fr = Frame(xf, 0, 0, -sx * math.pi / 2)                  # local +z points into the hall
        door_bands(fr, -3.0, 3.0, 0.08, 3.8, 0.31, 0.02)
        for i in range(3):
            ux = -2.0 + i * 1.8 + rnd() * 0.4
            mrect(fr, ux - 0.05, 0.4 + rnd() * 0.6, ux + 0.05, 3.6 - rnd() * 0.6, 0.026, srgb(0x4b3427))
        for j in range(4):
            mrect(fr, -2.7 + j * 1.45, 3.0, -1.7 + j * 1.45, 3.25, 0.03, srgb(0x6c7f90), 'glyph')
        label(fr, 0.0, 1.7, 0.034, 'DOCK %d' % (3 if sx < 0 else 4), 0.5, M_YEL)
        control_box(fr, 3.75, 1.1)
        traffic_light(fr, -3.75, 2.5)


# ------------------------------------------------------------------ the floor

def arrow(fr, x, z, fwd, tint=M_WHT):
    """A painted route arrow on the floor, pointing along local z (fwd = +1 or -1)."""
    upoly(fr, [(x - 0.11, 0.0, z), (x + 0.11, 0.0, z), (x + 0.11, 0.0, z + fwd * 0.9), (x - 0.11, 0.0, z + fwd * 0.9)], tint)
    upoly(fr, [(x - 0.4, 0.0, z + fwd * 0.9), (x + 0.4, 0.0, z + fwd * 0.9), (x, 0.0, z + fwd * 1.7)], tint)


def floor_detail(s):
    f = F(s, 0, 0, 0.0, 0.011)
    # one-way route arrows down the aisle edges: the east lane runs south, the west lane north
    for z in (14.5, 19.4):
        arrow(f, 8.2, z, 1.0)
        arrow(f, -8.2, z, -1.0)
    # the pedestrian walkway: a green strip beside the yellow line, named, and the lanes numbered
    fquad(f, 9.7, -21.5, 10.6, 21.5, 0.0, M_WALKWAY)
    type_floor(F(s, 10.3, 14.0, math.pi / 2, 0.016), 'PEDESTRIAN', 0.3, M_WHT)
    type_floor(F(s, -15.4, 20.5, math.pi / 2, 0.016), 'LANE %d' % (1 if s > 0 else 3), 0.4, M_WHT)
    type_floor(F(s, 15.4, 20.5, math.pi / 2, 0.016), 'LANE %d' % (2 if s > 0 else 4), 0.4, M_WHT)
    type_floor(F(s, 0, 13.4, 0.0, 0.016), '5T MAX', 0.32, M_YEL)
    # speed roundels on the aisle
    for x, z in ((-7.8, 17.8), (7.8, 17.8)):
        fr = F(s, x, z, 0.0, 0.011)
        ring_decal(fr, 0, 0, 0.38, 0.0, M_RED)
        ring_decal(fr, 0, 0, 0.29, 0.004, M_WHT)
        type_floor(F(s, x, z + 0.17, 0.0, 0.0155), '5', 0.34, M_BLK)
    # drain gratings and a manhole
    for z in (16.5, 23.0):
        fr = F(s, 0, z, 0.0, 0.011)
        fquad(fr, -1.5, -0.2, 1.5, 0.2, 0.0, M_STEEL)
        for i in range(10):
            fquad(fr, -1.4 + i * 0.3, -0.14, -1.25 + i * 0.3, 0.14, 0.004, M_BLK)
    fr = F(s, 3.2, 19.6, 0.0, 0.011)
    ring_decal(fr, 0, 0, 0.5, 0.0, M_STEEL, 18)
    for i in range(3):
        fquad(fr, -0.4, -0.35 + i * 0.35, 0.4, -0.31 + i * 0.35, 0.004, M_BLK)
    # oil, tyre tracks, cracks and a repair patch
    fs = F(s, 0, 0, 0.0, 0.0115)
    for _ in range(9):
        blob(fs, (rnd() - 0.5) * 22, 5 + rnd() * 19, 0.25 + 0.5 * rnd(), M_STAIN)
    for k in (-0.9, 0.9):
        pts = [(k + 0.25 * math.sin(i * 0.5), 25.0 - i * 1.4) for i in range(9)]
        for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
            upoly(fs, [(x0 - 0.05, 0.0, z0), (x0 + 0.05, 0.0, z0), (x1 + 0.05, 0.0, z1), (x1 - 0.05, 0.0, z1)], srgb(0x46433e))
    fc = F(s, 0, 0, 0.0, 0.0118)
    for cx, cz, ang in ((-4.0, 20.0, 0.4), (6.0, 24.0, -0.8), (-13.0, 4.0, 1.9)):
        x, z = cx, cz
        for _ in range(6):
            a = ang + (rnd() - 0.5) * 0.9
            nx, nz = x + 0.45 * math.sin(a), z + 0.45 * math.cos(a)
            upoly(fc, [(x - 0.012, 0.0, z), (x + 0.012, 0.0, z), (nx + 0.012, 0.0, nz), (nx - 0.012, 0.0, nz)], srgb(0x12100e))
            x, z = nx, nz
    fp = F(s, 0, 0, 0.0, 0.0112)
    for cx, cz, w, d in ((-5.0, 8.5, 1.8, 1.0), (5.0, 24.0, 1.2, 1.5)):
        fquad(fp, cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2, 0.0, srgb(0x6e6a62))
        fquad(fp, cx - w / 2, cz - d / 2, cx + w / 2, cz - d / 2 + 0.03, 0.004, M_DARK)
        fquad(fp, cx - w / 2, cz + d / 2 - 0.03, cx + w / 2, cz + d / 2, 0.004, M_DARK)


def stage_detail(s):
    """Painted name on the deck, and plates on its long face either side of the ramp."""
    type_floor(F(s, 0, 3.2, 0.0, 1.411), 'LOADING STAGE', 0.5, M_YEL)
    fr = F(s, 0, 5.5 + 0.004, 0.0)
    for sx in (-1, 1):
        u = sx * 4.3
        mrect(fr, u - 1.6, 0.55, u + 1.6, 1.1, 0.0, M_PLATE)
        label(fr, u, 0.84, 0.004, 'STAGE 1  MAX 5 TON', 0.14, M_WHT)
        label(fr, u, 0.64, 0.004, 'ONE CRATE HIGH', 0.07, M_YEL)


# ------------------------------------------------------------------ containers, crates, barriers

_NAMES = ('NORDLINE', 'HALCYON', 'KESTREL', 'MERIDIAN', 'TIDEWAY', 'BOREAL', 'SOLENT', 'ATLAS')
_cn = [0]


def container_name(fr, tint):
    """The line's name and number on both sides, a stripe, a logo block on the closed end, a name on
    the roof, rust, and lock hardware on the door end."""
    n = _cn[0]
    _cn[0] += 1
    L, W, H = 6.06, 2.44, 2.59
    lum = 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2]
    ink = srgb(0x14161a) if lum > 0.2 else srgb(0xeae6da)
    stripe = srgb(0xe2dccb) if lum < 0.2 else srgb(0x232629)
    name = _NAMES[(n * 3 + 1) % len(_NAMES)]
    ph = min(0.44, 3.4 * 7.0 / (len(name) * 6 - 1))
    for side, yaw in ((0, 0.0), (1, math.pi)):
        sf = turn(fr, yaw)
        z = W / 2 + 0.026                     # in front of the skin's vertical ribs
        mrect(sf, -L / 2 + 0.25, 2.05, L / 2 - 0.25, 2.14, z, stripe)
        label(sf, -0.5, 1.45, z + 0.004, name, ph, ink)
        label(sf, L / 2 - 1.1, 2.3, z + 0.004, 'NLXU %06d' % ((n * 7919 + 1234 + side * 100) % 1000000), 0.1, ink)
        for _ in range(3):
            ux = (rnd() - 0.5) * (L - 1.0)
            ln = 0.4 + rnd() * 0.9
            mrect(sf, ux - 0.045, H - 0.2 - ln, ux + 0.045, H - 0.2, z + 0.004, tuple(c * 0.55 for c in tint))
    ef = turn(fr, -math.pi / 2)
    mrect(ef, -1.0, 1.0, 1.0, 1.7, L / 2 + 0.004, srgb(0xd8d3c4))
    label(ef, 0.0, 1.16, L / 2 + 0.008, name, fw(name, 1.8, 0.4), srgb(0x1b1d20))
    top = Frame(fr.o[0], fr.o[1] + H + 0.004, fr.o[2], fr.yaw)
    type_floor(top, name, 0.5, stripe)
    for _ in range(2):
        blob(top, (rnd() - 0.5) * 4.0, (rnd() - 0.5) * 1.4, 0.3 + 0.2 * rnd(), tuple(c * 0.6 for c in tint), 0.0, 8)
    for zz in (-0.75, -0.35, 0.35, 0.75):
        pbox('fit', fr, L / 2 + 0.07, 1.1, zz, 0.04, 0.2, 0.05, M_STEEL)
        pbox('fit', fr, L / 2 + 0.06, 0.35, zz, 0.05, 0.1, 0.07, M_STEEL)
        pbox('fit', fr, L / 2 + 0.06, H - 0.35, zz, 0.05, 0.1, 0.07, M_STEEL)


def crate_detail(fr, size, h):
    """Steel straps, a shipping label with a barcode, and a stencilled name and arrow."""
    hs = size / 2
    strap = srgb(0x2c2f33)
    for side in range(4):
        sf = turn(fr, side * math.pi / 2)
        z = hs + 0.004
        mrect(sf, -hs, h * 0.45, hs, h * 0.45 + 0.05, z, strap)
        mrect(sf, -hs, h * 0.12, hs, h * 0.12 + 0.04, z, strap)
        if side % 2:
            continue
        o = -1 if rnd() < 0.5 else 1
        lx = o * size * 0.2
        mrect(sf, lx - 0.17, h * 0.55, lx + 0.17, h * 0.8, z + 0.003, M_WHT)
        for j in range(5):
            mrect(sf, lx - 0.14 + j * 0.06, h * 0.58, lx - 0.125 + j * 0.06 + (j % 2) * 0.012, h * 0.7, z + 0.007, M_BLK)
        label(sf, lx, h * 0.72, z + 0.007, 'NO 7%03d' % int(rnd() * 999), 0.05, M_BLK)
        ux = -o * size * 0.24
        label(sf, ux, h * 0.6, z + 0.003, 'FRAGILE', fw('FRAGILE', size * 0.36, 0.08), M_RED)
        mrect(sf, ux - 0.02, h * 0.28, ux + 0.02, h * 0.5, z + 0.003, M_BLK)
        quadp(sf, [(ux - 0.07, h * 0.5), (ux + 0.07, h * 0.5), (ux, h * 0.62)], z + 0.003, M_BLK)
    top = Frame(fr.o[0], fr.o[1] + h + 0.004, fr.o[2], fr.yaw)
    for _ in range(2):
        blob(top, (rnd() - 0.5) * size * 0.6, (rnd() - 0.5) * size * 0.6, 0.1 + 0.1 * rnd(), srgb(0x3a2d22), 0.0, 7, 0.3)


def barrier_detail(s):
    """A name and reflectors on both faces of the two barriers in front of a spawn door, and lifting
    eyes on top. The barriers span x 2.2..6.8 either side of the centre line, at z 18."""
    for i, sx in enumerate((-1, 1)):
        xm = sx * 4.5
        for toward_centre in (True, False):
            zf = 18.0 - 0.225 - 0.007 if toward_centre else 18.0 + 0.225 + 0.007
            fr = F(s, xm, zf, math.pi if toward_centre else 0.0)
            label(fr, 0.0, 0.62, 0.0, 'BARRIER %d' % (i + 1 + (2 if s < 0 else 0)), 0.15, M_STEEL)
            for e in (-1, 1):
                mrect(fr, e * 1.9 - 0.12, 0.5, e * 1.9 + 0.12, 0.85, 0.0, M_RED if (e > 0) == toward_centre else M_WHT)
        for e in (-1.4, 1.4):
            torus('fit', F(s, xm + e, 18.0, 0.0, 1.0), 0, 0.1, 0, 0.1, 0.022, ax='x', n=10, m=5, tint=M_DARK)


def column_detail(s):
    """An ID plate on each flat of a steel column, conduit and clamps on the outer side, and a hose
    reel on the stage side of the two nearest the stage."""
    cols = ((-8.5, 12.5), (8.5, 12.5), (-8.5, 23.0), (8.5, 23.0))
    for i, (x, z) in enumerate(cols):
        fr = F(s, x, z)
        ident = 'C%d' % (i + 1 + (4 if s < 0 else 0))
        r = 0.45 * math.cos(math.pi / 12) + 0.004      # the 12-sided collider cylinder's flats
        for k in range(4):
            sf = turn(fr, -math.pi / 12 + k * math.pi / 2)
            mrect(sf, -0.1, 2.0, 0.1, 2.25, r, M_BLUE)
            label(sf, 0.0, 2.07, r + 0.004, ident, 0.1, M_WHT)
        side = 1 if x > 0 else -1
        for dz in (-0.07, 0.07):
            tube('fit', fr, [(side * 0.49, 0.35, dz), (side * 0.49, 6.8, dz)], 0.018, n=6, tint=M_STEEL, caps=True)
        for yc in (0.8, 1.9, 3.0, 4.1, 5.2, 6.3):
            pbox('fit', fr, side * 0.47, yc, 0, 0.06, 0.05, 0.22, M_DARK)
        if z < 15:
            ax = -side
            pbox('fit', fr, ax * 0.49, 1.35, 0, 0.08, 0.7, 0.55, M_RED)
            hf = turn(fr, ax * math.pi / 2)             # the cabinet's face, looking out from the column
            label(hf, 0.0, 1.54, 0.534, 'FIRE', 0.11, M_WHT)
            label(hf, 0.0, 1.38, 0.534, 'HOSE', 0.11, M_WHT)
            mrect(hf, -0.2, 1.3, 0.2, 1.33, 0.534, M_WHT)
            torus('fit', hf, 0.0, 1.1, 0.545, 0.1, 0.03, ax='z', n=12, m=5, tint=srgb(0x20252a))


# ------------------------------------------------------------------ roof, crane, banner

def roof_detail():
    # gusset plates where the truss members meet
    yb, yt = 5.95, CEIL_Y - 0.6
    for z in range(-21, 22, 7):
        for i in range(17):
            x = -HX + 0.1 + i * (2 * HX - 0.2) / 16
            pbox('fit', Frame(), x, yb + 0.02, z, 0.2, 0.2, 0.05, M_DARK)
            pbox('fit', Frame(), x, yt - 0.02, z, 0.2, 0.2, 0.05, M_DARK)
    # skylight astragals: a long bar and two cross bars on every pane
    for xc in (-10.0, 0.0, 10.0):
        for z0 in range(-24, 24, 7):
            a, b = z0 + 0.5, z0 + 6.5
            pbox('fit', Frame(), xc, CEIL_Y - 0.05, (a + b) / 2, 0.05, 0.05, b - a, M_STEEL, skip=('+y',))
            for k in (1, 2):
                pbox('fit', Frame(), xc, CEIL_Y - 0.05, a + (b - a) * k / 3, 2.6, 0.05, 0.05, M_STEEL, skip=('+y',))
    # smoke detectors between the beams
    for z in (-24.5, -17.5, -10.5, -3.5, 3.5, 10.5, 17.5, 24.5):
        for x in (-6.5, 6.5):
            lathe('fit', Frame(), x, z, [(0.0, CEIL_Y - 0.1), (0.07, CEIL_Y - 0.1), (0.11, CEIL_Y - 0.06), (0.11, CEIL_Y)], 10, M_WHT)
    # the two gantry runways, on a bracket at each pilaster
    for sx, face in ((-1, '+x'), (1, '-x')):
        pbox('fit', Frame(), sx * 16.8, 3.9, 0, 0.3, 0.3, 2 * HZ - 1.0, M_STEEL)
        pbox('fit', Frame(), sx * 16.8, 4.07, 0, 0.1, 0.05, 2 * HZ - 1.0, M_DARK)
        for _, p in pilasters(face):
            pbox('fit', Frame(), sx * 17.2, 3.62, p[2], 0.95, 0.1, 0.22, M_STEEL)
            pbox('fit', Frame(), sx * 17.55, 3.42, p[2], 0.1, 0.45, 0.22, M_STEEL)
        for ze in (-1, 1):
            pbox('fit', Frame(), sx * 16.8, 4.1, ze * 25.1, 0.4, 0.4, 0.25, M_RED)


def crane(s):
    """One of the two bridge cranes: a yellow bridge of two box girders on end trucks, a trolley
    and a hook. The girders pass under the ducts (their underside is at 5.38) and over head height."""
    zc = s * 15.0
    tx = -s * 3.0
    for sx in (-1, 1):
        pbox('fit', Frame(), sx * 16.8, 4.35, zc, 0.55, 0.5, 1.5, M_CRANE)
    for dz in (-0.55, 0.55):
        pbox('fit', Frame(), 0, 4.88, zc + dz, 33.2, 0.65, 0.3, M_CRANE)
    for sgn in (-1, 1):
        zf = zc + sgn * (0.55 + 0.154)
        fr = Frame(0, 0, zf, 0.0 if sgn > 0 else math.pi)
        label(fr, -6.0, 4.78, 0.0, '5 TON', 0.3, M_BLK)
        label(fr, 6.0, 4.84, 0.0, 'OVERRUN LIFT', 0.2, M_BLK)
        for i in range(-8, 9):
            if abs(abs(i * 2.0) - 6.0) < 1.6:
                continue
            mrect(fr, i * 2.0 - 0.025, 4.58, i * 2.0 + 0.025, 5.18, 0.004, srgb(0x6b5206))
    pbox('fit', Frame(), tx, 5.4, zc, 1.1, 0.4, 1.7, M_STEEL)
    pbox('fit', Frame(), tx, 5.62, zc, 0.6, 0.18, 0.5, M_CRANE)
    tube('fit', Frame(), [(tx, 5.2, zc), (tx, 3.9, zc)], 0.022, n=6, tint=M_DARK, caps=True)
    pbox('fit', Frame(), tx, 3.76, zc, 0.3, 0.32, 0.22, M_CRANE)
    torus('fit', Frame(), tx, 3.42, zc, 0.14, 0.03, ax='z', n=12, m=5, tint=M_DARK)
    tube('fit', Frame(), [(tx + 0.5, 5.2, zc + 0.9), (tx + 0.7, 4.7, zc + 1.0), (tx + 0.7, 4.4, zc + 1.0)], 0.012, n=5, tint=M_BLK, caps=True)


def banner(s):
    """A hung safety banner over the ramp, written on both faces and strapped to the truss."""
    z = s * 7.0
    pbox('fit', Frame(), 0, 5.15, z, 8.0, 1.2, 0.04, srgb(0x1b5a34))
    for x in (-3.8, -1.3, 1.3, 3.8):
        tube('fit', Frame(), [(x, 5.75, z), (x, 5.95, z)], 0.012, n=5, tint=M_DARK, caps=True)
    for face in (1, -1):
        fr = Frame(0, 0, z + face * 0.025, 0.0 if face > 0 else math.pi)
        label(fr, 0.0, 5.0, 0.0, 'SAFETY FIRST', 0.5, M_WHT)
        label(fr, 0.0, 4.75, 0.0, 'EVERY SHIFT EVERY TIME', 0.16, M_YEL)
        mrect(fr, -3.9, 4.6, 3.9, 4.64, 0.0, M_YEL)
        mrect(fr, -3.9, 5.7, 3.9, 5.74, 0.0, M_YEL)


# ------------------------------------------------------------------ the site office

def _frame_hole(fr, y0, y1, w, door):
    """Four bars round an opening, on the face fr (local +z out of the wall)."""
    bar = 0.06
    h = y1 - y0
    c = M_DARK if door else M_STEEL
    z = 0.025
    if not door:
        pbox('fit', fr, 0, y0 - 0.025, z + 0.03, w + 0.2, 0.05, 0.14, M_LIGHT)     # sill
        pbox('fit', fr, 0, (y0 + y1) / 2, z, 0.04, h, 0.05, c)                      # mullion
        pbox('fit', fr, 0, y0 + bar / 2, z, w, bar, 0.05, c)
    pbox('fit', fr, 0, y1 + bar / 2, z, w + 2 * bar, bar, 0.05, c)
    for sx in (-1, 1):
        pbox('fit', fr, sx * (w / 2 + bar / 2), (y0 + y1) / 2 + bar / 2, z, bar, h + bar, 0.05, c)


def office(s):
    """Frames round the openings of the roofless site office, a name over its door and a plate."""
    xa, xb, za, zb, H, t = 10.0, 17.0, 20.2, 25.6, 3.0, 0.35
    r = rnd_gen(3)                       # the same stream bldg() drew its openings from

    def holes_for(L, dl):
        hs = [(u - 0.8, u + 0.8, 0.0, 2.3) for u in dl]
        u = 1.7
        while u < L - 1.4:
            if all(abs(u - d) > 2.0 for d in dl):
                v = r()
                if v < 0.18:
                    pass
                elif v < 0.18 + 0.15:
                    hs.append((u - 1.0, u + 1.0, 0.9, H))
                else:
                    hs.append((u - 0.7, u + 0.7, 1.1, 2.1))
            u += 3.6
        return hs
    holes = {'N': holes_for(xb - xa, [3.0]), 'S': holes_for(xb - xa, []),
             'W': holes_for(zb - za - t, [2.5]), 'E': holes_for(zb - za - t, [])}
    for side, hl in holes.items():
        for (u0, u1, y0, y1) in hl:
            if y1 >= H - 0.01:
                continue                  # a wide break: no frame
            uc, w = (u0 + u1) / 2, u1 - u0
            door = y0 < 0.01
            for face in (-1, 1):
                if side in ('N', 'S'):
                    zw = za if side == 'N' else zb
                    fr = F(s, xa + uc, zw + face * (t / 2 + 0.003), 0.0 if face > 0 else math.pi)
                else:
                    xw = xa if side == 'W' else xb
                    fr = F(s, xw + face * (t / 2 + 0.003), za + t / 2 + uc, math.pi / 2 if face > 0 else -math.pi / 2)
                _frame_hole(fr, y0, y1, w, door)
    sf = F(s, xa + 3.0, za - t / 2 - 0.004, math.pi)
    mrect(sf, -0.9, 2.45, 0.9, 2.82, 0.0, M_BLUE)
    label(sf, 0.0, 2.52, 0.004, 'SITE OFFICE', fw('SITE OFFICE', 1.6, 0.17), M_WHT)
    pf = F(s, xa - t / 2 - 0.004, za + t / 2 + 2.5, -math.pi / 2)
    mrect(pf, -0.5, 2.45, 0.5, 2.78, 0.0, M_RED)
    label(pf, 0.0, 2.52, 0.004, 'STAFF ONLY', fw('STAFF ONLY', 0.9, 0.12), M_WHT)


# ------------------------------------------------------------------ lamps

def lamp_detail():
    for x, z in LAMP_AT:
        fr = Frame(x, 0, z)
        torus('fit', fr, 0, 5.62, 0, 0.5, 0.02, n=14, m=5, tint=M_DARK)
        for a in range(4):
            ang = math.pi / 4 + a * math.pi / 2
            tube('fit', fr, [(0.5 * math.cos(ang), 5.62, 0.5 * math.sin(ang)), (0.0, 5.62, 0.0)], 0.008, n=4, tint=M_DARK, caps=True)


# ------------------------------------------------------------------ entry

def per_side_detail(s):
    floor_detail(s)
    stage_detail(s)
    barrier_detail(s)
    column_detail(s)
    crane(s)
    banner(s)
    office(s)


def depot_detail():
    walls()
    doors()
    roof_detail()
    lamp_detail()
    both(per_side_detail)


# Wrap the kit's crate and container so each one placed by the layout carries its detail; the
# layout's calls and the colliders are untouched.
_crate_layout = crate
_container_layout = container


def crate(s, x, z, size=1.2, h=1.0, base=0.0, yaw=0.0):
    _crate_layout(s, x, z, size, h, base, yaw)
    crate_detail(F(s, x, z, yaw, base), size, h)


def container(s, x, z, along_x, tint, h=2.59, stack=False):
    _container_layout(s, x, z, along_x, tint, h, stack)
    container_name(F(s, x, z, 0.0 if along_x else math.pi / 2), tint)
