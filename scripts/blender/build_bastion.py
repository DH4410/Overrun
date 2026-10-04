"""
BASTION: two stone keeps and the grass between them, a capture-the-flag map generated in Blender.
64 by 110 m. Each keep is a walled bailey with a flag hall; between them runs open grass with a
raised stone causeway down the middle, ruined walls, standing stones, and a pine grove and a trail
on each flank.

Run inside Blender 4.2+ (Scripting tab, or through the Blender MCP):

    OVERRUN_REPO = r"C:/path/to/repo"
    exec(open(OVERRUN_REPO + "/scripts/blender/build_bastion.py").read())

It rebuilds the BASTION collection and writes assets/maps/bastion.glb and bastion.json. Run with
plain Python instead and it only works out the collider tables (see mapkit.py, plan mode).

The layout, south half (the north half is the same turned half a turn):

    keep         z 40..55: a curtain wall across the width with a gate in the middle (a tower each
                 side) and a postern each flank, the flag hall (open to the front, roofed, with a
                 side door each way) and a barracks block against each flank
    field        |z| < 40: open grass. A ruined wall, a low wall and a boulder each flank, standing
                 stones near the middle, and the causeway: a 1.4 m deck, |z| < 12, with a ramp
                 at each end
    flank        x +-18..22: a dirt trail from each postern the whole length of the map, and a pine
                 grove to its outside

Heights, for movement: low walls, crates and stone blocks are 1.0 m (a hop); the causeway is 1.4 m
(the ramps, or a hop off a block); everything else a player cannot climb is 2.8 m or more. The hall
roof is the lowest thing overhead, 4.6 m, which is CEIL_Y.
"""
import math
import os

MAP = 'bastion'
HX, HZ = 32.0, 55.0      # playable half extents
CURTAIN = 5.2            # the keeps' front wall
CEIL_Y = 4.6             # underside of the hall roof

MATERIALS = {
    'grass':   ((0.30, 0.42, 0.20), 4.0),
    'hill':    ((0.30, 0.42, 0.20), 9.0),     # beyond the walls, no collider
    'dirt':    ((0.42, 0.33, 0.22), 3.0),     # trails: a decal
    'paving':  ((0.50, 0.48, 0.44), 2.5),     # courtyard flags and the causeway deck: a decal on the ground
    'castle':  ((0.58, 0.55, 0.50), 2.5),     # cut stone: keeps, towers, causeway
    'rock':    ((0.50, 0.50, 0.47), 2.5),     # dry stone: field walls, boulders, the flank walls
    'wood':  ((0.45, 0.33, 0.22), 1.5),     # crates, doors, barricades
    'slates':  ((0.30, 0.32, 0.36), 2.5),     # roofs
    'trunk':   ((0.35, 0.27, 0.20), 1.0),
    'pine':    ((1.00, 1.00, 1.00), 1.0),     # needles, tinted, no collider
    'banner':  ((1.00, 1.00, 1.00), 1.0),     # cloth, tinted, no collider
    'dark':    ((0.06, 0.06, 0.07), 1.0),     # arrow slits and doorways, flush
    'metal':   ((0.20, 0.20, 0.22), 1.0),
    'far':     ((1.00, 1.00, 1.00), 8.0),     # backdrop, tinted
}
TINTED = {'pine', 'banner', 'far'}
SMOOTH = {'hill'}

PROPS = {
    'barrel': ('wine_barrel_01', 1000, 'cyl', (0.76, 0.87, 0.76)),
}

exec(open(os.path.join(globals()['OVERRUN_REPO'], 'scripts', 'blender', 'mapkit.py')).read())

TRIM = 0.003
GREENS = [srgb(h) for h in (0x2f4a28, 0x365a2c, 0x2a4524, 0x3d5f30)]
TEAM_CLOTH = {1: srgb(0x2f5d8a), -1: srgb(0xa8322a)}     # the south keep is blue's, the north red's


def rnd_gen(seed):
    state = [seed * 2654435761 % 2147483647 or 1]

    def rnd():
        state[0] = (state[0] * 1103515245 + 12345) & 0x7fffffff
        return state[0] / 0x7fffffff
    return rnd


def face_fn(face, xa, xb, za, zb, e=TRIM):
    """For one face of an axis-aligned box: its length, and (t, y) -> world point, t running left
    to right as seen from outside."""
    if face == '+z':
        return xb - xa, lambda t, y: (xa + t, y, zb + e)
    if face == '-z':
        return xb - xa, lambda t, y: (xb - t, y, za - e)
    if face == '+x':
        return zb - za, lambda t, y: (xb + e, y, zb - t)
    return zb - za, lambda t, y: (xa - e, y, za + t)


