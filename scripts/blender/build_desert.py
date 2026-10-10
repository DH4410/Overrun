"""
DESERT: a walled desert town at midday, generated in Blender.

Run inside Blender 4.2+ (Scripting tab, or through the Blender MCP):

    OVERRUN_REPO = r"C:/path/to/repo"
    exec(open(OVERRUN_REPO + "/scripts/blender/build_desert.py").read())

It rebuilds the DESERT collection and writes assets/maps/desert.glb and desert.json.

The layout, south half (the north half is the same turned half a turn):

    spawn yard      |x| < 10, z 22..32, behind a wall with a gate and a gap each side
    approach        |x| < 5, z 10..21, between two house blocks
    market square   |x| < 14, |z| < 10: a domed cistern in the middle, wells, stalls, palms,
                    and a covered arcade along each long side
    souk            x < -14: narrow streets, a covered passage under slatted roofing
    caravan yard    x > 14: open ground, low stone walls, palms and a colonnade

so each flank is half souk and half yard, and a duel starts from two identical ends.

Heights, for movement: crates, low walls, wells and stall counters are 1.0 m or under (a hop);
everything a player should not climb is 2.8 m or more. Nothing between is walkable, so there is
no ledge a jump nearly reaches. Every roof you can stand under is at 4.2 m, which is CEIL_Y.

Detail pass: soft adobe (rounded edges, smooth normals and wear from roundkit_dh.py), and a layer
of detail that has no collider and is never a touchable key (so the ghost probe in
desert-map.spec.mjs never sees it): arched windows with surrounds, sills and shutters, arched doors
with voussoirs, roof parapets with spouts, stair-heads and domes, impost blocks and keystones on
the arcades, turned wells, a domed cistern with turrets, palms with ringed trunks and feathered
fronds, striped awnings with produce, round towers on the wall, and a minaret on the skyline.
Every collider is emitted exactly as before, so desert.json (and the map hash) does not change.
"""
import math
import os

MAP = 'desert'
HX, HZ = 42.0, 32.0      # playable half extents
WALL_H = 7.0             # the town wall
CEIL_Y = 4.2             # underside of the arcade roofs and souk slats

# key: (preview colour, metres per texture tile). src/mapDesert.js picks the texture per key.
MATERIALS = {
    'sand':    ((0.76, 0.62, 0.44), 4.0),
    'dune':    ((0.76, 0.62, 0.44), 9.0),     # beyond the wall, no collider
    'paving':  ((0.55, 0.45, 0.36), 3.0),     # flagstones laid on the sand: decal
    'stone':   ((0.72, 0.62, 0.48), 2.5),     # dressed sandstone: arches, wells, plinths
    'plaster': ((0.78, 0.66, 0.45), 3.0),     # ochre lime plaster
    'mud':     ((0.55, 0.40, 0.28), 3.0),     # mud render: the town wall, older houses
    'lime':    ((0.85, 0.80, 0.72), 3.0),     # whitewash
    'wood':    ((0.45, 0.33, 0.22), 1.5),
    'beam':    ((0.40, 0.30, 0.20), 1.5),     # visual timber: beam ends, lintels, shutters, logs
    'cloth':   ((1.00, 1.00, 1.00), 1.0),     # awnings and banners, tinted, no collider
    'frond':   ((1.00, 1.00, 1.00), 1.0),     # palm leaves, tinted, no collider
    'trunk':   ((0.42, 0.34, 0.25), 1.0),
    'dark':    ((0.08, 0.06, 0.05), 1.0),     # window and doorway shadow, flush
    'water':   ((0.12, 0.16, 0.14), 1.0),
    'metal':   ((0.20, 0.20, 0.20), 1.0),     # lantern frames, door bands, no collider
    'lamp':    ((1.00, 0.80, 0.50), 1.0),     # emissive
    'dome':    ((0.85, 0.80, 0.72), 3.0),     # domes and roofs, tinted, out of reach
    'far':     ((1.00, 1.00, 1.00), 8.0),     # backdrop beyond the wall, tinted
    # Detail with no collider: neither is in the ghost probe's touch list.
    'trim':    ((0.72, 0.62, 0.48), 2.5),     # copings, cornices, plinths, sills, voussoirs; tinted
    'clay':    ((1.00, 1.00, 1.00), 1.0),     # jars, baskets, produce, sacks; tinted
}
SMOOTH = {'dune'}

# Rounded edges, smooth normals and wear (roundkit_dh.py). Nothing in it emits a collider.
RK_ROUND = {'mud': 0.16, 'plaster': 0.12, 'lime': 0.10, 'stone': 0.07, 'wood': 0.05, 'beam': 0.04,
            'trim': 0.05, 'metal': 0.02, 'dome': 0.05}
RK_ROUND_DEFAULT = 0.04
RK_CELL = 6.0
RK_PLAIN = {'sand', 'dune', 'paving', 'dark', 'water', 'lamp', 'far', 'frond', 'cloth', 'clay'}
RK_WEAR = {'mud': (0.30, 0.20, True), 'plaster': (0.26, 0.18, True), 'lime': (0.22, 0.14, True),
           'stone': (0.20, 0.12, True), 'wood': (0.20, 0.10), 'beam': (0.14, 0.08), 'trim': (0.20, 0.12)}
# Every key that shares a material with a worn one carries vertex colours too (lime/dome, wood/beam).
TINTED = {'cloth', 'frond', 'far', 'trim', 'clay', 'dome', 'beam'} | set(RK_WEAR)

# Poly Haven models: (slug, max triangles, collider, approximate w/h/d for plan mode)
PROPS = {
    'barrel': ('wine_barrel_01', 1000, 'cyl', (0.76, 0.87, 0.76)),
    'chest':  ('wooden_crate_02', 800, 'box', (1.17, 0.46, 0.53)),
    'pot':    ('planter_pot_clay', 600, 'cyl', (0.27, 0.22, 0.26)),
    'car':    ('covered_car', 2500, 'box', (1.79, 1.41, 4.38)),
    'bucket': ('wooden_bucket_01', 600, None, (0.37, 0.55, 0.34)),
}

exec(open(os.path.join(globals()['OVERRUN_REPO'], 'scripts', 'blender', 'mapkit.py')).read())
exec(open(os.path.join(REPO, 'scripts', 'blender', 'roundkit_dh.py')).read())

_vbox_round = vbox


def vbox(key, frame, cx, cy, cz, w, h, d, tint=WHITE, skip=('-y',)):
    """The rounding kit's box, except where the box is too slim for a bevel to show."""
    if min(w, h, d) < 0.2:
        return _vbox0(key, frame, cx, cy, cz, w, h, d, tint, skip)
    return _vbox_round(key, frame, cx, cy, cz, w, h, d, tint, skip)


TRIM = 0.003             # decoration stands this proud of a wall, so it adds nothing to walk into
OUT_YAW = {'+z': 0.0, '-z': math.pi, '+x': math.pi / 2, '-x': -math.pi / 2}

CLOTHS = [srgb(h) for h in (0xa8322a, 0x2f5d8a, 0xc9a13a, 0x3f7a4a, 0x8b3f6e, 0xd9cdb4)]
GREENS = [srgb(h) for h in (0x4d6b2a, 0x5f7d33, 0x6b8a3a, 0x566f2c)]
# what the plaster of each house is, for the copings and sills laid on it
TINT = {'mud': srgb(0xa07650), 'plaster': srgb(0xd3ad7e), 'lime': srgb(0xe9e1d0), 'stone': srgb(0xc4a982)}
STONE = srgb(0xc4a982)
SHUTTERS = [srgb(h) for h in (0x2f5d8a, 0x3f7a4a, 0x7a3a2a, 0x4a392b, 0x1f6b6b)]
TIMBER = srgb(0x7a5a3a)
DARK_TIMBER = srgb(0x4a3624)
CLAY = [srgb(h) for h in (0xb5663a, 0xa8552c, 0xc98a52, 0x8f4b2a)]
PRODUCE = [srgb(h) for h in (0xd9822b, 0x6a8f2e, 0xb82e2a, 0xe0b53a, 0x8a3a5a)]
SPICE = [srgb(h) for h in (0xe0a030, 0xb83a1c, 0x8a5a2a, 0xc8b070, 0x6a7a3a)]
SACK = srgb(0xc8b48a)


