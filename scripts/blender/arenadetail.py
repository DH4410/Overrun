"""
ARENA detail pass: signage, the crowd, fittings, floor marks and wear.

Exec'd by build_arena.py after its own helpers, so it shares that namespace (QF, RP, lathe, tube,
vbox, srgb, ...). Nothing here emits a collider, so arena.json and the map hash do not change.

Everything that stands proud of a collider is in a key the ghost probes do not look at:

    fit    fittings: brackets, cameras, cabinets, collars (a tinted, slightly metallic mesh)
    mark   decals: text, plates, stains, joints, the crowd (a tinted mesh with a polygon offset)
    metal  rails, lattice, housings (already there)

Text is the 5x7 face of markkit.py, merged into runs of quads. Decals that overlap are layered
at least 4 mm apart, since they share one polygon offset.
"""

exec(open(os.path.join(REPO, 'scripts', 'blender', 'markkit.py')).read())   # font, rect, label, ...

pbox = _vbox0                    # the plain box: 5 faces, no rounding, for parts smaller than a hand

# colours: paint and plates are sRGB hex, the kit linearises them
A_YEL = srgb(0xd0a722)
A_WHT = srgb(0xe6e3d8)
A_RED = srgb(0xb3332a)
A_BLK = srgb(0x15171a)
A_PLATE = srgb(0x1d2126)
A_STEEL = srgb(0x474d54)
A_GREY = srgb(0x70757a)
A_JOINT = srgb(0x060607)
A_STAIN = srgb(0x2a2a2c)
A_STREAK = srgb(0x55534d)
A_GLASS = srgb(0x151d27)
A_GREEN = srgb(0x2f7a55)

BRANDS = (
    ('KESTREL ARMS', srgb(0x8a2a24)), ('HALCYON', srgb(0x1f4a7c)), ('NORDLINE', srgb(0x1f6a4b)),
    ('ORCA LINE', srgb(0x2a5a78)), ('MERIDIAN', srgb(0x6a4a1c)), ('VEGA CELLS', srgb(0x4a2a6a)),
    ('ATLAS', srgb(0x7a3a18)), ('TIDEWAY', srgb(0x1a5a60)),
)

_rs = [20240611]


def rnd():
    """A deterministic 0..1 stream, so a rebuild is byte for byte the same."""
    _rs[0] = (_rs[0] * 1103515245 + 12345) & 0x7FFFFFFF
    return _rs[0] / 0x7FFFFFFF


def sub(fr, x, y, z, d=0.0):
    """A frame at local (x, y, z) of fr, turned d about the vertical."""
    wx, wy, wz = fr.world((x, y, z))
    return Frame(wx, wy, wz, fr.yaw + d)


def facing_yaw(x, z):
    """The yaw of a floor frame whose top (local -z) points away from the middle, for text to be
    read by someone standing in the middle."""
    return math.atan2(-x, -z)


def wire(fr, pts, r, tint, n=5):
    tube('fit', fr, pts, r, n=n, tint=tint, caps=False)


# ------------------------------------------------------------------ the perimeter wall

def hoarding(fi, u, w, brand, y0=0.9, y1=2.7):
    """An advertising board on the wall: a dark frame, a coloured field, the name and two rules."""
    name, col = brand
    rect(fi, u - w / 2, y0, u + w / 2, y1, 0.004, A_STEEL)
    rect(fi, u - w / 2 + 0.1, y0 + 0.1, u + w / 2 - 0.1, y1 - 0.1, 0.010, col)
    ph = min(0.55, (w - 0.8) * 7.0 / (len(name) * 6 - 1))
    label(fi, u, (y0 + y1) / 2 - ph / 2 + 0.1, 0.016, name, ph, A_WHT)
    rect(fi, u - w / 2 + 0.3, y1 - 0.42, u + w / 2 - 0.3, y1 - 0.36, 0.016, A_WHT)
    rect(fi, u - w / 2 + 0.3, y0 + 0.36, u + w / 2 - 0.3, y0 + 0.42, 0.016, A_WHT)