def face_quad(key, P, t0, t1, y0, y1, tint=WHITE):
    poly(key, Frame(), [P(t0, y0), P(t1, y0), P(t1, y1), P(t0, y1)], tint)


def W(s, x0, z0, x1, z1, h, t, key, top_key=None, block=1):
    """A wall run in the south half's coordinates, turned with the half."""
    wall(s * x0, s * z0, s * x1, s * z1, h, t, key, block=block, top_key=top_key)


def block(s, key, cx, cz, w, d, h, yaw=0.0, base=0.0):
    solid(key, F(s, cx, cz, yaw), 0, base + h / 2, 0, w, h, d)


def stone(s, x, z, r=1.4, h=2.8):
    """A boulder or standing stone: a cylinder to the game, with a cap and a weathered band."""
    cyl('rock', F(s, x, z), 0, 0, r, h)
    vcyl('rock', F(s, x, z), 0, 0, r + 0.12, h * 0.55, h * 0.8, n=12, top=False)


def pine(s, x, z, h=6.4, seed=1):
    """A pine: the trunk collides as a cylinder, the needles are out of reach."""
    fr = F(s, x, z)
    cyl('trunk', fr, 0, 0, 0.4, h)
    rnd = rnd_gen(seed)
    y = 1.9
    for k, r in enumerate((2.5, 2.0, 1.5, 1.0)):
        tint = GREENS[int(rnd() * len(GREENS))]
        top = min(h + 1.4, y + 2.6 - 0.35 * k)
        vcyl('pine', fr, 0, 0, r * (0.9 + 0.2 * rnd()), y, top, n=8, r1=0.12, tint=tint, top=False)
        y += 1.15


def round_tower(s, x, z, r, h, roof=True):
    cyl('castle', F(s, x, z), 0, 0, r, h)
    fr = F(s, x, z)
    vcyl('castle', fr, 0, 0, r + 0.3, h, h + 0.7, n=12, top=False)
    for i in range(10):          # merlons
        a = 2 * math.pi * i / 10
        vbox('castle', fr, (r + 0.15) * math.cos(a), h + 1.1, (r + 0.15) * math.sin(a), 0.7, 0.8, 0.7)
    if roof:
        vcyl('slates', fr, 0, 0, r + 0.5, h + 0.7, h + 3.8, n=12, r1=0.1, top=False)


# ------------------------------------------------------------------ ground and edges

def ground():
    GX, GZ = HX + 1.5, HZ + 1.5
    poly('grass', Frame(), [(-GX, 0, GZ), (GX, 0, GZ), (GX, 0, -GZ), (-GX, 0, -GZ)])
    collider(Frame(), 0, -0.5, 0, 2 * GX, 1.0, 2 * GZ, block=0)
    for sx in (-1, 1):
        flat('dirt', sx * 18.0, -40.0, sx * 22.0, 40.0, 0.004)       # the flank trails
    flat('dirt', -2.5, -38.0, 2.5, 38.0, 0.004)                      # the trail down the middle
    for s in (1, -1):
        flat('paving', -22.0, s * 41.2, 22.0, s * HZ, 0.006)         # the courtyard
        flat('paving', -4.0, s * 36.0, 4.0, s * 40.0, 0.006)         # the apron outside the gate