def rnd_gen(seed):
    state = [seed * 2654435761 % 2147483647 or 1]

    def rnd():
        state[0] = (state[0] * 1103515245 + 12345) & 0x7fffffff
        return state[0] / 0x7fffffff
    return rnd


# ------------------------------------------------------------------ small pieces

def tbox(key, fr, cx, cy, cz, w, h, d, r=0.03, tint=WHITE, skip=()):
    """A small rounded detail box that the slim-box rule would leave sharp."""
    rbox(key, fr, cx, cy, cz, w, h, d, r, tint, skip)


def blob(key, fr, x, y, z, rx, ry, tint=WHITE, n=8):
    """A rounded lump (a fruit pile, a sack, a dome of grain): a lathe about the vertical axis."""
    prof = [(0.0, y - ry)]
    for k in range(1, 6):
        a = -math.pi / 2 + math.pi * k / 6
        prof.append((rx * math.cos(a), y + ry * math.sin(a)))
    prof.append((0.0, y + ry))
    lathe(key, fr, x, z, prof, n=n, tint=tint)


def face_fn(face, xa, xb, za, zb, e=TRIM):
    """For one face of an axis-aligned box: its length, and (t, y) -> world point, where t runs
    left to right as seen from outside. Quads built t0,t1 x y0,y1 in that order face outward."""
    if face == '+z':
        return xb - xa, lambda t, y: (xa + t, y, zb + e)
    if face == '-z':
        return xb - xa, lambda t, y: (xb - t, y, za - e)
    if face == '+x':
        return zb - za, lambda t, y: (xb + e, y, zb - t)
    return zb - za, lambda t, y: (xa - e, y, za + t)


def face_quad(key, P, t0, t1, y0, y1, tint=WHITE):
    poly(key, Frame(), [P(t0, y0), P(t1, y0), P(t1, y1), P(t0, y1)], tint)


def face_frame(face, xa, xb, za, zb):
    """The face's length and a frame standing on it: local x runs along it (left to right seen
    from outside), local y is up, local z points away from the wall."""
    cx, cz = (xa + xb) / 2, (za + zb) / 2
    if face == '+z':
        return xb - xa, Frame(cx, 0, zb, OUT_YAW['+z'])
    if face == '-z':
        return xb - xa, Frame(cx, 0, za, OUT_YAW['-z'])
    if face == '+x':
        return zb - za, Frame(xb, 0, cz, OUT_YAW['+x'])
    return zb - za, Frame(xa, 0, cz, OUT_YAW['-x'])


def off(face, d):
    return {'+z': (0, 0, d), '-z': (0, 0, -d), '+x': (d, 0, 0), '-x': (-d, 0, 0)}[face]


def shift(P, face, d=TRIM):
    """The same face function, d further out."""
    o = off(face, d)
    return lambda t, y: tuple(a + b for a, b in zip(P(t, y), o))


def arch_pts(u, y0, wd, ht, seg=7):
    """An opening: straight sides from y0 up to the springing, then a round head, CCW from +z."""
    r = wd / 2
    yc = y0 + ht - r
    pts = [(u - r, y0), (u + r, y0), (u + r, yc)]
    for k in range(1, seg):
        a = math.pi * k / seg
        pts.append((u + r * math.cos(a), yc + r * math.sin(a)))
    pts.append((u - r, yc))
    return pts


def arch_band(fr, u, yc, r, w, e, tint=WHITE, key='trim', seg=7):
    """A flat ring of dressed stone round a round head: quads from radius r to r + w."""
    for k in range(seg):
        a0, a1 = math.pi * k / seg, math.pi * (k + 1) / seg
        poly(key, fr, [(u + r * math.cos(a1), yc + r * math.sin(a1), e), (u + r * math.cos(a0), yc + r * math.sin(a0), e),
                       (u + (r + w) * math.cos(a0), yc + (r + w) * math.sin(a0), e),
                       (u + (r + w) * math.cos(a1), yc + (r + w) * math.sin(a1), e)], tint)


def voussoirs(fr, u, yc, r, w, depth, tint, n=9):
    """The wedge stones of an arch, each a little proud, alternating a shade."""
    for k in range(n):
        a0, a1 = math.pi * k / n, math.pi * (k + 1) / n
        pr = [(u + r * math.cos(a1), yc + r * math.sin(a1)), (u + r * math.cos(a0), yc + r * math.sin(a0)),
              (u + (r + w) * math.cos(a0), yc + (r + w) * math.sin(a0)), (u + (r + w) * math.cos(a1), yc + (r + w) * math.sin(a1))]
        k_ = 1.0 if k % 2 else 0.86
        prism('trim', fr, pr, 0.0, depth * (1.0 + 0.25 * (k % 2)), tuple(c * k_ for c in tint))


def window(fr, u, y, wd, ht, kind, tint, shutter):
    """An arched window: shadow, a stone surround and sill, and shutters (open leaves, closed
    boards, or a grille over the dark)."""
    r = wd / 2
    yc = y + ht - r
    e = 2 * TRIM
    poly('dark', fr, [(a, b, TRIM) for a, b in arch_pts(u, y, wd, ht)])
    band = 0.12
    arch_band(fr, u, yc, r, band, e, tint)
    poly('trim', fr, [(u - r - band, y, e), (u - r, y, e), (u - r, yc, e), (u - r - band, yc, e)], tint)
    poly('trim', fr, [(u + r, y, e), (u + r + band, y, e), (u + r + band, yc, e), (u + r, yc, e)], tint)
    tbox('trim', fr, u, y - 0.05, 0.1, wd + 0.34, 0.1, 0.22, 0.035, tint)
    if kind == 0:
        lw = r * 0.95
        hh = yc - y + 0.12
        for sg in (-1, 1):
            tbox('beam', fr, u + sg * (r + band + lw / 2 + 0.02), y + hh / 2, 0.04, lw, hh, 0.05, 0.02, shutter)
    elif kind == 1:
        poly('beam', fr, [(a, b, 0.012) for a, b in arch_pts(u, y, wd, ht)], shutter)
        for j in (-1, 0, 1):
            tbox('beam', fr, u + j * r * 0.5, y + (yc - y) / 2, 0.026, 0.035, yc - y, 0.03, 0.012, DARK_TIMBER)
    else:
        for j in (-1, 0, 1):
            tbox('metal', fr, u + j * r * 0.5, y + (yc - y) / 2 + 0.05, 0.03, 0.03, yc - y + 0.1, 0.03, 0.012)
        tbox('metal', fr, u, y + 0.35, 0.03, wd, 0.03, 0.03, 0.012)


def entry(fr, u, wd=1.3, ht=2.35, tint=STONE, vous=9, wv=0.2, leaf=True, ring=True):
    """A pointed-round doorway: planked leaf with bands and a ring, voussoirs, dressed jambs."""
    r = wd / 2
    yc = ht - r
    if leaf:
        poly('wood', fr, [(a, b, TRIM) for a, b in arch_pts(u, 0.0, wd, ht, 9)])
        n = max(2, int(wd / 0.45))
        for k in range(1, n):
            x = u - r + wd * k / n
            top = yc + math.sqrt(max(0.0, r * r - (x - u) ** 2))
            tbox('beam', fr, x, top / 2, 0.022, 0.035, top - 0.02, 0.03, 0.012, DARK_TIMBER)
        for yb in (0.45 * ht, 0.8 * yc):
            tbox('metal', fr, u, yb, 0.03, wd - 0.04, 0.09, 0.03, 0.012)
        if ring:
            torus('metal', fr, u + r * 0.4, 0.55 * ht, 0.05, 0.07, 0.014, ax='z', n=10, m=5)
    voussoirs(fr, u, yc, r, wv, 0.07, tint, vous)
    for sg in (-1, 1):
        tbox('trim', fr, u + sg * (r + wv / 2), yc / 2, 0.06, wv, yc, 0.12, 0.04, tint)
    tbox('trim', fr, u, 0.04, 0.16, wd + 2 * wv + 0.1, 0.08, 0.32, 0.03, tint)


def patches(fr, L, h, rnd, door_u=None, count=2):
    """Plaster that has come away, showing the stone under it: flush, irregular, touchable."""
    for _ in range(count):
        u = (rnd() - 0.5) * (L - 3.0)
        if door_u is not None and abs(u - door_u) < 1.8:
            continue
        y = 0.8 + rnd() * 0.4      # under the windows, which start at 2.2
        r = 0.28 + rnd() * 0.17
        n = 7
        pts = []
        for k in range(n):
            a = 2 * math.pi * k / n
            rr = r * (0.7 + 0.5 * rnd())
            pts.append((u + rr * math.cos(a) * 1.3, y + rr * math.sin(a) * 0.8, 0.006))
        poly('stone', fr, pts)