def camera(fr, x, y, z, yaw):
    """A dome-and-arm security camera on a wall bracket, aimed along yaw (about fr's vertical)."""
    mount = sub(fr, x, y, z, yaw)
    pbox('fit', fr, x, y, z + 0.12, 0.07, 0.07, 0.24, A_STEEL, ())
    pbox('fit', mount, 0, -0.04, 0.32, 0.2, 0.17, 0.5, A_GREY, ())
    lathe('fit', mount, 0, -0.04, [(0.0, 0.57), (0.055, 0.57), (0.075, 0.6), (0.075, 0.64), (0.0, 0.64)], n=8, tint=A_BLK, ax='z')
    pbox('beacon', mount, 0.1, 0.0, 0.12, 0.04, 0.04, 0.04, WHITE, ())


def wall_detail(k):
    fi = QF(k, 0, HZ, math.pi)             # local +z into the pit, the wall face is z = 0

    # --- over the gate: a sign plate and the chevrons either side
    rect(fi, -2.6, 5.0, 2.6, 6.1, 0.004, A_PLATE)
    rect(fi, -2.5, 5.1, 2.5, 5.12, 0.010, A_YEL)
    rect(fi, -2.5, 5.98, 2.5, 6.0, 0.010, A_YEL)
    label(fi, 0.0, 5.32, 0.016, 'GATE %d' % (k + 1), 0.5, A_YEL)
    for sx in (-1, 1):
        for j in range(3):
            x = sx * (3.25 + j * 0.45)
            a = sx * 0.28
            pts = [(x - a, 5.15, 0.008), (x + a, 5.55, 0.008), (x - a, 5.95, 0.008),
                   (x - a - sx * 0.14, 5.95, 0.008), (x + a - sx * 0.14, 5.55, 0.008), (x - a - sx * 0.14, 5.15, 0.008)]
            if newell(pts)[2] < 0:
                pts.reverse()
            poly('mark', fi, pts, A_YEL)

    # --- the shutter: slat lines across the door, and a caution plate
    for j in range(1, 28):
        y = j * 0.12
        rect(fi, -3.4, y, 3.4, y + 0.012, 0.012, srgb(0x1c1f23))
    rect(fi, -1.0, 2.55, 1.0, 3.0, 0.020, A_YEL)
    label(fi, 0.0, 2.6, 0.028, 'CAUTION', 0.22, A_BLK)

    # --- a lamp on each stub wall, looking down the lane
    for sx in (-1, 1):
        face = sub(fi, sx * 5.2, 0.0, 3.0, -sx * math.pi / 2)
        pbox('fit', face, 0, 2.7, 0.07, 0.34, 0.2, 0.14, A_GREY, ())
        pbox('glow', face, 0, 2.7, 0.15, 0.26, 0.12, 0.02, WHITE, ())

    # --- the bays between the pilasters
    names = [BRANDS[(k * 3 + i) % len(BRANDS)] for i in range(6)]
    for bi, u in enumerate((-23.0, -15.0, 15.0, 23.0)):
        hoarding(fi, u, 6.4, names[bi])
    hoarding(fi, -29.3, 3.0, names[4])
    hoarding(fi, 29.3, 3.0, names[5])

    # --- sector numbers on the pilasters
    xs = [-27.0, -19.0, -11.0, 11.0, 19.0, 27.0]
    for i, x in enumerate(xs):
        rect(fi, x - 0.28, 3.85, x + 0.28, 4.5, 0.206, A_PLATE)
        label(fi, x, 4.0, 0.212, '%s%d' % ('ABCD'[k], i + 1), 0.28, A_YEL)
        rect(fi, x - 0.28, 3.78, x + 0.28, 3.82, 0.212, A_YEL)

    # --- the gate-side bays: hose cabinet, extinguisher, first aid
    for sx in (-1, 1):
        x = sx * 8.3
        rbox('fit', fi, x, 1.45, 0.14, 0.6, 1.0, 0.28, 0.03, A_RED, ())
        rect(fi, x - 0.22, 1.45, x + 0.22, 1.88, 0.286, srgb(0x2a3a44))
        rect(fi, x - 0.2, 1.05, x + 0.2, 1.33, 0.286, A_WHT)
        label(fi, x, 1.12, 0.292, 'FIRE', 0.14, A_RED)
        ex = x + sx * 0.75
        lathe('fit', fi, ex, 0.3, [(0.0, 0.45), (0.1, 0.45), (0.11, 0.49), (0.11, 1.0), (0.07, 1.1), (0.04, 1.15), (0.0, 1.15)], n=10, tint=A_RED)
        pbox('fit', fi, ex, 0.85, 0.1, 0.24, 0.05, 0.2, A_STEEL, ())
        fx = x - sx * 0.85
        rect(fi, fx - 0.3, 1.5, fx + 0.3, 2.1, 0.004, A_GREEN)
        rect(fi, fx - 0.06, 1.62, fx + 0.06, 1.98, 0.010, A_WHT)
        rect(fi, fx - 0.18, 1.74, fx + 0.18, 1.86, 0.010, A_WHT)

    # --- cameras at the pilasters nearest each gate, looking out over the pit
    for sx in (-1, 1):
        camera(fi, sx * 11.0, 5.1, 0.2, -sx * 0.45)

    # --- conduit along the wall under the coping, stood off on brackets, with junction boxes
    for yy in (6.02, 6.16):
        for a, b in ((-31.4, -5.0), (5.0, 31.4)):
            wire(fi, [(a, yy, 0.27), (b, yy, 0.27)], 0.035, A_GREY, n=6)
    for x in xs + [-31.0, -7.5, 7.5, 31.0]:
        pbox('fit', fi, x, 6.09, 0.2, 0.06, 0.26, 0.14, A_STEEL, ())
    for x in (-15.0, 15.0, -23.0, 23.0):
        rbox('fit', fi, x, 6.09, 0.3, 0.34, 0.34, 0.16, 0.03, A_GREY, ())

    # --- downpipes in the corners, with their brackets, and a cable run down from each wall lamp
    for sx in (-1, 1):
        x = sx * 31.3
        wire(fi, [(x, 0.4, 0.13), (x, 6.2, 0.13)], 0.07, A_GREY, n=8)
        for y in lin(0.8, 5.8, 5):
            pbox('fit', fi, x, y, 0.06, 0.2, 0.05, 0.12, A_STEEL, ())
        pbox('fit', fi, x, 6.3, 0.17, 0.3, 0.3, 0.34, A_STEEL, ())
    for x in (-15.0, 15.0, -23.0, 23.0):
        wire(fi, [(x + 0.4, 4.6, 0.12), (x + 0.4, 3.4, 0.12)], 0.02, A_BLK, n=4)

    # --- water streaks under the lamps and vents, the coping and the string course
    for x in (-23.0, -15.0, 15.0, 23.0):
        for j in range(5):
            u = x - 0.5 + rnd() * 1.0
            y1 = 4.4 - rnd() * 0.1
            rect(fi, u, y1 - 0.55 - rnd() * 0.5, u + 0.04 + rnd() * 0.03, y1, 0.003, A_STREAK)
    for sx in (-1, 1):
        for j in range(8):
            u = sx * (11.6 + rnd() * 19.0)
            y1 = 6.3
            rect(fi, u, y1 - 0.6 - rnd() * 0.9, u + 0.03 + rnd() * 0.04, y1, 0.003, A_STREAK)

    # --- expansion joints in the wall between the pilasters
    for u in (-29.5, -25.0, -21.0, -17.0, -13.0, 13.0, 17.0, 21.0, 25.0, 29.5):
        rect(fi, u - 0.012, 3.4, u + 0.012, 6.3, 0.003, A_JOINT)