def perimeter():
    """The wall round the playable area, outside it, so it blocks nothing: dry stone along the
    field and cut stone round the keeps."""
    t = 1.6
    for sx in (-1, 1):
        x = sx * (HX + t / 2)
        wall(x, -40.0, x, 40.0, 6.0, t, 'rock', block=0)
        for sz in (-1, 1):
            wall(x, sz * 40.0, x, sz * (HZ + t), 6.5, t, 'castle', block=0)
    for sz in (-1, 1):
        wall(-HX - t, sz * (HZ + t / 2), HX + t, sz * (HZ + t / 2), 6.5, t, 'castle', block=0)
    # merlons along the back walls, and the field walls' coping
    for sz in (-1, 1):
        n = int(2 * (HX + t) / 2.0)
        for i in range(n):
            x = -HX - t + (i + 0.5) * 2 * (HX + t) / n
            vbox('castle', Frame(), x, 6.9, sz * (HZ + t / 2), 1.0, 0.8, t)
    for sx in (-1, 1):
        for sz in (-1, 1):
            n = int((HZ + t - 40.0) / 2.0)
            for i in range(n):
                z = sz * (40.0 + (i + 0.5) * (HZ + t - 40.0) / n)
                vbox('castle', Frame(), sx * (HX + t / 2), 6.9, z, t, 0.8, 1.0)
        vbox('rock', Frame(), sx * (HX + t / 2), 6.1, 0.0, t + 0.3, 0.25, 80.0)
    # corner towers, beyond the corners of the keeps
    for sx in (-1, 1):
        for sz in (-1, 1):
            fr = Frame(sx * (HX + 2.0), 0, sz * (HZ + 2.0))
            vcyl('castle', fr, 0, 0, 3.4, 0, 10.0, n=12, top=False)
            vcyl('castle', fr, 0, 0, 3.8, 10.0, 11.0, n=12, top=False)
            vcyl('slates', fr, 0, 0, 4.2, 11.0, 16.0, n=12, r1=0.1, top=False)


# ------------------------------------------------------------------ the keeps

def curtain(s):
    """The front wall of a keep: a gate in the middle, a tower each side of it, a postern each flank."""
    t = 1.4
    zc = 40.0
    segs = [(-HX, -22.0), (-18.0, -3.5), (3.5, 18.0), (22.0, HX)]
    for x0, x1 in segs:
        W(s, x0, zc, x1, zc, CURTAIN, t, 'castle')
        # arrow slits on the field face, and a plinth band
        zf = s * (zc - t / 2)
        face = '-z' if s > 0 else '+z'
        L, P = face_fn(face, min(x0, x1) if s > 0 else -max(x0, x1), max(x0, x1) if s > 0 else -min(x0, x1), zf, zf)
        face_quad('rock', P, 0, L, 0, 0.7)
        k = 2.0
        while k < L - 1.0:
            face_quad('dark', P, k - 0.1, k + 0.1, 2.9, 4.1)
            k += 3.2
        # merlons
        n = int((x1 - x0) / 2.0)
        for i in range(n):
            x = x0 + (i + 0.5) * (x1 - x0) / n
            vbox('castle', F(s, x, zc), 0, CURTAIN + 0.4, 0, 1.0, 0.8, t)
    for sx in (-1, 1):
        round_tower(s, sx * 5.7, zc, 2.2, 7.5)
        # the postern: a timber lintel over the gap, out of reach
        vbox('wood', F(s, sx * 20.0, zc), 0, CURTAIN - 0.5, 0, 4.4, 0.7, t + 0.3)
    # the great gate: a stone lintel with the timber doors folded back against the towers
    vbox('castle', F(s, 0, zc), 0, 5.0, 0, 8.4, 1.2, t + 0.4)
    for sx in (-1, 1):
        solid('wood', F(s, sx * 3.35, zc - 0.9), 0, 1.9, 0, 0.2, 3.8, 1.8)


def flag_hall(s):
    """Open to the courtyard, roofed, a doorway through each side wall, the flag on a plinth at the back."""
    cx, cz = 0.0, 49.0
    HW = 8.4
    # side walls with a doorway each, the back wall, and a pier at each front corner
    for sx in (-1, 1):
        W(s, sx * HW, 44.8, sx * HW, 47.3, 4.6, 1.2, 'castle')
        W(s, sx * HW, 50.7, sx * HW, 54.4, 4.6, 1.2, 'castle')
        for zz in (47.3, 50.7):
            solid('wood', F(s, sx * HW, zz), 0, 1.1, 0, 1.3, 2.2, 0.16)       # door posts, flush with the wall ends
        cyl('castle', F(s, sx * HW, 44.2), 0, 0, 0.7, 4.6)
        vcyl('castle', F(s, sx * HW, 44.2), 0, 0, 0.9, 4.6, 5.0, n=12, top=True)
    W(s, -HW - 0.6, 54.4, HW + 0.6, 54.4, 5.0, 1.2, 'castle')
    # the roof slab and its pitched shingles (visual only above it)
    zlo, zhi = (43.4, 54.9) if s > 0 else (-54.9, -43.4)
    slab('slates', -(HW + 0.9), zlo, HW + 0.9, zhi, CEIL_Y, 0.3, block=0)
    prism('slates', F(s, cx, cz), [(-(HW + 1.2), CEIL_Y + 0.3), (HW + 1.2, CEIL_Y + 0.3), (0, CEIL_Y + 2.6)], -6.0, 6.0)
    # rafters showing under the roof
    for z in (45.0, 49.0, 53.0):
        vbox('wood', F(s, 0, z), 0, CEIL_Y - 0.2, 0, 2 * HW, 0.35, 0.3, skip=())
    # the plinth the flag stands on, and the banners on the back wall
    vcyl('castle', F(s, 0, 49.8), 0, 0, 1.5, 0.0, 0.07, n=16, top=True)
    for x in (-5.0, 5.0):
        fr = F(s, x, 53.75)
        poly('banner', fr, [(0.8, 1.2, 0), (-0.8, 1.2, 0), (-0.8, 3.9, 0), (0.8, 3.9, 0)], TEAM_CLOTH[s])
    # braziers either side of the front
    for sx in (-1, 1):
        cyl('metal', F(s, sx * 4.2, 45.0), 0, 0, 0.35, 0.9)