def rug(fr, u, y, w, h, tint, edge):
    """A woven rug hung on a wall: a border, a field and a stripe."""
    e = 0.012
    poly('cloth', fr, [(u - w / 2, y, e), (u + w / 2, y, e), (u + w / 2, y + h, e), (u - w / 2, y + h, e)], edge)
    b = 0.07
    poly('cloth', fr, [(u - w / 2 + b, y + b, e + 0.002), (u + w / 2 - b, y + b, e + 0.002),
                       (u + w / 2 - b, y + h - b, e + 0.002), (u - w / 2 + b, y + h - b, e + 0.002)], tint)
    poly('cloth', fr, [(u - w / 2 + b, y + h * 0.42, e + 0.004), (u + w / 2 - b, y + h * 0.42, e + 0.004),
                       (u + w / 2 - b, y + h * 0.58, e + 0.004), (u - w / 2 + b, y + h * 0.58, e + 0.004)], edge)


def wall(x0, z0, x1, z1, h, t, key, block=1, y=0.0, top_key=None):
    """mapkit's wall, with a cap laid on the rounded top instead of a second box over it."""
    along_x = abs(x1 - x0) > abs(z1 - z0)
    length = abs(x1 - x0) if along_x else abs(z1 - z0)
    if length < 0.05:
        return
    w, d = (length, t) if along_x else (t, length)
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    if top_key:
        vbox(key, Frame(), cx, y + h / 2, cz, w, h, d, skip=('-y', '+y'))
        inset = min(RK_ROUND.get(key, RK_ROUND_DEFAULT), min(w, h, d) * 0.3)
        poly(top_key, Frame(), [(cx - w / 2 + inset, y + h, cz + d / 2 - inset),
                                (cx + w / 2 - inset, y + h, cz + d / 2 - inset),
                                (cx + w / 2 - inset, y + h, cz - d / 2 + inset),
                                (cx - w / 2 + inset, y + h, cz - d / 2 + inset)])
    else:
        vbox(key, Frame(), cx, y + h / 2, cz, w, h, d, skip=('-y',))
    collider(Frame(), cx, y + h / 2, cz, w, h, d, block)


# ------------------------------------------------------------------ building pieces