# ------------------------------------------------------------------ the stands

def person(ff, u, y0, shirt, skin):
    """A seated figure as a flat cut-out: shoulders and a head, standing out above the seat back."""
    poly('mark', ff, [(u - 0.23, y0, 0.0), (u + 0.23, y0, 0.0), (u + 0.19, y0 + 0.4, 0.0), (u - 0.19, y0 + 0.4, 0.0)], shirt)
    cy = y0 + 0.54
    hr = 0.115
    hx = [(u + hr * math.cos(a), cy + hr * 1.1 * math.sin(a), 0.0) for a in (0.0, 1.05, 2.09, 3.14, 4.19, 5.24)]
    poly('mark', ff, hx, skin)


SHIRTS = [srgb(h) for h in (0x8a3a32, 0x35568a, 0xc2a23c, 0x3c7a62, 0xd8d4c8, 0x2a2e36, 0x7a4a8a, 0xc26a2c, 0x4a6a9a, 0x9a9a9a)]
SKINS = [srgb(h) for h in (0xe0b090, 0xc58c63, 0x8a5a3a, 0x5a3a28)]


def stands_detail(k):
    t = 1.6
    w = 2 * (HX + t) + 4.0
    nsec = 8
    sw = (w - 1.0) / nsec
    for i in range(4):
        d0 = HZ + t + 0.8 + i * 2.4
        h = 7.4 + i * 2.2
        ff = QF(k, 0, d0, math.pi)                 # on the slab's pit-facing front face, +z toward the pit
        # --- the advertising fascia: one board per section on the visible band of each riser
        if i >= 1:
            y0 = h - 0.85
            for s in range(nsec):
                u = w / 2 - 0.5 - sw * (s + 0.5)
                name, col = BRANDS[(s + i + k * 2) % len(BRANDS)]
                rect(ff, u - sw / 2 + 0.3, y0, u + sw / 2 - 0.3, y0 + 0.7, 0.01, col)
                ph = min(0.4, (sw - 1.6) * 7.0 / (len(name) * 6 - 1))
                label(ff, u, y0 + 0.35 - ph / 2, 0.016, name, ph, A_WHT)
        # --- the people, in front of each seat back
        fill = 0.62 if i == 0 else 0.5
        for s in range(nsec):
            xc = -w / 2 + 0.5 + sw * (s + 0.5)
            half = (sw - 0.5) / 2
            for zr in (-0.6, 0.6):
                zz = -(zr + 0.15 + 1.2) + 0.006
                f = sub(ff, 0, 0, zz)
                j = 0
                while 0.26 + j * 0.52 < 2 * half:
                    if rnd() < fill:
                        u = -(xc - half + 0.26 + j * 0.52)        # ff's x runs against the slab's
                        person(f, u, h + 0.45, SHIRTS[int(rnd() * len(SHIRTS))], SKINS[int(rnd() * len(SKINS))])
                    j += 1