def barracks(s):
    for sx in (-1, 1):
        cx, cz, w, d, h = sx * 27.0, 49.0, 7.0, 9.0, 5.0
        block(s, 'castle', cx, cz, w, d, h)
        fr = F(s, cx, cz)
        prism('slates', fr, [(-w / 2 - 0.5, h), (w / 2 + 0.5, h), (0, h + 2.0)], -d / 2 - 0.5, d / 2 + 0.5)
        # a door and two windows on the courtyard side, dark and flush
        face = '-x' if sx > 0 else '+x'
        xa, xb = cx - w / 2, cx + w / 2
        za, zb = cz - d / 2, cz + d / 2
        if s < 0:
            xa, xb, za, zb = -xb, -xa, -zb, -za
            face = {'-x': '+x', '+x': '-x'}[face]
        L, P = face_fn(face, xa, xb, za, zb)
        face_quad('dark', P, L / 2 - 0.7, L / 2 + 0.7, 0, 2.3)
        for t0 in (1.2, L - 2.2):
            face_quad('dark', P, t0, t0 + 1.0, 2.6, 3.9)


def courtyard(s):
    """Cover pushed to the walls, so the middle of the bailey stays open ground to fight and spawn on."""
    for sx in (-1, 1):
        crate(s, sx * 12.4, 53.4, 1.4, 1.0)
        crate(s, sx * 12.4, 53.4, 1.0, 1.0, base=1.0, yaw=0.4)
        crate(s, sx * 21.0, 42.4, 1.2, 1.0, yaw=0.2)
        cyl('rock', F(s, sx * 21.6, 53.6), 0, 0, 1.0, 1.0)         # a well-head: a hop
        prop('barrel', s, sx * 17.5, 53.8)
        prop('barrel', s, sx * 18.6, 53.2)
        prop('barrel', s, sx * 15.4, 53.9)


# ------------------------------------------------------------------ the field

def causeway():
    wall(0, -12.0, 0, 12.0, 1.4, 10.0, 'castle', top_key='paving')
    for sx in (-1, 1):                  # a low kerb of dressed stone along each edge, flush with the deck
        vbox('rock', Frame(), sx * 4.8, 1.55, 0.0, 0.4, 0.3, 24.0)


def field(s):
    ramp(s, 0, 0, 18.4, 0, 1.4, 12.0, 5.0, 'paving', 'castle')
    crate(s, -2.6, 5.5, 1.3, 1.0, base=1.4, key='wood')
    for sx in (-1, 1):
        # the ruined wall: an L of 3.0 m wall, broken at the top
        W(s, sx * 8.0, 26.0, sx * 15.0, 26.0, 3.0, 1.0, 'rock')
        W(s, sx * 15.0, 26.0, sx * 15.0, 30.5, 3.0, 1.0, 'rock')
        vbox('rock', F(s, sx * 9.5, 26.0), 0, 3.1, 0, 1.4, 0.2, 1.0)
        vbox('rock', F(s, sx * 13.0, 26.0), 0, 3.1, 0, 1.0, 0.2, 0.96)
        # low walls: a hop
        W(s, sx * 4.0, 34.0, sx * 11.0, 34.0, 1.0, 0.7, 'rock')
        W(s, sx * 13.5, 14.0, sx * 17.0, 14.0, 1.0, 0.7, 'rock')
        W(s, sx * 13.5, 14.0, sx * 13.5, 10.0, 1.0, 0.7, 'rock')
        # a boulder, a stump of tower, standing stones
        stone(s, sx * 21.0, 28.0 if sx > 0 else 24.0, 1.5, 2.9)
        round_tower(s, sx * 12.5, 5.0, 2.0, 3.2, roof=False)
        stone(s, sx * 8.5, 3.5, 1.0, 3.4)
        # a barricade of planks outside the gate
        block(s, 'wood', sx * 8.0, 37.0, 3.0, 0.5, 1.0, yaw=sx * 0.35)
        # the pine grove beyond the trail
        for i, (x, z) in enumerate(((25.0, 33.0), (27.5, 27.0), (24.5, 21.5), (28.5, 16.0), (25.5, 9.0), (29.0, 3.0),
                                    (26.5, 36.5), (23.8, 13.0))):
            pine(s, sx * x, z, 6.2 + 0.3 * (i % 3), seed=3 + i + (7 if sx > 0 else 0))
    # a couple of fallen blocks on the trail
    for sx in (-1, 1):
        crate(s, sx * 20.3, 19.0, 1.2, 1.0, key='wood', yaw=0.25)