def roof(xa, xb, za, zb, h, key, rnd):
    """A flat roof's edge: a parapet with its spouts and, on the taller houses, a stair-head, a
    dome or a water jar. All of it above the collider's top, none of it touchable."""
    cx, cz = (xa + xb) / 2, (za + zb) / 2
    W, D = xb - xa, zb - za
    tint = TINT[key]
    fr = Frame()
    for sz in (-1, 1):
        tbox('trim', fr, cx, h + 0.2, cz + sz * (D / 2 - 0.13), W, 0.44, 0.26, 0.07, tint)
    for sx in (-1, 1):
        tbox('trim', fr, cx + sx * (W / 2 - 0.13), h + 0.2, cz, 0.26, 0.44, D - 0.52, 0.07, tint)
    # spouts through the parapet, one a few metres along each long side
    for sz in (-1, 1):
        k = max(1, int(W // 5.0))
        for i in range(k):
            x = xa + (i + 0.5) * W / k
            tbox('trim', fr, x, h + 0.05, cz + sz * (D / 2 + 0.12), 0.14, 0.12, 0.4, 0.04, tint)
    if h >= 5.6 and W > 4.5 and D > 4.5 and rnd() < 0.55:
        bx = cx + (rnd() - 0.5) * (W - 3.8)
        bz = cz + (rnd() - 0.5) * (D - 3.8)
        tbox('trim', fr, bx, h + 1.0, bz, 1.7, 2.0, 1.7, 0.1, tint)
        tbox('trim', fr, bx, h + 2.05, bz, 1.95, 0.14, 1.95, 0.05, tint)
        poly('dark', fr, [(bx - 0.4, h, bz + 0.851), (bx + 0.4, h, bz + 0.851), (bx + 0.4, h + 1.5, bz + 0.851), (bx - 0.4, h + 1.5, bz + 0.851)])
        if rnd() < 0.6:
            prof = [(0.9, h + 2.12), (0.88, h + 2.3), (0.78, h + 2.55), (0.58, h + 2.78), (0.3, h + 2.93), (0.0, h + 2.98)]
            lathe('dome', fr, bx, bz, prof, n=18, tint=srgb(0xece4d2))
    elif rnd() < 0.5:
        jx = cx + (rnd() - 0.5) * (W - 2.0)
        jz = cz + (rnd() - 0.5) * (D - 2.0)
        prof = [(0.0, h), (0.22, h), (0.34, h + 0.25), (0.38, h + 0.55), (0.3, h + 0.85), (0.17, h + 1.0), (0.2, h + 1.12),
                (0.0, h + 1.12)]
        lathe('clay', fr, jx, jz, prof, n=10, tint=CLAY[int(rnd() * len(CLAY))])


def house(x0, z0, x1, z1, h, key='plaster', faces='+x-x+z-z', vigas=False, seed=1, door=None):
    """A flat-roofed house: a soft-cornered block with a stone plinth, a cornice, arched windows
    with shutters, patches of fallen plaster and, with vigas, round roof-beam ends. The collider
    is exactly the block."""
    xa, xb = sorted((x0, x1))
    za, zb = sorted((z0, z1))
    solid(key, Frame(), (xa + xb) / 2, h / 2, (za + zb) / 2, xb - xa, h, zb - za)
    rnd = rnd_gen(seed)
    tint = TINT[key]
    roof(xa, xb, za, zb, h, key, rnd)
    for face in ('+x', '-x', '+z', '-z'):
        if face not in faces:
            continue
        L, fr = face_frame(face, xa, xb, za, zb)
        door_u = None
        if door and door[0] == face:
            door_u = door[1] - L / 2
        tbox('trim', fr, 0, 0.26, 0.07, L - 0.1, 0.52, 0.14, 0.05, STONE)
        tbox('trim', fr, 0, h - 0.17, 0.06, L - 0.1, 0.26, 0.12, 0.05, tint)
        rows = [2.3] + ([5.0] if h >= 6.8 else [])
        n = int(L // 3.4)
        for i in range(n):
            u = (i + 0.5) * L / n - L / 2
            for y in rows:
                if rnd() < 0.3:
                    continue
                if door_u is not None and y < 3.0 and abs(u - door_u) < 1.6:
                    continue
                wd = 0.7 + 0.2 * (rnd() < 0.5)
                window(fr, u, y, wd, 1.25, int(rnd() * 3), tint, SHUTTERS[int(rnd() * len(SHUTTERS))])
        patches(fr, L, h, rnd, door_u, 3)
        if n > 1 and rnd() < 0.4:
            j = int(rnd() * (n - 1))
            u = (j + 1) * L / n - L / 2
            if door_u is None or abs(u - door_u) > 1.6:
                rug(fr, u, 0.75, 0.8, 1.2, CLOTHS[int(rnd() * len(CLOTHS))], CLOTHS[int(rnd() * len(CLOTHS))])
        if vigas and face in ('+z', '-z'):
            k = int(L // 1.1)
            for i in range(k):
                u = (i + 0.5) * L / k - L / 2
                lathe('beam', fr, u, h - 0.62, [(0.085, -0.05), (0.085, 0.34)], n=8, tint=TIMBER, caps=(False, True), ax='z')
    if door:
        face, t = door
        L, fr = face_frame(face, xa, xb, za, zb)
        entry(fr, t - L / 2, 1.3, 2.35, STONE)


def arcade(x0, z0, x1, z1, h, t, key, n, pier, spring, seg=12, block_lintel=0):
    """A wall pierced by n round arches, along X or Z between two points. The piers collide and
    block; the band above the arches collides from the crown up and does not block."""
    along_x = abs(x1 - x0) > abs(z1 - z0)
    L = abs(x1 - x0) if along_x else abs(z1 - z0)
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    fr = Frame(cx, 0, cz, 0.0 if along_x else math.pi / 2)
    ow = (L - (n + 1) * pier) / n
    r = ow / 2
    crown = spring + r
    assert crown < h - 0.2, 'arches taller than the wall'
    ht = t / 2
    tint = TINT[key]
    # piers (plain: the arch band above them is flat quads that meet them exactly)
    for i in range(n + 1):
        u0 = -L / 2 + i * (pier + ow)
        _vbox0(key, fr, u0 + pier / 2, h / 2, 0, pier, h, t, WHITE, ('-y', '+y'))
        collider(fr, u0 + pier / 2, h / 2, 0, pier, h, t, 1)
    # band above the arches: collider from the crown up, visual top over the whole length
    collider(fr, 0, (crown + h) / 2, 0, L, h - crown, t, block=block_lintel)
    poly(key, fr, [(-L / 2, h, ht), (L / 2, h, ht), (L / 2, h, -ht), (-L / 2, h, -ht)])
    for i in range(n):
        a = -L / 2 + pier + i * (pier + ow) + r      # arch centre
        for side in (1, -1):
            zf = side * ht
            for k in range(seg):
                th0, th1 = math.pi * k / seg, math.pi * (k + 1) / seg
                xa, ya = a - r * math.cos(th0), spring + r * math.sin(th0)
                xb, yb = a - r * math.cos(th1), spring + r * math.sin(th1)
                quad = [(xa, ya, zf), (xb, yb, zf), (xb, h, zf), (xa, h, zf)]
                poly(key, fr, quad if side > 0 else quad[::-1])
                # soffit, facing down into the opening
                if side > 0:
                    poly('stone', fr, [(xa, ya, ht), (xa, ya, -ht), (xb, yb, -ht), (xb, yb, ht)])
            # the opening's stone surround, TRIM proud, with a keystone and a drip moulding
            for k in range(seg):
                th0, th1 = math.pi * k / seg, math.pi * (k + 1) / seg
                p = []
                for th, rr in ((th0, r), (th1, r), (th1, r + 0.22), (th0, r + 0.22)):
                    p.append((a - rr * math.cos(th), spring + rr * math.sin(th), zf + side * TRIM))
                poly('stone', fr, p if side > 0 else p[::-1])
            tbox('trim', fr, a, crown + 0.16, side * (ht + 0.06), 0.36, 0.42, 0.14, 0.05, tint)
        # jambs up to the springing
        for sx in (-1, 1):
            u = a + sx * r
            quad = [(u, 0, -ht), (u, 0, ht), (u, spring, ht), (u, spring, -ht)]
            poly(key, fr, quad if sx > 0 else [quad[1], quad[0], quad[3], quad[2]])
    # plinth band, pier strips with their impost blocks, and a cornice, on both faces
    for side in (1, -1):
        for i in range(n + 1):
            u0 = -L / 2 + i * (pier + ow)
            uc = u0 + pier / 2
            q = [(u0, 0, side * (ht + TRIM)), (u0 + pier, 0, side * (ht + TRIM)),
                 (u0 + pier, 0.45, side * (ht + TRIM)), (u0, 0.45, side * (ht + TRIM))]
            poly('stone', fr, q if side > 0 else [q[1], q[0], q[3], q[2]])
            tbox('trim', fr, uc, spring / 2 + 0.22, side * (ht + 0.04), pier * 0.62, spring - 0.45, 0.09, 0.035, tint)
            tbox('trim', fr, uc, spring - 0.09, side * (ht + 0.07), pier + 0.1, 0.18, 0.15, 0.04, tint)
        tbox('trim', fr, 0, h - 0.07, side * (ht + 0.05), L + 0.1, 0.2, 0.14, 0.05, tint)


def slats(x0, z0, x1, z1, y, along_x, pitch=0.62, w=0.24, t=0.14):
    """Timber slats over a street: shade in stripes. Each slat is its own (non-blocking)
    collider, so a shot through a gap goes through. Round logs carry them."""
    xa, xb = sorted((x0, x1))
    za, zb = sorted((z0, z1))
    if along_x:        # slats run along X, spaced along Z
        n = int((zb - za) // pitch)
        for i in range(n):
            z = za + (i + 0.5) * (zb - za) / n
            solid('wood', Frame(), (xa + xb) / 2, y + t / 2, z, xb - xa, t, w, skip=(), block=0)
        k = max(2, int((xb - xa) // 2.5) + 1)
        for i in range(k):
            x = xa + 0.3 + i * (xb - xa - 0.6) / (k - 1)
            lathe('beam', Frame(), x, y - 0.08, [(0.1, za - 0.25), (0.1, zb + 0.25)], n=8, tint=TIMBER,
                  caps=(True, True), ax='z')
    else:
        n = int((xb - xa) // pitch)
        for i in range(n):
            x = xa + (i + 0.5) * (xb - xa) / n
            solid('wood', Frame(), x, y + t / 2, (za + zb) / 2, w, t, zb - za, skip=(), block=0)


def lantern(x, y, z, hang=0.6):
    """A hanging lantern: frame and glass only; the light itself is a lamp in mapDesert.js."""
    fr = Frame(x, y, z)
    vbox('metal', fr, 0, hang / 2, 0, 0.03, hang, 0.03, skip=())
    lathe('metal', fr, 0, 0, [(0.2, -0.04), (0.13, 0.04), (0.04, 0.12), (0.0, 0.16)], n=10)
    lathe('lamp', fr, 0, 0, [(0.1, -0.4), (0.15, -0.28), (0.15, -0.12), (0.1, -0.04)], n=10)
    lathe('metal', fr, 0, 0, [(0.0, -0.46), (0.12, -0.46), (0.15, -0.4), (0.0, -0.4)], n=10)
    for k in range(4):
        a = math.pi / 2 * k + math.pi / 4
        vbox('metal', fr, 0.145 * math.cos(a), -0.22, 0.145 * math.sin(a), 0.025, 0.36, 0.025, skip=())


def palm(s, x, z, h=6.4, lean=0.0, seed=3):
    """A date palm. The trunk collides as a cylinder; the crown is out of reach."""
    fr = F(s, x, z)
    wx, _, wz = fr.world((0, 0, 0))
    CYLINDERS.append([round(wx, 4), round(h / 2, 4), round(wz, 4), 0.26, round(h, 4), 1])
    rnd = rnd_gen(seed)
    # the trunk, ringed with old leaf bases: one smooth tube with a swelling at every ring
    k = int(h / 0.3)
    path, rad = [], []
    for i in range(k + 1):
        y = h * i / k
        u = y / h
        r0 = (0.3 - 0.075 * u) * (1.0 + 0.08 * (i % 2)) * (1.0 + 0.45 * max(0.0, 1.0 - y / 0.5) ** 2)
        path.append((lean * u * u, y, 0.0))
        rad.append(r0)
    tube('trunk', fr, path, rad, n=8, tint=WHITE, caps=True)
    top = (lean, h, 0.0)
    blob('trunk', fr, top[0], h + 0.05, 0.0, 0.28, 0.24, WHITE, n=8)
    for j in range(4):
        a = math.pi / 2 * j + rnd()
        blob('clay', fr, top[0] + 0.26 * math.cos(a), h - 0.2, 0.26 * math.sin(a), 0.1, 0.13, srgb(0x6b3a1c), n=6)
    nf = 16
    for i in range(nf):
        ang = 2 * math.pi * i / nf + rnd() * 0.3
        up = 0.35 - 0.9 * (i % 3) / 2 + rnd() * 0.15     # three tiers of droop
        L = 3.0 + rnd() * 0.8
        tint = GREENS[int(rnd() * len(GREENS))]
        tip = tuple(min(1.0, c * 1.25) for c in tint)
        m = 6
        pts = []
        for j in range(m + 1):
            u = j / m
            dist = L * u
            yy = h + math.sin(up) * dist - 1.6 * u * u
            wdt = 0.55 * math.sin(math.pi * min(1.0, u * 1.15 + 0.05)) * (0.72 if j % 2 else 1.0)   # feathered edge
            pts.append((dist, yy, wdt))
        ca, sa = math.cos(ang), math.sin(ang)
        for j in range(m):
            (d0, y0, w0), (d1, y1, w1) = pts[j], pts[j + 1]
            col = tint if j < m - 1 else tip
            for sgn in (1, -1):        # two leaf halves folded up along the midrib
                a0 = (d0 * ca - sgn * w0 * sa + top[0], y0 + w0 * 0.35, d0 * sa + sgn * w0 * ca)
                a1 = (d1 * ca - sgn * w1 * sa + top[0], y1 + w1 * 0.35, d1 * sa + sgn * w1 * ca)
                m0, m1 = (d0 * ca + top[0], y0, d0 * sa), (d1 * ca + top[0], y1, d1 * sa)
                q = [m0, m1, a1, a0] if sgn > 0 else [m1, m0, a0, a1]
                poly('frond', fr, q, col)


def stall(s, x, z, along_x=True, length=3.0, seed=5):
    """A market stall: a 1.0 m counter with goods, four poles and a striped cloth awning."""
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2)
    rnd = rnd_gen(seed)
    solid('wood', fr, 0, 0.5, 0, length, 1.0, 0.8)
    # poles stand on the ground just outside the counter
    for sx in (-1, 1):
        for sz, ph in ((1, 2.35), (-1, 2.7)):
            solid('wood', fr, sx * (length / 2 + 0.1), ph / 2, sz * 0.55, 0.09, ph, 0.09)
    tint = CLOTHS[int(rnd() * len(CLOTHS))]
    cream = srgb(0xe6dac0)
    hw = length / 2 + 0.35
    ns = max(4, int(length / 0.5))
    for i in range(ns):
        x0 = -hw + 2 * hw * i / ns
        x1 = -hw + 2 * hw * (i + 1) / ns
        c = tint if i % 2 == 0 else cream
        q = [(x0, 2.3, 1.0), (x1, 2.3, 1.0), (x1, 2.75, -0.8), (x0, 2.75, -0.8)]
        poly('cloth', fr, q, c)
        poly('cloth', fr, q[::-1], tuple(k * 0.7 for k in c))
        # the scalloped valance along the front edge
        tri = [(x0, 2.3, 1.0), (x1, 2.3, 1.0), ((x0 + x1) / 2, 2.05, 1.0)]
        poly('cloth', fr, tri, c)
        poly('cloth', fr, tri[::-1], tuple(k * 0.7 for k in c))
    # a cloth over the counter's front
    poly('cloth', fr, [(-length / 2, 0.25, 0.412), (length / 2, 0.25, 0.412), (length / 2, 0.98, 0.412), (-length / 2, 0.98, 0.412)],
         tuple(k * 0.85 for k in tint))
    # goods: small crates of produce on the counter, with the produce heaped on them
    for i in range(3):
        u = -length / 2 + (i + 0.5) * length / 3
        solid('wood', fr, u, 1.0 + 0.11, 0.05, 0.62, 0.22, 0.46, block=0)
        c = PRODUCE[int(rnd() * len(PRODUCE))]
        if i % 2:
            blob('clay', fr, u, 1.22 + 0.12, 0.05, 0.27, 0.16, c, n=10)
        else:
            lathe('clay', fr, u, 0.05, [(0.27, 1.22), (0.2, 1.3), (0.1, 1.46), (0.0, 1.55)], n=10, tint=SPICE[int(rnd() * len(SPICE))])


def well(s, x, z):
    """A round stone well, 0.9 m: a hop up. The water sits 0.2 m below the rim."""
    fr = F(s, x, z)
    r, h = 1.15, 0.9
    x0, y0, z0 = fr.world((0, h / 2, 0))
    CYLINDERS.append([round(x0, 4), round(y0, 4), round(z0, 4), r, h, 1])
    # stone courses: each a little proud of the groove above it, a turned and rounded rim
    prof = [(r, 0.0)]
    for c in range(3):
        y0 = c * 0.28
        prof += [(r, y0 + 0.25), (r - 0.035, y0 + 0.26), (r - 0.035, y0 + 0.28)]
    prof += [(r, 0.84), (r, h - 0.06), (r - 0.04, h), (r - 0.17, h), (r - 0.22, h - 0.05), (r - 0.22, h - 0.2)]
    lathe('stone', fr, 0, 0, prof, n=20)
    inner = ring(r - 0.22, 16)
    poly('water', fr, [(px, h - 0.2, pz) for px, pz in inner][::-1])
    # a timber frame over it, out of reach above the rim, and a rope and a pulley
    for sx in (-1, 1):
        solid('wood', fr, sx * (r - 0.11), h + 0.85, 0, 0.14, 1.7, 0.14)
    lathe('beam', fr, h + 1.75, 0, [(0.085, -r - 0.08), (0.085, r + 0.08)], n=8, tint=TIMBER, caps=(True, True), ax='x')
    torus('metal', fr, 0, h + 1.62, 0, 0.12, 0.025, ax='z', n=12, m=6)
    tube('metal', fr, [(0.0, h + 1.5, 0.0), (0.0, h + 0.95, 0.0), (0.0, h + 0.45, 0.0)], 0.018, n=5, caps=True)
    for sx in (-1, 1):
        lathe('trim', fr, sx * (r - 0.11), 0, [(0.2, h), (0.18, h + 0.12), (0.0, h + 0.14)], n=8, tint=STONE)


def cistern():
    """The domed cistern in the middle of the square: breaks the sight line between the gates."""
    fr = Frame()
    S, H = 4.6, 3.4
    tint = TINT['stone']
    solid('stone', fr, 0, H / 2, 0, S, H, S)
    for sx in (-1, 1):
        for sz in (-1, 1):
            vbox('stone', fr, sx * (S / 2 - 0.25), H / 2, sz * (S / 2 - 0.25), 0.5 + 2 * TRIM, H, 0.5 + 2 * TRIM, skip=('-y', '+y'))
            # a small domed turret over each corner pillar
            px, pz = sx * (S / 2 - 0.25), sz * (S / 2 - 0.25)
            lathe('dome', fr, px, pz, [(0.34, H), (0.34, H + 0.2), (0.3, H + 0.45), (0.2, H + 0.65), (0.0, H + 0.76)], n=12,
                  tint=srgb(0xece4d2))
            lathe('metal', fr, px, pz, [(0.03, H + 0.74), (0.02, H + 1.0)], n=5)
    for face in ('+x', '-x', '+z', '-z'):
        L, f = face_frame(face, -S / 2, S / 2, -S / 2, S / 2)
        poly('dark', f, [(a, b, TRIM) for a, b in arch_pts(0.0, 0.5, 1.4, 1.8)])
        arch_band(f, 0.0, 0.5 + 1.8 - 0.7, 0.7, 0.2, 2 * TRIM, tint)
        for sg in (-1, 1):
            poly('trim', f, [(sg * 0.7 + (-0.2 if sg < 0 else 0.0), 0.5, 2 * TRIM), (sg * 0.7 + (0.0 if sg < 0 else 0.2), 0.5, 2 * TRIM),
                             (sg * 0.7 + (0.0 if sg < 0 else 0.2), 1.6, 2 * TRIM), (sg * 0.7 + (-0.2 if sg < 0 else 0.0), 1.6, 2 * TRIM)],
                 tint)
        tbox('trim', f, 0, H - 0.17, 0.07, L - 0.1, 0.34, 0.14, 0.05, tint)
        tbox('trim', f, 0, 0.2, 0.07, L - 0.1, 0.4, 0.14, 0.05, STONE)
    # dome on a drum, out of reach: one turned profile, smooth
    prof = [(2.0, H), (2.0, H + 0.12), (1.9, H + 0.2), (1.9, H + 0.6)]
    steps = 10
    for k in range(1, steps + 1):
        a = math.pi / 2 * k / steps
        prof.append((1.9 * math.cos(a), H + 0.6 + 1.9 * math.sin(a)))
    lathe('dome', fr, 0, 0, prof, n=28, tint=srgb(0xf0e8d6))
    # a stone ring at the drum's foot and a finial
    lathe('trim', fr, 0, 0, [(2.1, H), (2.1, H + 0.1), (1.95, H + 0.16)], n=28, tint=tint)
    lathe('metal', fr, 0, 0, [(0.12, H + 2.4), (0.08, H + 2.5), (0.14, H + 2.62), (0.06, H + 2.8), (0.04, H + 3.3), (0.0, H + 3.4)], n=8)


def low_wall(s, x, z, along_x, length, h=1.0, t=0.6, key='stone'):
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2)
    solid(key, fr, 0, h / 2, 0, length, h, t)
    tbox('trim', fr, 0, h + 0.03, 0, length + 0.12, 0.1, t + 0.14, 0.04, STONE)


def trough(s, x, z, along_x=True):
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2)
    solid('stone', fr, 0, 0.35, 0, 2.4, 0.7, 0.8)
    # a hair above the stone, so the trough reads as brim-full
    poly('water', fr, [(-1.05, 0.704, 0.25), (1.05, 0.704, 0.25), (1.05, 0.704, -0.25), (-1.05, 0.704, -0.25)])
    tbox('trim', fr, 0, 0.73, 0.33, 2.5, 0.08, 0.14, 0.03, STONE)
    tbox('trim', fr, 0, 0.73, -0.33, 2.5, 0.08, 0.14, 0.03, STONE)
    for sx in (-1, 1):
        tbox('trim', fr, sx * 1.17, 0.73, 0, 0.14, 0.08, 0.5, 0.03, STONE)


def kerb(x0, z0, x1, z1):
    """A low stone kerb along a paved edge: under 0.1 m, and nothing to walk into."""
    xa, xb = sorted((x0, x1))
    za, zb = sorted((z0, z1))
    tbox('trim', Frame(), (xa + xb) / 2, 0.045, (za + zb) / 2, max(xb - xa, 0.22), 0.09, max(zb - za, 0.22), 0.035, STONE)


# ------------------------------------------------------------------ layout

def ground():
    GX, GZ = HX + 1.5, HZ + 1.5
    poly('sand', Frame(), [(-GX, 0, GZ), (GX, 0, GZ), (GX, 0, -GZ), (-GX, 0, -GZ)])
    collider(Frame(), 0, -0.5, 0, 2 * HX + 3, 1.0, 2 * HZ + 3, block=0)
    # flagstones: the square, the approaches and the spawn yards
    flat('paving', -14, -10, 14, 10, 0.006)
    for s in (1, -1):
        flat('paving', -5, s * 10, 5, s * 21, 0.006)
        flat('paving', -10, s * 22, 10, s * HZ, 0.006)
    # kerbs along the paved edges, the gaps being the ways in
    for s in (1, -1):
        kerb(-14, s * 10, -5, s * 10)
        kerb(5, s * 10, 14, s * 10)
        kerb(s * 14, -10, s * 14, 10)
        kerb(-5, s * 10, -5, s * 21)
        kerb(5, s * 10, 5, s * 21)
        kerb(-10, s * 22, -10, s * HZ)
        kerb(10, s * 22, 10, s * HZ)
    # sand drifted along the foot of the town wall, a hand's breadth high
    for sx in (-1, 1):
        tube('sand', Frame(), [(sx * (HX - 0.4), -0.33, z) for z in (-HZ, -HZ / 2, 0.0, HZ / 2, HZ)], 0.55, n=8, caps=True)
    for sz in (-1, 1):
        tube('sand', Frame(), [(x, -0.33, sz * (HZ - 0.4)) for x in (-HX, -HX / 2, 0.0, HX / 2, HX)], 0.55, n=8, caps=True)


def tower(cx, cz, r=2.9, hgt=9.0, roof_tint=None):
    """A round tower: a battered shaft, a corbelled head with merlons, a cap. Out of reach."""
    fr = Frame(cx, 0, cz)
    prof = [(r + 0.15, 0.0), (r + 0.05, 1.2), (r - 0.2, hgt - 1.0), (r - 0.2, hgt - 0.7), (r + 0.25, hgt - 0.45),
            (r + 0.25, hgt), (r, hgt), (r, hgt + 0.2)]
    lathe('mud', fr, 0, 0, prof, n=20, caps=(False, True))
    k = 10
    for i in range(k):
        a = 2 * math.pi * i / k
        mf = Frame(cx, 0, cz, a)
        tbox('mud', mf, 0, hgt + 0.55, r - 0.2, 1.25, 0.8, 0.5, 0.1)
    for j in range(3):
        a = 2 * math.pi * j / 3 + 0.5
        mf = Frame(cx, 0, cz, a)
        poly('dark', mf, [(-0.18, hgt * 0.6, r - 0.2 + 0.04), (0.18, hgt * 0.6, r - 0.2 + 0.04),
                          (0.18, hgt * 0.6 + 1.0, r - 0.2 + 0.04), (-0.18, hgt * 0.6 + 1.0, r - 0.2 + 0.04)])
    if roof_tint:
        lathe('dome', fr, 0, 0, [(r - 0.4, hgt + 0.1), (r - 0.55, hgt + 0.5), (r - 1.1, hgt + 1.3), (0.0, hgt + 2.6)], n=20,
              tint=roof_tint)


def perimeter():
    t = 1.5
    for sx in (-1, 1):
        wall(sx * (HX + t / 2), -HZ - t, sx * (HX + t / 2), HZ + t, WALL_H, t, 'mud', block=0)
    for sz in (-1, 1):
        wall(-HX - t, sz * (HZ + t / 2), HX + t, sz * (HZ + t / 2), WALL_H, t, 'mud', block=0)
    # merlons along the top, soft, and a stone plinth band on the inner face
    for sx in (-1, 1):
        n = int(2 * (HZ + t) / 1.6)
        for i in range(n):
            z = -HZ - t + (i + 0.5) * 2 * (HZ + t) / n
            vbox('mud', Frame(), sx * (HX + t / 2), WALL_H + 0.35, z, t, 0.7, 0.8)
    for sz in (-1, 1):
        n = int(2 * (HX + t) / 1.6)
        for i in range(n):
            x = -HX - t + (i + 0.5) * 2 * (HX + t) / n
            vbox('mud', Frame(), x, WALL_H + 0.35, sz * (HZ + t / 2), 0.8, 0.7, t)
    for face, (xa, xb, za, zb) in (('+x', (-HX - 1, -HX, -HZ, HZ)), ('-x', (HX, HX + 1, -HZ, HZ)),
                                   ('+z', (-HX, HX, -HZ - 1, -HZ)), ('-z', (-HX, HX, HZ, HZ + 1))):
        L, P = face_fn(face, xa, xb, za, zb)
        face_quad('stone', P, 0, L, 0, 0.6)
        # buttresses along the inner face, a corbelled head on each, and a slit between them
        Lf, fr = face_frame(face, xa, xb, za, zb)
        n = int(Lf // 8.0)
        for i in range(n):
            u = (i + 0.5) * Lf / n - Lf / 2
            wx, _, wz = fr.world((u, 0, 0))
            if face in ('+z', '-z') and abs(wx) < 6.0:
                continue
            tbox('trim', fr, u, 3.2, 0.11, 0.7, 6.0, 0.22, 0.07, TINT['mud'])
            tbox('trim', fr, u, 6.25, 0.16, 0.95, 0.3, 0.32, 0.06, TINT['mud'])
            poly('dark', fr, [(u + 3.9 - 0.1, 4.2, TRIM), (u + 3.9 + 0.1, 4.2, TRIM), (u + 3.9 + 0.1, 5.4, TRIM), (u + 3.9 - 0.1, 5.4, TRIM)])
    # corner towers, outside the playable area
    for sx in (-1, 1):
        for sz in (-1, 1):
            tower(sx * (HX + 3.45), sz * (HZ + 3.45), 2.9, 9.0, srgb(0xb4572f))
    # the town gate behind each spawn, shut: a stone arch and timber doors on the wall's face
    for s in (1, -1):
        face = '-z' if s > 0 else '+z'
        za, zb = (HZ, HZ + 1) if s > 0 else (-HZ - 1, -HZ)
        L, fr = face_frame(face, -HX, HX, za, zb)
        # stone and timber on the wall's face: the leaf, the arch of dressed stone, bars across
        r = 2.6
        yc = 4.0 - r
        poly('wood', fr, [(a, b, TRIM) for a, b in arch_pts(0.0, 0.0, 2 * r, 4.0, 14)])
        for k in range(1, 10):
            x = -r + 2 * r * k / 10
            top = yc + math.sqrt(max(0.0, r * r - x * x))
            tbox('beam', fr, x, top / 2, 0.025, 0.05, top - 0.02, 0.04, 0.015, DARK_TIMBER)
        for yb in (0.7, 1.5, 2.3):
            tbox('metal', fr, 0.0, yb, 0.04, 2 * r - 0.05, 0.12, 0.04, 0.015)
        tbox('beam', fr, 0.0, 2.0, 0.045, 0.12, 4.0, 0.05, 0.02, DARK_TIMBER)
        for sg in (-1, 1):
            torus('metal', fr, sg * 0.45, 1.2, 0.07, 0.14, 0.025, ax='z', n=12, m=6)
        voussoirs(fr, 0.0, yc, r, 0.6, 0.12, STONE, 13)
        for sg in (-1, 1):
            for j in range(4):
                tbox('trim', fr, sg * (r + 0.3), 0.2 + j * (yc / 4) + yc / 8, 0.08, 0.6, yc / 4 - 0.02, 0.16, 0.04,
                     tuple(c * (1.0 if j % 2 else 0.88) for c in STONE))
        # gatehouse above the gate, rising over the wall: soft block, merlons, two turrets
        vbox('mud', Frame(), 0, 4.5, s * (HZ + 3.0), 9.0, 9.0, 4.5)
        vbox('stone', Frame(), 0, 9.15, s * (HZ + 3.0), 9.4, 0.3, 4.9)
        for i in range(8):
            x = -4.0 + i * 8.0 / 7
            vbox('mud', Frame(), x, 9.6, s * (HZ + 3.0 + 2.2), 0.8, 0.9, 0.5)
            vbox('mud', Frame(), x, 9.6, s * (HZ + 3.0 - 2.2), 0.8, 0.9, 0.5)
        for sx in (-1, 1):
            tower(sx * 4.3, s * (HZ + 3.0), 1.1, 9.1, srgb(0xb4572f))


def spawn_yard():
    def per_side(s):
        # the houses either side of the yard
        house(s * -21, s * 21, s * -10, s * HZ, 7.2, 'mud', vigas=True, seed=11 + s, door=('+x' if s > 0 else '-x', 4.0))
        house(s * 10, s * 23, s * 20, s * HZ, 6.0, 'lime', seed=13 + s)
        # front wall: a gate in the middle, a gap at each end
        def fw(xa, xb):
            wall(s * xa, s * 21.5, s * xb, s * 21.5, 3.0, 0.9, 'plaster', top_key='stone')
        fw(-6.5, -3.3)
        fw(3.3, 6.5)
        arcade(s * -3.3, s * 21.5, s * 3.3, s * 21.5, 5.8, 0.9, 'plaster', 1, 1.1, 2.8)
        palm(s, -7.5, 30.0, 6.6, seed=21 + s)
        palm(s, 7.0, 30.3, 5.9, seed=23 + s)
        prop('pot', s, -8.6, 23.2, 0.3, scale=2.8)
        prop('pot', s, 8.6, 23.4, 1.1, scale=2.5)
        prop('barrel', s, 2.9, 30.8, 0.4)
        prop('barrel', s, 3.9, 31.1, 1.9)
    both(per_side)


def approach():
    def per_side(s):
        # house blocks either side of the approach street, with a step in height for the skyline
        house(s * -21, s * 13, s * -13, s * 18.5, 5.2, 'plaster', seed=31 + s)
        house(s * -13, s * 13, s * -5, s * 18.5, 6.6, 'lime', vigas=True, seed=33 + s, door=('-z' if s < 0 else '+z', 4.0))
        house(s * 5, s * 13, s * 13, s * 18.5, 7.0, 'plaster', vigas=True, seed=35 + s)
        house(s * 13, s * 13, s * 21, s * 18.5, 5.4, 'mud', seed=37 + s)
        # arcades along the square, roofed at CEIL_Y
        for xa, xb in ((-14, -5), (5, 14)):
            arcade(s * xa, s * 10.3, s * xb, s * 10.3, 5.0, 0.6, 'plaster', 3, 0.7, 2.75)
            za, zb = sorted((s * 10.6, s * 13))
            xa2, xb2 = sorted((s * xa, s * xb))
            slab('wood', xa2, za, xb2, zb, CEIL_Y, 0.3)
        # the outer ends are shut, or the two arcades line up into one sight line across the map
        for xe in (-13.75, 13.75):
            wall(s * xe, s * 10.6, s * xe, s * 13, 5.0, 0.5, 'plaster')
            # the end butts the mud house; a plain stub closes the seam a vertical ray could slip down
            _vbox0('plaster', Frame(), s * xe, 2.4, s * 13, 0.5, 4.8, 0.2, WHITE, ())
        # the arcade's open ends
        stall(s, -2.6, 16.2, False, 2.6, seed=41 + s)
        crate(s, 3.6, 17.2)
        crate(s, 3.9, 15.8, 1.0, 1.0)
        prop('barrel', s, 4.3, 14.4, 0.2)
        for lx in (-11.0, -7.5, 7.5, 11.0):
            lantern(s * lx, CEIL_Y - 0.02, s * 11.8)
    both(per_side)


def square():
    cistern()

    def per_side(s):
        well(s, -8.5, 5.0)
        prop('bucket', s, -7.9, 6.25, 0.8)
        stall(s, 6.5, 6.5, True, 3.2, seed=51 + s)
        stall(s, -11.3, 0.5, False, 3.0, seed=53 + s)
        palm(s, 10.8, 1.2, 6.8, seed=55 + s)
        palm(s, -3.8, 7.6, 6.2, seed=57 + s)
        crate(s, 3.2, 3.6)
        crate(s, 11.8, 7.8, 1.2, 1.0)
        prop('barrel', s, 12.6, 6.4, 0.7)
        prop('barrel', s, 13.2, 5.5, 2.2)
        prop('chest', s, 5.1, 8.3, 0.05)
        prop('pot', s, -12.9, 3.0, 0.0, scale=2.6)
        prop('pot', s, -12.6, 2.2, 0.9, scale=2.2)
        low_wall(s, 0.0, 6.4, True, 3.0)
    both(per_side)


def souk():
    def per_side(s):
        house(s * -42, s * 26, s * -21, s * HZ, 6.4, 'plaster', seed=61 + s)
        house(s * -36, s * 14, s * -26, s * 21.5, 6.0, 'mud', vigas=True, seed=63 + s, door=('+z' if s > 0 else '-z', 5.0))
        house(s * -42, s * 8, s * -39, s * 18, 5.4, 'lime', seed=65 + s)
        house(s * -36, s * 2, s * -27, s * 10, 5.0, 'plaster', vigas=True, seed=67 + s)
        house(s * -24, s * 2, s * -17, s * 8, 5.6, 'mud', seed=69 + s, door=('+x' if s > 0 else '-x', 3.0))
        # covered passage between the central block and the approach houses: slats at CEIL_Y
        # on beams, an arch at each end
        za, zb = sorted((s * 10.4, s * 21.1))
        xa, xb = sorted((s * -26, s * -21))
        slats(xa, za, xb, zb, CEIL_Y, along_x=True)
        for zz in (10.1, 21.4):
            arcade(s * -26, s * zz, s * -21, s * zz, 5.2, 0.6, 'plaster', 1, 0.9, 2.6)
        for lz in (13.0, 16.0, 19.0):
            lantern(s * -23.5, CEIL_Y - 0.02, s * lz)
        stall(s, -25.0, 15.5, False, 2.6, seed=71 + s)
        # banners across the souk streets, high over the heads
        for (x0, z0, x1, z1, yb, c) in ((-36, 23.5, -21, 23.5, 5.0, 0), (-39, 12, -36, 12, 4.8, 2),
                                        (-27, 5, -24, 5, 4.6, 4)):
            tint = CLOTHS[c]
            p = [(s * x0, yb, s * z0), (s * x1, yb, s * z1), (s * x1, yb - 0.9, s * z1), (s * x0, yb - 0.9, s * z0)]
            poly('cloth', Frame(), p, tint)
            poly('cloth', Frame(), p[::-1], tuple(k * 0.7 for k in tint))
            # pennants on the lower edge, so the banner is not a straight cut
            nn = max(2, int(math.hypot(x1 - x0, z1 - z0) / 0.9))
            for i in range(nn):
                ax_, az_ = s * (x0 + (x1 - x0) * i / nn), s * (z0 + (z1 - z0) * i / nn)
                bx_, bz_ = s * (x0 + (x1 - x0) * (i + 1) / nn), s * (z0 + (z1 - z0) * (i + 1) / nn)
                tri = [(ax_, yb - 0.9, az_), (bx_, yb - 0.9, bz_), ((ax_ + bx_) / 2, yb - 1.25, (az_ + bz_) / 2)]
                poly('cloth', Frame(), tri, tint)
                poly('cloth', Frame(), tri[::-1], tuple(k * 0.7 for k in tint))
        crate(s, -37.3, 23.8)
        crate(s, -37.1, 24.9, 1.0, 1.0, 1.0)
        crate(s, -31.5, 11.9, 1.2, 1.0)
        prop('barrel', s, -40.5, 20.0, 0.3)
        prop('barrel', s, -40.3, 21.0, 1.4)
        prop('pot', s, -28.8, 11.0, 0.5, scale=2.6)
        prop('chest', s, -22.2, 22.8, 1.57)
        low_wall(s, -30.5, 0.9, True, 3.5)
    both(per_side)


def yard():
    def per_side(s):
        # caravanserai: back rooms with a colonnade in front, roofed at CEIL_Y
        house(s * 28, s * 27, s * 42, s * HZ, 5.2, 'lime', seed=81 + s)
        arcade(s * 28, s * 24, s * 42, s * 24, 5.0, 0.6, 'plaster', 4, 0.9, 2.8)
        za, zb = sorted((s * 24.3, s * 27))
        xa, xb = sorted((s * 28, s * 42))
        slab('wood', xa, za, xb, zb, CEIL_Y, 0.3)
        for lx in (31.0, 35.0, 39.0):
            lantern(s * lx, CEIL_Y - 0.02, s * 25.6)
        house(s * 25, s * 11, s * 32, s * 18, 5.8, 'mud', vigas=True, seed=83 + s, door=('-x' if s > 0 else '+x', 3.5))
        house(s * 16, s * 3, s * 21, s * 9, 4.8, 'plaster', seed=85 + s)
        low_wall(s, 36.5, 15.0, False, 4.0)
        low_wall(s, 27.0, 5.5, True, 3.5)
        low_wall(s, 38.5, 8.0, True, 3.0)
        trough(s, 23.5, 21.3)
        palm(s, 38.0, 4.5, 7.0, seed=87 + s)
        palm(s, 34.2, 20.4, 6.3, seed=89 + s)
        palm(s, 23.2, 27.5, 6.8, seed=91 + s)
        palm(s, 26.4, 30.3, 6.0, seed=93 + s)
        crate(s, 33.8, 8.9)
        crate(s, 22.5, 12.6, 1.2, 1.0)
        prop('car', s, 37.3, 12.6, 0.12)
        prop('barrel', s, 30.3, 22.6, 0.1)
        prop('barrel', s, 31.2, 22.9, 1.2)
        prop('barrel', s, 30.7, 21.8, 2.6)
        prop('chest', s, 40.8, 22.5, 1.57)
    both(per_side)


def backdrop():
    """Beyond the wall: dunes rising away on every side, far mesas, and the tops of palms and a
    minaret from the rest of the town. No colliders; the haze softens it."""
    M = 6.0              # flat margin outside the wall before the dunes start

    def height(x, z):
        dx = max(0.0, abs(x) - (HX + M))
        dz = max(0.0, abs(z) - (HZ + M))
        d = math.hypot(dx, dz)
        if d <= 0:
            return 0.0
        k = min(1.0, d / 70.0)
        k = k * k * (3 - 2 * k)
        n = (math.sin(x * 0.045 + 1.3) * math.cos(z * 0.038) + 0.6 * math.sin(x * 0.021 - z * 0.033 + 0.7)
             + 0.35 * math.sin(x * 0.09 + z * 0.07))
        return k * (9.0 + 6.0 * n)
    # a 10 m grid out to 260 m, with lines exactly on the ground's edge under the wall
    def lines(edge):
        vs = list(range(-260, -100, 20)) + list(range(-100, 101, 10)) + list(range(120, 261, 20))
        return sorted([v for v in vs if abs(v) > edge + 3] + [-edge, edge])
    xs, zs = lines(HX + 1.5), lines(HZ + 1.5)
    for i in range(len(xs) - 1):
        for j in range(len(zs) - 1):
            x0, x1, z0, z1 = xs[i], xs[i + 1], zs[j], zs[j + 1]
            if max(abs(x0), abs(x1)) <= HX + 1.5 and max(abs(z0), abs(z1)) <= HZ + 1.5:
                continue
            a, b, c, d = height(x0, z1), height(x1, z1), height(x1, z0), height(x0, z0)
            poly('dune', Frame(), [(x0, a, z1), (x1, b, z1), (x1, c, z0)])
            poly('dune', Frame(), [(x0, a, z1), (x1, c, z0), (x0, d, z0)])
    fr = Frame()
    rnd = rnd_gen(99)
    # mesas on the horizon
    for ang, dist, w, hgt in ((0.3, 230, 90, 38), (1.4, 250, 120, 30), (2.6, 220, 70, 44), (3.7, 240, 110, 34),
                              (4.6, 235, 80, 40), (5.5, 245, 100, 28)):
        cx, cz = math.cos(ang) * dist, math.sin(ang) * dist
        yaw = ang + math.pi / 2
        mf = Frame(cx, 0, cz, yaw)
        prism('far', mf, [(-w / 2, 0), (w / 2, 0), (w / 2 - 12, hgt), (-w / 2 + 14, hgt)], -18, 18, srgb(0xb07a52))
    # a minaret and rooftops of the rest of the town, north-west and south-east
    for s in (1, -1):
        mx, mz = s * -18, s * (HZ + 26)
        sand = srgb(0xd8c3a0)
        stone = srgb(0xc9b38e)
        # one turned profile: a tapering shaft, a gallery, a second shaft, a cupola and a spire
        lathe('far', fr, mx, mz, [(1.9, 0.0), (1.7, 3.0), (1.55, 22.0), (1.6, 23.2), (2.5, 23.6), (2.7, 24.0), (2.6, 25.0),
                                  (2.2, 25.2), (1.35, 25.4), (1.3, 29.0), (1.6, 29.3), (1.7, 30.0)], n=20, tint=sand)
        lathe('far', fr, mx, mz, [(1.7, 30.0), (1.5, 31.2), (1.0, 32.4), (0.4, 33.2), (0.0, 33.5)], n=20, tint=srgb(0x8f7a5a))
        lathe('far', fr, mx, mz, [(0.06, 33.4), (0.05, 35.0)], n=5, tint=stone)
        for k in range(9):
            bx = s * (-40 + k * 11 + rnd() * 4)
            bz = s * (HZ + 12 + rnd() * 10)
            h = 8 + rnd() * 5
            bw, bd = 8 + rnd() * 4, 7 + rnd() * 4
            vbox('far', fr, bx, h / 2, bz, bw, h, bd, tint=srgb(0xc7a57c if k % 2 else 0xb8946a))
            if k % 3 == 0:
                lathe('far', fr, bx, bz, [(min(bw, bd) * 0.4, h), (min(bw, bd) * 0.38, h + 0.8), (min(bw, bd) * 0.3, h + 1.8),
                                          (min(bw, bd) * 0.15, h + 2.5), (0.0, h + 2.7)], n=14, tint=srgb(0xe6dac0))
        for k in range(4):
            px, pz = s * (-30 + k * 17), s * (HZ + 9 + (k % 2) * 6)
            fr2 = Frame(px, 0, pz)
            vcyl('trunk', fr2, 0, 0, 0.3, 0, 8.5, n=6, r1=0.22)
            for i in range(8):
                ang = 2 * math.pi * i / 8
                ca, sa = math.cos(ang), math.sin(ang)
                p = [(0, 8.5, 0), (3.0 * ca - 0.5 * sa, 7.6, 3.0 * sa + 0.5 * ca), (3.4 * ca, 6.8, 3.4 * sa),
                     (3.0 * ca + 0.5 * sa, 7.6, 3.0 * sa - 0.5 * ca)]
                poly('frond', fr2, p, GREENS[i % 4])
                poly('frond', fr2, p[::-1], GREENS[i % 4])


def build_layout():
    ground()
    perimeter()
    spawn_yard()
    approach()
    square()
    souk()
    yard()
    backdrop()
    rk_finalize()


def run_round(layout):
    _coll, objs, tris = build(layout)
    rounded = 0
    if IN_BLENDER:
        rounded = rk_apply(objs)
        if globals().get('OVERRUN_EXPORT', True):
            export(objs)
            rk_quantize(OUT_GLB)
    return {
        'objects': len(objs), 'tris': tris, 'faces': STATS['faces'], 'rounded': rounded, 'rboxes': RK_COUNT['rbox'],
        'boxes': len(BOXES), 'ramps': len(RAMPS), 'cylinders': len(CYLINDERS), 'props': len(PLACED),
        'glb_kb': round(os.path.getsize(OUT_GLB) / 1024) if IN_BLENDER and os.path.exists(OUT_GLB) else None,
    }


result = run_round(build_layout)