def scoreboard(k):
    """A video board over the top tier, on two legs, with the wave and the clock on it. The frame is
    the 'stands' key (flat paint, no shadow) so a 24 m board does not lay a stripe across the pit."""
    z = HZ + 1.6 + 0.8 + 4 * 2.4 + 3.0
    fb = QF(k, 0, z, math.pi)
    for sx in (-1, 1):
        pbox('stands', fb, sx * 6.2, 11.0, 0.0, 0.7, 22.0, 0.7, A_PLATE, ('-y',))
    pbox('stands', fb, 0, 20.5, 0.0, 17.0, 7.0, 1.0, A_PLATE, ())
    pbox('stands', fb, 0, 24.4, 0.0, 17.6, 0.35, 1.3, A_STEEL, ())
    pbox('stands', fb, 0, 20.5, 0.52, 15.8, 5.8, 0.02, A_GLASS, ())
    rect(fb, -7.9, 17.65, 7.9, 17.75, 0.54, srgb(0xd0702a), key='glow')
    for yy, text, ph in ((21.4, 'OVERRUN ARENA', 1.15), (19.3, 'SURVIVE', 1.0), (18.0, 'WAVE 00   00:00', 0.7)):
        for u0, v0, u1, v1 in _runs(text, ph):
            rect(fb, u0, yy + v0, u1, yy + v1, 0.54, WHITE, key='glow')


# ------------------------------------------------------------------ towers