# ------------------------------------------------------------------ beyond the walls

def backdrop():
    """Rolling hills on every side, dressed with pines, and far ranges. No colliders."""
    M = 8.0

    def height(x, z):
        dx = max(0.0, abs(x) - (HX + M))
        dz = max(0.0, abs(z) - (HZ + M))
        d = math.hypot(dx, dz)
        if d <= 0:
            return 0.0
        k = min(1.0, d / 60.0)
        k = k * k * (3 - 2 * k)
        n = (math.sin(x * 0.05 + 1.1) * math.cos(z * 0.04) + 0.6 * math.sin(x * 0.023 - z * 0.031 + 0.4)
             + 0.35 * math.sin(x * 0.1 + z * 0.08))
        return k * (8.0 + 5.0 * n)

    def lines(edge, reach):
        vs = list(range(-int(reach), -100, 20)) + list(range(-100, 101, 10)) + list(range(120, int(reach) + 1, 20))
        return sorted([v for v in vs if abs(v) > edge + 3] + [-edge, edge])
    xs, zs = lines(HX + 1.5, 260), lines(HZ + 1.5, 280)
    for i in range(len(xs) - 1):
        for j in range(len(zs) - 1):
            x0, x1, z0, z1 = xs[i], xs[i + 1], zs[j], zs[j + 1]
            if max(abs(x0), abs(x1)) <= HX + 1.5 and max(abs(z0), abs(z1)) <= HZ + 1.5:
                continue
            a, b, c, d = height(x0, z1), height(x1, z1), height(x1, z0), height(x0, z0)
            poly('hill', Frame(), [(x0, a, z1), (x1, b, z1), (x1, c, z0)])
            poly('hill', Frame(), [(x0, a, z1), (x1, c, z0), (x0, d, z0)])
    rnd = rnd_gen(41)
    # pines on the hills, none within the flat margin
    placed = 0
    while placed < 150:
        x, z = (rnd() - 0.5) * 300, (rnd() - 0.5) * 340
        if abs(x) < HX + M + 4 and abs(z) < HZ + M + 4:
            continue
        h = 6.0 + rnd() * 5.0
        fr = Frame(x, height(x, z), z)
        vcyl('trunk', fr, 0, 0, 0.35, 0, 2.5, n=6, top=False)
        y = 1.8
        tint = GREENS[int(rnd() * 4)]
        for r in (2.6, 2.1, 1.6, 1.1):
            vcyl('pine', fr, 0, 0, r * h / 8, y, y + h * 0.3, n=7, r1=0.1, tint=tint, top=False)
            y += h * 0.2
        placed += 1
    # far ranges
    for ang, dist, w, hgt in ((0.2, 240, 110, 46), (1.3, 255, 130, 38), (2.5, 235, 90, 52), (3.6, 250, 120, 40),
                              (4.5, 240, 100, 48), (5.5, 250, 110, 36)):
        cx, cz = math.cos(ang) * dist, math.sin(ang) * dist
        mf = Frame(cx, 0, cz, ang + math.pi / 2)
        prism('far', mf, [(-w / 2, 0), (w / 2, 0), (w / 2 - 18, hgt), (-w / 2 + 22, hgt)], -20, 20, srgb(0x6f7f8c))


def build_layout():
    ground()
    perimeter()
    causeway()
    for s in (1, -1):
        curtain(s)
        flag_hall(s)
        barracks(s)
        courtyard(s)
        field(s)
    backdrop()


result = run(build_layout)