def tower_detail(sx, sz):
    P = 38.0
    x, z = sx * P, sz * P
    fr = Frame(x, 0, z, math.atan2(-x, -z))      # local +z looks at the middle of the pit
    top = 25.0
    # lens cans in each cell of the lamp bank: four to a cell, between the cross bars
    for gx in (-2.07, 0.0, 2.07):
        for ox in (-0.5, 0.5):
            for gy in (27.1, 28.1):
                lathe('fit', fr, gx + ox, gy, [(0.0, 0.40), (0.28, 0.40), (0.30, 0.44), (0.30, 0.52), (0.25, 0.56)], n=12, tint=A_STEEL, ax='z')
                lathe('glow', fr, gx + ox, gy, [(0.24, 0.565), (0.0, 0.565)], n=12, ax='z')
    # the platform rail, with a beacon on each of the two corners that face the pit
    for cx_, cz_ in ((-1.15, -1.15), (1.15, -1.15), (1.15, 1.15), (-1.15, 1.15)):
        pbox('fit', fr, cx_, top + 0.85, cz_, 0.05, 1.1, 0.05, A_GREY, ())
    ring_pts = [(-1.15, -1.15), (1.15, -1.15), (1.15, 1.15), (-1.15, 1.15), (-1.15, -1.15)]
    for yr in (top + 0.6, top + 1.1):
        wire(fr, [(a, yr, b) for a, b in ring_pts], 0.022, A_GREY, n=5)
    for bx in (-1.15, 1.15):
        lathe('beacon', fr, bx, 1.15, [(0.0, top + 1.4), (0.1, top + 1.4), (0.08, top + 1.52), (0.0, top + 1.6)], n=10)

    # a ladder up one leg: two rails, rungs, and cage rings from 3 m up
    def leg_f(yy):
        return 1.15 - 0.55 * (yy / top)
    for off in (-0.45, -0.15):
        wire(fr, [(-leg_f(yy) + off, yy, -leg_f(yy)) for yy in lin(1.0, top - 0.3, 8)], 0.02, A_GREY, n=5)
    for yy in lin(1.2, top - 0.4, 52):
        pbox('fit', fr, -leg_f(yy) - 0.3, yy, -leg_f(yy), 0.3, 0.03, 0.04, A_GREY, ())
    for yr in lin(3.0, top - 1.0, 5):
        f = leg_f(yr)
        wire(fr, [(-f - 0.3 + 0.28 * math.cos(a), yr, -f + 0.3 * math.sin(a)) for a in [i * math.pi / 6 for i in range(13)]], 0.015, A_GREY, n=4)
    # a power cable down the middle of the mast to the footing, and a cabinet beside it
    wire(fr, [(0.0, top - 0.2, 0.0), (0.0, 1.0, 0.0)], 0.04, A_BLK, n=6)
    rbox('fit', fr, 2.1, 0.9, 0.0, 0.8, 1.8, 0.6, 0.04, A_GREY, ())


# ------------------------------------------------------------------ the pit

def dais_detail():
    H = DAIS_H
    # the name painted on the top, with SURVIVE under it: reads from the south steps
    t0 = Frame(0.0, H + 0.014, 0.0, 0.0)
    for u0, v0, u1, v1 in _runs('OVERRUN', 1.05):
        upoly(t0, [(u0, 0.0, 0.5 - v0), (u1, 0.0, 0.5 - v0), (u1, 0.0, 0.5 - v1), (u0, 0.0, 0.5 - v1)], A_WHT)
    for u0, v0, u1, v1 in _runs('SURVIVE', 0.5):
        upoly(t0, [(u0, 0.0, 1.9 - v0), (u1, 0.0, 1.9 - v0), (u1, 0.0, 1.9 - v1), (u0, 0.0, 1.9 - v1)], A_YEL)
    for k in range(4):
        fk = QF(k, 0, 0)
        # handrails down both sides of the steps: balusters from the floor, two rails
        zs = [11.0, 9.6, 8.2, 7.2]
        hs = [0.225 * i for i in (1, 2, 3, 3)]
        for sx in (-1, 1):
            xs_ = sx * 2.12
            for zq, hq in zip(zs, hs):
                pbox('metal', fk, xs_, (hq + 1.0) / 2, zq, 0.06, hq + 1.0, 0.06, WHITE, ('-y',))
            for off in (0.55, 0.95):
                wire(fk, [(xs_, hq + off, zq) for zq, hq in zip(zs, hs)], 0.025, A_STEEL, n=6)
            # a bollard at the foot of each rail
            lathe('fit', fk, xs_, 11.7, [(0.0, 0.0), (0.1, 0.0), (0.1, 0.8), (0.07, 0.86), (0.0, 0.86)], n=10, tint=A_YEL)
            lathe('fit', fk, xs_, 11.7, [(0.105, 0.45), (0.105, 0.55)], n=10, tint=A_BLK)
        # a light strip under each nosing
        for i in (1, 2, 3):
            zf = 7.0 + (3 - i) * 1.4 + 1.4
            pbox('glow', fk, 0, 0.225 * i - 0.1, zf + 0.012, 3.0, 0.05, 0.02, WHITE, ())
        # a steel cap on each parapet and a pair of lights on it
        fp = QF(k, 4.9, 4.9, math.pi / 4, H)
        pbox('fit', fp, 0, 1.02, 0.0, 2.7, 0.04, 0.6, A_STEEL, ())
        for xo in (-0.9, 0.9):
            pbox('beacon', fp, xo, 1.065, 0.0, 0.1, 0.05, 0.1, WHITE, ())


def pillar_detail(fr, r, h=3.6):
    for yy in (1.3, 2.3):
        lathe('fit', fr, 0, 0, [(r + 0.05, yy), (r + 0.05, yy + 0.1)], n=12, tint=A_STEEL)
    # four anchor plates round the foot
    for a in range(4):
        f = sub(fr, 0, 0, 0, a * math.pi / 2)
        pbox('fit', f, 0, 0.02, r + 0.28, 0.32, 0.04, 0.32, A_STEEL, ())
        for bx in (-0.1, 0.1):
            pbox('fit', f, bx, 0.07, r + 0.28, 0.05, 0.06, 0.05, A_GREY, ())
    # a lamp bracket on the side that looks at the middle of the pit (the quarter's -x, -z)
    f = sub(fr, 0, 0, 0, -3 * math.pi / 4)
    pbox('fit', f, 0, 3.0, r + 0.14, 0.1, 0.1, 0.3, A_STEEL, ())
    rbox('fit', f, 0, 3.0, r + 0.38, 0.4, 0.22, 0.22, 0.04, A_GREY, ())
    pbox('glow', f, 0, 2.89, r + 0.38, 0.3, 0.02, 0.16, WHITE, ())


def crate_detail(wx, wz, size, h, base, yaw, name):
    fr = Frame(wx, base, wz, yaw)
    hs = size / 2
    for q in range(4):
        f = turn(fr, q * math.pi / 2)
        for u in (-0.46 * size, 0.46 * size):                     # the two straps
            rect(f, u - 0.05, 0.0, u + 0.05, h, hs + 0.003, A_BLK)
        for yy in (h * 0.2, h * 0.8):                              # plank seams
            rect(f, -hs + 0.06, yy - 0.006, hs - 0.06, yy + 0.006, hs + 0.002, srgb(0x1c140c))
        if q >= 2:                                                 # faces 0 and 1 carry qcrate's own stencil
            label(f, 0.0, h * 0.45, hs + 0.008, name, min(0.3, size * 0.8 * 7 / (len(name) * 6 - 1)), A_YEL)
            # an arrow and a handling mark
            rect(f, -0.03, h * 0.12, 0.03, h * 0.3, hs + 0.008, A_YEL)
            poly('mark', f, [(-0.1, h * 0.3, hs + 0.008), (0.1, h * 0.3, hs + 0.008), (0.0, h * 0.4, hs + 0.008)], A_YEL)
    # corner brackets, top and bottom
    for sx in (-1, 1):
        for sz in (-1, 1):
            for yy in (0.06, h - 0.06):
                pbox('fit', fr, sx * (hs - 0.05), yy, sz * (hs - 0.05), 0.2, 0.12, 0.2, A_STEEL, ())
    # a lid band
    rect(fr, -hs, h - 0.17, hs, h - 0.14, hs + 0.002, srgb(0x1c140c))


def run_frame(k, x0, z0, x1, z1):
    """A frame at the middle of a wall run, local x along the run, and the run's length."""
    ax, az = RP(k, x0, z0)
    bx, bz = RP(k, x1, z1)
    dx, dz = bx - ax, bz - az
    L = math.hypot(dx, dz)
    return Frame((ax + bx) / 2, 0.0, (az + bz) / 2, math.atan2(-dz, dx)), L


def barrier_detail(k, x0, z0, x1, z1, name):
    fr, L = run_frame(k, x0, z0, x1, z1)
    h, t = 1.0, 0.6
    for yaw in (0.0, math.pi):
        f = turn(fr, yaw)
        zf = t / 2 + 0.004
        u_end = L / 2
        for j in range(4):                                         # hazard blocks at the ends
            for e in (-1, 1):
                xa = e * (u_end - 0.1 - j * 0.2)
                xb = xa - e * 0.2
                rect(f, min(xa, xb), 0.06, max(xa, xb), h - 0.06, zf, A_YEL if j % 2 == 0 else A_BLK)
        label(f, 0.0, 0.58, zf + 0.004, name, 0.16, A_WHT)
        n = int(L / 1.8)
        for j in range(n):
            u = -L / 2 + (j + 0.5) * L / n
            pbox('fit', f, u, 0.18, t / 2 + 0.008, 0.26, 0.26, 0.016, A_STEEL, ())
            for bx in (-0.08, 0.08):
                pbox('fit', f, u + bx, 0.18, t / 2 + 0.02, 0.04, 0.04, 0.016, A_GREY, ())
    # a dashed centre line along the top
    n = int(L / 1.0)
    for j in range(n):
        u0 = -L / 2 + 0.25 + j * L / n
        upoly(fr, [(u0, h + 0.008, 0.05), (u0 + 0.5, h + 0.008, 0.05), (u0 + 0.5, h + 0.008, -0.05), (u0, h + 0.008, -0.05)], A_YEL)


def block_detail(k):
    fb = QF(k, 24.5, 20.5, math.pi)               # +z is the face that looks at the middle (the ladder's)
    wd, dp, hh = 3.4, 1.4, 2.8
    for q in range(4):
        f = turn(fb, q * math.pi / 2)
        half = dp / 2 if q % 2 == 0 else wd / 2
        fw = wd if q % 2 == 0 else dp
        zf = half + 0.008
        if q == 0:                                              # the ladder face: a plate and a number
            rect(f, -1.55, 1.9, -0.2, 2.55, zf + 0.004, A_PLATE)
            label(f, -0.875, 2.1, zf + 0.012, 'SUB %d' % (k + 1), 0.24, A_YEL)
            continue
        for j in range(10):                                     # louvres
            rect(f, -fw / 2 + 0.2, 0.7 + j * 0.13, fw / 2 - 0.2, 0.7 + j * 0.13 + 0.05, zf, A_BLK)
        if q != 2:
            rect(f, -0.35, 2.15, 0.35, 2.6, zf + 0.004, A_YEL)
            label(f, 0.0, 2.25, zf + 0.012, '11KV', 0.17, A_BLK)
        else:
            rect(f, -0.9, 2.1, 0.9, 2.55, zf + 0.004, A_RED)
            label(f, 0.0, 2.22, zf + 0.012, 'DANGER', 0.2, A_WHT)
    # a hazard border along the two long edges of the roof
    for j in range(5):
        x = -1.5 + j * 0.6
        for zz in (-0.45, 0.45):
            upoly(fb, [(x, hh + 0.008, zz + 0.1), (x + 0.3, hh + 0.008, zz + 0.1), (x + 0.3, hh + 0.008, zz - 0.1), (x, hh + 0.008, zz - 0.1)],
                  A_YEL if j % 2 == 0 else A_BLK)
    # a conduit run up one corner and a vent on the roof
    wire(fb, [(-1.62, 0.2, 0.62), (-1.62, 2.7, 0.62), (-1.2, 2.82, 0.4)], 0.03, A_GREY, n=5)
    lathe('fit', fb, -1.0, -0.2, [(0.0, hh), (0.2, hh), (0.2, hh + 0.14), (0.1, hh + 0.2), (0.0, hh + 0.2)], n=10, tint=A_STEEL)
    pbox('fit', fb, 0.9, hh + 0.12, -0.2, 0.7, 0.24, 0.5, A_STEEL, ())


def floor_detail():
    y = 0.012
    # expansion joints across the pit
    for c in (-24.0, -16.0, -8.0, 8.0, 16.0, 24.0):
        upoly(Frame(), [(c - 0.02, y, 31.8), (c + 0.02, y, 31.8), (c + 0.02, y, -31.8), (c - 0.02, y, -31.8)], A_JOINT)
        upoly(Frame(), [(-31.8, y, c + 0.02), (31.8, y, c + 0.02), (31.8, y, c - 0.02), (-31.8, y, c - 0.02)], A_JOINT)
    # stains and scorch: ragged blobs, most of them near the gates
    for k in range(4):
        for j in range(5):
            cx = (rnd() - 0.5) * 11.0
            cz = 17.0 + rnd() * 11.0
            r = 0.3 + rnd() * 0.6
            wx, wz = RP(k, cx, cz)
            n = 16
            pts = []
            for a in range(n):
                ang = 2 * math.pi * a / n
                rr = r * (0.82 + 0.3 * rnd()) * (1.0 + 0.25 * math.cos(2 * ang + j))
                pts.append((wx + rr * math.cos(ang), 0.016 + j * 0.001, wz + rr * math.sin(ang)))
            upoly(Frame(), pts, A_STAIN)
    # drag marks out of each gate: strips of dark
    for k in range(4):
        for j in range(4):
            ox = (rnd() - 0.5) * 5.0
            a = (rnd() - 0.5) * 0.5
            p0 = RP(k, ox, 31.2)
            p1 = RP(k, ox + a * 8.0, 20.0)
            dx, dz = p1[0] - p0[0], p1[1] - p0[1]
            L = math.hypot(dx, dz)
            nx, nz = -dz / L * 0.05, dx / L * 0.05
            pts = [(p0[0] + nx, 0.02, p0[1] + nz), (p0[0] - nx, 0.02, p0[1] - nz), (p1[0] - nx, 0.02, p1[1] - nz), (p1[0] + nx, 0.02, p1[1] + nz)]
            upoly(Frame(), pts, srgb(0x2e2e30))
    # the gate numbers and the quarter letters, painted for whoever is standing in the middle
    for k in range(4):
        gx, gz = RP(k, 0.0, 13.3)         # the text climbs away from the middle: clear of the dashed ring at 15
        floor_label(Frame(gx, 0.022, gz, facing_yaw(gx, gz)), 'GATE %d' % (k + 1), 0.85, A_YEL)
        qx, qz = RP(k, 17.0, 20.0)
        floor_label(Frame(qx, 0.024, qz, facing_yaw(qx, qz)), 'ABCD'[k], 2.2, srgb(0x9a7f1c))
    # manhole covers, with a marked cross, clear of the cover
    for k in range(4):
        for (cx, cz) in ((-12.0, 27.0), (12.0, 27.0), (14.0, 9.0)):
            wx, wz = RP(k, cx, cz)
            lathe('fit', Frame(wx, 0.0, wz, 0.0), 0.0, 0.0, [(0.0, 0.0), (0.42, 0.0), (0.45, 0.012), (0.0, 0.012)], n=14, tint=A_STEEL)
            for q in range(3):
                pbox('mark', Frame(wx, 0.0, wz, q * math.pi / 3), 0, 0.016, 0, 0.8, 0.002, 0.04, A_BLK, ())


def arena_detail():
    for k in range(4):
        wall_detail(k)
        stands_detail(k)
        scoreboard(k)
    for sx in (-1, 1):
        for sz in (-1, 1):
            tower_detail(sx, sz)
    dais_detail()
    floor_detail()
    for k in range(4):
        pillar_detail(QF(k, 11.5, 11.5), 1.2)
        pillar_detail(QF(k, 22.0, 22.0), 1.4)
        crate_detail(*RP(k, 22.0, 7.5), 2.0, 1.0, 0.0, 0.0 - k * QUARTER, 'AMMO')
        crate_detail(*RP(k, 22.0, 7.5), 1.3, 1.0, 1.0, 0.3 - k * QUARTER, 'FRAGILE')
        barrier_detail(k, 16.0, 6.0, 16.0, 15.0, 'BARRIER %d' % (2 * k + 1))
        barrier_detail(k, 16.0, 15.0, 25.0, 15.0, 'BARRIER %d' % (2 * k + 2))
        block_detail(k)
