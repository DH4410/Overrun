"""
ARENA: a floodlit concrete pit for survival, generated in Blender. 64 by 64 m, four-fold symmetric.

Run inside Blender 4.2+ (Scripting tab, or through the Blender MCP):

    OVERRUN_REPO = r"C:/path/to/repo"
    exec(open(OVERRUN_REPO + "/scripts/blender/build_arena.py").read())

It rebuilds the ARENA collection and writes assets/maps/arena.glb and arena.json. Run with plain
Python instead and it only works out the collider tables (see mapkit.py, plan mode).

The layout (everything is laid out once and turned a quarter turn three times):

    dais         a 7.5 m raised disc in the middle, 0.9 m high, three steps up each side and a hop-high
                 parapet on each diagonal. The people start here.
    gates        a recess in the middle of each wall, where the hostiles come from
    quadrants    a low L of wall, two stacked crates, a pillar pair, a tall block and a jersey
                 barrier in each. Cover to fight from, with the middle left open.
    surround     a 6.5 m wall, tiers of stands beyond it, and a floodlight tower at each corner

Heights, for movement: low walls, crates and the dais parapet are 1.0 m (a hop); the dais is 0.9 m
(the steps, or a hop); everything else a player cannot climb is 2.8 m or more. There is nothing
overhead inside the walls, so CEIL_Y is only the height the spawn and nav casts start from.
"""
import math
import os

MAP = 'arena'
HX, HZ = 32.0, 32.0      # playable half extents
CEIL_Y = 6.0
DAIS_R, DAIS_H = 7.5, 0.9

MATERIALS = {
    'asphalt':  ((0.11, 0.11, 0.12), 4.0),
    'dais':     ((0.40, 0.40, 0.39), 3.0),
    'concrete': ((0.50, 0.50, 0.49), 3.0),
    'cmu':      ((0.44, 0.44, 0.43), 3.0),
    'steel':    ((0.30, 0.31, 0.33), 2.0),
    'wood':     ((0.45, 0.33, 0.22), 1.5),
    'lines':    ((0.85, 0.72, 0.18), 4.0),     # paint, a decal
    'dark':     ((0.04, 0.04, 0.05), 1.0),     # gate doors, flush
    'beacon':   ((1.00, 0.45, 0.15), 1.0),     # emissive: gate warning lights
    'glow':     ((1.00, 0.95, 0.85), 1.0),     # emissive: floodlight faces
    'stands':   ((1.00, 1.00, 1.00), 4.0),     # tiers, tinted
    # Detail with no collider: none of these is in the ghost probe's touch list.
    'trim':     ((0.58, 0.58, 0.56), 3.0),     # precast kerbs, pilasters, bands, copings
    'metal':    ((0.22, 0.23, 0.25), 2.0),     # rails, housings, ladders, lattice
    # arenadetail.py: more of the same, with no collider and no ghost probe on either.
    'fit':      ((0.35, 0.37, 0.40), 1.0),     # brackets, cameras, cabinets, collars, tinted per piece
    'mark':     ((1.00, 1.00, 1.00), 1.0),     # text, plates, stains, the crowd: a decal, tinted per piece
}
TINTED = {'stands', 'fit', 'mark'}
PROPS = {}

# Rounded edges, smooth normals and wear (roundkit_dh.py). Nothing in it emits a collider.
RK_ROUND = {'concrete': 0.08, 'cmu': 0.06, 'dais': 0.05, 'steel': 0.04, 'wood': 0.05, 'trim': 0.04, 'metal': 0.025}
RK_ROUND_DEFAULT = 0.04
RK_CELL = 8.0
RK_PLAIN = {'asphalt', 'lines', 'dark', 'beacon', 'glow', 'stands', 'mark'}
RK_WEAR = {'concrete': (0.30, 0.14), 'cmu': (0.30, 0.12, True), 'dais': (0.18, 0.10), 'steel': (0.12, 0.08),
           'wood': (0.22, 0.10), 'trim': (0.24, 0.10), 'metal': (0.0, 0.08)}
TINTED = TINTED | set(RK_WEAR)

exec(open(os.path.join(globals()['OVERRUN_REPO'], 'scripts', 'blender', 'mapkit.py')).read())
exec(open(os.path.join(REPO, 'scripts', 'blender', 'roundkit_dh.py')).read())

_vbox_round = vbox


def vbox(key, frame, cx, cy, cz, w, h, d, tint=WHITE, skip=('-y',)):
    """The rounding kit's box, except where the box is too slim for a bevel to show."""
    if min(w, h, d) < 0.2:
        return _vbox0(key, frame, cx, cy, cz, w, h, d, tint, skip)
    return _vbox_round(key, frame, cx, cy, cz, w, h, d, tint, skip)


TRIM = 0.004
QUARTER = math.pi / 2


def lin(a, b, n):
    return [a + (b - a) * i / n for i in range(n + 1)]


def ccol(fr, cx, cz, r, h, y0=0.0, block=1):
    """A cylinder collider on its own: the row cyl() would emit, for pieces that model their own look."""
    x, y, z = fr.world((cx, y0 + h / 2, cz))
    CYLINDERS.append([round(x, 4), round(y, 4), round(z, 4), round(r, 4), round(h, 4), block])


# ------------------------------------------------------------------ four-fold helpers

def RP(k, x, z):
    """(x, z) turned k quarter turns about the middle."""
    wx, _, wz = Frame(0, 0, 0, -k * QUARTER).world((x, 0.0, z))
    return round(wx, 4), round(wz, 4)


def QF(k, x, z, yaw=0.0, y=0.0):
    wx, wz = RP(k, x, z)
    return Frame(wx, y, wz, yaw - k * QUARTER)


def qwall(k, x0, z0, x1, z1, h, t, key, block=1):
    ax, az = RP(k, x0, z0)
    bx, bz = RP(k, x1, z1)
    wall(ax, az, bx, bz, h, t, key, block=block)


def qramp(k, x0, y0, z0, x1, y1, z1, width, key, side_key=None):
    ax, az = RP(k, x0, z0)
    bx, bz = RP(k, x1, z1)
    ramp(1, ax, y0, az, bx, y1, bz, width, key, side_key)


def qcrate(k, x, z, size=1.4, h=1.0, base=0.0, key='wood', yaw=0.0):
    wx, wz = RP(k, x, z)
    crate(1, wx, wz, size, h, base, key, yaw - k * QUARTER)
    for side in (0, 1):                                  # a stencilled label on two faces
        stencil(Frame(wx, base, wz, yaw - k * QUARTER + side * QUARTER), size, h, 0)


def qsolid(k, key, x, z, w, h, d, yaw=0.0, base=0.0):
    solid(key, QF(k, x, z, yaw, base), 0, h / 2, 0, w, h, d)


def vquad(key, ax, az, bx, bz, y0, y1, nx, nz, tint=WHITE):
    """A vertical rectangle from (ax, az) to (bx, bz), facing (nx, nz)."""
    p = [(ax, y0, az), (bx, y0, bz), (bx, y1, bz), (ax, y1, az)]
    n = newell(p)
    if n[0] * nx + n[2] * nz < 0:
        p.reverse()
    poly(key, Frame(), p, tint)


def upward(key, frame, pts, tint=WHITE):
    """A flat polygon in local (x, y, z), wound to face up."""
    pts = list(pts)
    if newell(pts)[1] < 0:
        pts.reverse()
    poly(key, frame, pts, tint)


def facing(key, frame, pts, nz=1.0, tint=WHITE):
    """A flat polygon, wound to face local +z (nz > 0) or -z."""
    pts = list(pts)
    if newell(pts)[2] * nz < 0:
        pts.reverse()
    poly(key, frame, pts, tint)


def annulus(key, r0, r1, y, n=64, dashed=False):
    """An upward-facing ring between two radii, for paint."""
    for i in range(n):
        if dashed and (i // 2) % 2:
            continue
        a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        p = [(r0 * math.cos(a0), y, r0 * math.sin(a0)), (r1 * math.cos(a0), y, r1 * math.sin(a0)),
             (r1 * math.cos(a1), y, r1 * math.sin(a1)), (r0 * math.cos(a1), y, r0 * math.sin(a1))]
        if newell(p)[1] < 0:
            p.reverse()
        poly(key, Frame(), p)


# ------------------------------------------------------------------ ground, dais, surround

def ground():
    GX, GZ = HX + 1.5, HZ + 1.5
    poly('asphalt', Frame(), [(-GX, 0, GZ), (GX, 0, GZ), (GX, 0, -GZ), (-GX, 0, -GZ)])
    collider(Frame(), 0, -0.5, 0, 2 * GX, 1.0, 2 * GZ, block=0)
    # beyond the stands: more of the same, so the horizon is never void
    A = 260.0
    poly('asphalt', Frame(), [(-A, -0.03, A), (A, -0.03, A), (A, -0.03, -A), (-A, -0.03, -A)])
    annulus('lines', 14.85, 15.15, 0.006, n=96, dashed=True)       # the ring the hostiles close on
    annulus('lines', DAIS_R + 4.4, DAIS_R + 4.6, 0.006, n=96)


def dais():
    # No blocker: the people spawn on it. Its edge is the step the ramps climb. The collider is the
    # 12-sided cylinder it always was; the look is a 24-sided drum with a rounded lip.
    R, H = DAIS_R, DAIS_H
    ccol(Frame(), 0, 0, R, H, block=0)
    # (the flat top is a cap, which takes a planar UV; a fan down to the axis would stripe the texture)
    lathe('dais', Frame(), 0, 0, [(R, 0.0), (R, H - 0.1), (R - 0.04, H - 0.03), (R - 0.12, H)], n=24, sharp=80.0,
          caps=(False, True))
    # a painted lip and a pale kerb at the foot
    annulus('lines', R - 0.55, R - 0.35, H + 0.006, n=64)
    annulus('lines', 5.6, 5.8, DAIS_H + 0.006, n=64)
    for k in range(4):
        # Steps rather than a ramp: three treads, each 0.225 m up from the last (the hostiles' route
        # grid joins cells whose floors differ by up to 0.25) and none over 0.7 m, so none is a blocker.
        for i in (1, 2, 3):
            qsolid(k, 'dais', 0.0, 7.0 + (3 - i) * 1.4 + 0.7, 4.0, 0.225 * i, 1.4)
            # a painted nosing on the outer edge of each tread
            zf = 7.0 + (3 - i) * 1.4 + 1.4
            fr = QF(k, 0, 0)
            yy = 0.225 * i + 0.006
            upward('lines', fr, [(-1.9, yy, zf - 0.14), (1.9, yy, zf - 0.14), (1.9, yy, zf - 0.02), (-1.9, yy, zf - 0.02)])
        # the parapet on each diagonal: 1.0 m, a hop, with the dais top as its floor
        solid('concrete', QF(k, 4.9, 4.9, math.pi / 4, DAIS_H), 0, 0.5, 0, 2.6, 1.0, 0.5)


def perimeter():
    """The wall round the playable area, outside it, so it blocks nothing."""
    t = 1.6
    H = 6.5
    for sz in (-1, 1):
        wall(-HX - t, sz * (HZ + t / 2), HX + t, sz * (HZ + t / 2), H, t, 'cmu', block=0)
    for sx in (-1, 1):
        wall(sx * (HX + t / 2), -HZ, sx * (HX + t / 2), HZ, H, t, 'cmu', block=0)
    # capping lip, and a yellow band along the foot of each face, broken at the gates
    for k in range(4):
        lip = QF(k, 0, HZ + t / 2)
        vbox('steel', lip, 0, H + 0.15, 0, 2 * (HX + t) + 0.3, 0.3, t + 0.3)
        for x0, x1 in ((-HX, -3.6), (3.6, HX)):
            ax, az = RP(k, x0, HZ - TRIM)
            bx, bz = RP(k, x1, HZ - TRIM)
            nx, nz = RP(k, 0, -1)
            vquad('lines', ax, az, bx, bz, 0.0, 0.4, nx, nz)

    # Detail on the inside face and along the top. Everything here is a non-touch key and none
    # of it stands more than 0.3 m off the wall, so no collider is needed and none is a ghost.
    for k in range(4):
        fi = QF(k, 0, HZ, math.pi)          # local +z points into the pit, the wall face is z = 0
        for sx in (-1, 1):
            vbox('trim', fi, sx * (6.0 + HX) / 2, 0.19, 0.11, HX - 6.0, 0.38, 0.22)       # kerb along the foot
            vbox('trim', fi, sx * (6.0 + HX) / 2, 3.3, 0.05, HX - 6.0, 0.16, 0.1, skip=())   # string course
            for xm in (11.0, 19.0, 27.0):
                x = sx * xm
                vbox('trim', fi, x, 3.25, 0.1, 0.7, 6.5, 0.2)                              # pilaster
                vbox('trim', fi, x, 6.4, 0.14, 0.9, 0.2, 0.28, skip=())                    # its cap
            for xm in (15.0, 23.0):
                x = sx * xm
                vbox('metal', fi, x, 4.6, 0.22, 0.7, 0.34, 0.42)                           # wall lamp housing
                facing('glow', fi, [(x - 0.26, 4.5, 0.436), (x + 0.26, 4.5, 0.436), (x + 0.26, 4.7, 0.436), (x - 0.26, 4.7, 0.436)])
                vbox('metal', fi, x, 5.5, 0.06, 1.7, 0.9, 0.12)                            # a vent
                for j in range(4):
                    vbox('metal', fi, x, 5.2 + j * 0.2, 0.14, 1.5, 0.06, 0.06, skip=())
        # a handrail along the top of the lip: posts and two rails
        LH = HZ + 0.8
        xs = [-HX - 1.0 + i * 4.0 for i in range(int((2 * HX + 2.0) / 4.0) + 1)]
        for x in xs:
            vbox('metal', QF(k, x, LH), 0, H + 0.3 + 0.55, 0, 0.08, 1.1, 0.08, skip=())
        for yr in (H + 0.3 + 0.55, H + 0.3 + 1.05):
            tube('metal', QF(k, 0, LH), [(xs[0], yr, 0), (xs[-1], yr, 0)], 0.025, n=6, caps=False)


SEATS = [srgb(h) for h in (0x8a3a32, 0x35568a, 0xc2a23c, 0x3c7a62)]


def stands():
    """Tiers of seating beyond each wall: concrete rises, rows of coloured seats with backrests, aisles
    and a handrail. Only the top of the first tier shows over the wall; the rest climbs away."""
    t = 1.6
    base, aisle = srgb(0x4a5262), srgb(0x8b8d92)
    for k in range(4):
        for i in range(4):
            d0 = HZ + t + 0.8 + i * 2.4
            h = 7.4 + i * 2.2
            fr = QF(k, 0, d0 + 1.2)
            w = 2 * (HX + t) + 4.0
            vbox('stands', fr, 0, h / 2, 0, w, h, 2.4, base)
            nsec = 8
            sw = (w - 1.0) / nsec
            for s in range(nsec):
                x = -w / 2 + 0.5 + sw * (s + 0.5)
                c = SEATS[(s + i + k) % 4]
                for zr in (-0.6, 0.6):
                    vbox('stands', fr, x, h + 0.2, zr, sw - 0.5, 0.4, 0.5, c, skip=('-y',))                 # the seat
                    vbox('stands', fr, x, h + 0.55, zr + 0.2, sw - 0.5, 0.5, 0.1, c, skip=('-y',))         # the back
            for s in range(nsec + 1):                                                                      # aisle steps
                vbox('stands', fr, -w / 2 + 0.5 + sw * s, h + 0.03, 0, 0.42, 0.06, 2.4, aisle, skip=('-y',))
            if i == 0:                                                                                     # front rail
                for x in lin(-w / 2 + 0.5, w / 2 - 0.5, 32):
                    vbox('metal', fr, x, h + 0.55, -1.12, 0.06, 1.1, 0.06, skip=())
                for yr in (h + 0.6, h + 1.05):
                    tube('metal', fr, [(-w / 2 + 0.5, yr, -1.12), (w / 2 - 0.5, yr, -1.12)], 0.022, n=6, caps=False)


def towers():
    """A floodlight tower at each corner, outside the stands: a lattice mast, a platform, a lamp bank."""
    P = 38.0
    for sx in (-1, 1):
        for sz in (-1, 1):
            x, z = sx * P, sz * P
            fr = Frame(x, 0, z, math.atan2(-x, -z))
            vbox('trim', fr, 0, 0.5, 0, 3.4, 1.0, 3.4)                                       # footing
            top = 25.0
            legs = [(-1, -1), (1, -1), (1, 1), (-1, 1)]

            def leg_at(c, y):
                f = 1.15 - 0.55 * (y / top)
                return (c[0] * f, y, c[1] * f)
            for c in legs:
                tube('metal', fr, [leg_at(c, 0.8), leg_at(c, top)], 0.1, n=6, caps=False)
            ys = [0.8 + i * (top - 0.8) / 6 for i in range(7)]
            for a, b in zip(ys, ys[1:]):
                for ci in range(4):
                    c0, c1 = legs[ci], legs[(ci + 1) % 4]
                    tube('metal', fr, [leg_at(c0, a), leg_at(c1, a)], 0.045, n=5, caps=False)       # ring brace
                    tube('metal', fr, [leg_at(c0, a), leg_at(c1, b)], 0.04, n=5, caps=False)        # diagonal
            vbox('metal', fr, 0, top + 0.15, 0, 2.4, 0.3, 2.4)                                   # platform
            vbox('steel', fr, 0, 27.6, 0, 7.0, 3.8, 0.7)
            vbox('glow', fr, 0, 27.6, 0.36, 6.2, 3.0, 0.08)
            for gx in (-2.07, 0.0, 2.07):                                                            # lamp cells
                vbox('metal', fr, gx - 1.03, 27.6, 0.4, 0.09, 3.0, 0.06, skip=())
            vbox('metal', fr, 3.1, 27.6, 0.4, 0.09, 3.0, 0.06, skip=())
            for gy in (26.6, 28.6):
                vbox('metal', fr, 0, gy, 0.4, 6.2, 0.09, 0.06, skip=())
            vbox('metal', fr, 0, 26.0, -0.1, 0.5, 2.0, 0.5)                                      # the stem under the bank


# ------------------------------------------------------------------ gates and cover

def gate(k):
    """A recess in the middle of a wall: two stub walls, a dark door in the wall, a warning light over it."""
    for sx in (-1, 1):
        qwall(k, sx * 5.6, 26.5, sx * 5.6, HZ, 3.2, 0.8, 'concrete')
    nx, nz = RP(k, 0, -1)
    ax, az = RP(k, -3.4, HZ - TRIM * 2)
    bx, bz = RP(k, 3.4, HZ - TRIM * 2)
    vquad('dark', ax, az, bx, bz, 0.0, 3.4, nx, nz)
    for x0, x1 in ((-3.7, -3.4), (3.4, 3.7)):                      # the door frame, flat on the wall
        ax, az = RP(k, x0, HZ - TRIM * 3)
        bx, bz = RP(k, x1, HZ - TRIM * 3)
        vquad('steel', ax, az, bx, bz, 0.0, 3.7, nx, nz)
    ax, az = RP(k, -3.7, HZ - TRIM * 3)
    bx, bz = RP(k, 3.7, HZ - TRIM * 3)
    vquad('steel', ax, az, bx, bz, 3.4, 3.7, nx, nz)
    ax, az = RP(k, -3.2, HZ - TRIM * 3)
    bx, bz = RP(k, 3.2, HZ - TRIM * 3)
    vquad('beacon', ax, az, bx, bz, 4.0, 4.3, nx, nz)
    # a yellow bar across the mouth, on the ground
    flat_k = [RP(k, -5.2, 26.0), RP(k, 5.2, 26.0), RP(k, 5.2, 26.3), RP(k, -5.2, 26.3)]
    p = [(x, 0.006, z) for x, z in flat_k]
    if newell(p)[1] < 0:
        p.reverse()
    poly('lines', Frame(), p)

    # --- detail: hazard bands on the jambs, a roller-shutter box over the door with its slats
    # part way down, beacon domes, copings on the stub walls, chevrons painted on the lane in.
    fi = QF(k, 0, HZ, math.pi)             # local +z points into the pit, the wall face is z = 0
    for sx in (-1, 1):
        x0, x1 = sorted((sx * 3.7, sx * 4.1))
        for j in range(12):
            facing('lines' if j % 2 == 0 else 'dark', fi,
                   [(x0, j * 0.3, 0.012), (x1, j * 0.3, 0.012), (x1, j * 0.3 + 0.3, 0.012), (x0, j * 0.3 + 0.3, 0.012)])
    vbox('metal', fi, 0, 4.05, 0.17, 8.4, 0.62, 0.34)
    for j in range(5):
        vbox('metal', fi, 0, 3.3 + j * 0.1 * 1.0, 0.07, 7.1, 0.08, 0.06, skip=())
    for sx in (-1, 1):
        lathe('metal', fi, sx * 4.5, 0.2, [(0.0, 4.4), (0.2, 4.4), (0.2, 4.5), (0.0, 4.5)], n=10)
        lathe('beacon', fi, sx * 4.5, 0.2, [(0.17, 4.5), (0.16, 4.62), (0.1, 4.74), (0.0, 4.78)], n=10)
        vbox('trim', QF(k, sx * 5.6, (26.5 + HZ) / 2), 0, 3.24, 0, 1.0, 0.1, HZ - 26.5 + 0.2)   # coping
        # hazard bands on the nose of each stub wall, facing the middle of the pit
        for j in range(8):
            xa, xb = sorted((sx * 5.6 - 0.3, sx * 5.6 + 0.3))
            facing('lines' if j % 2 == 0 else 'dark', QF(k, 0, 0),
                   [(xa, j * 0.4, 26.5 - 0.01), (xb, j * 0.4, 26.5 - 0.01), (xb, j * 0.4 + 0.4, 26.5 - 0.01),
                    (xa, j * 0.4 + 0.4, 26.5 - 0.01)], nz=-1.0)
    for i in range(3):                                                    # chevrons pointing the way in
        zc = 24.2 - i * 1.7
        upward('lines', QF(k, 0, 0), [(-1.7, 0.007, zc + 0.8), (0.0, 0.007, zc - 0.1), (1.7, 0.007, zc + 0.8),
                                      (1.7, 0.007, zc + 0.36), (0.0, 0.007, zc - 0.56), (-1.7, 0.007, zc + 0.36)])


def pillar(fr, r, h=3.6):
    """A 3.6 m column: the collider is the 12-sided cylinder it always was and the shaft shares its
    vertices (straight, so no taper for a ray to graze); the plinth, bands and capital are non-touch
    trim just outside it, and the steel cap sits within 0.2 m of the collider's top."""
    ccol(fr, 0, 0, r, h)
    lathe('concrete', fr, 0, 0, [(r, 0.0), (r, h - 0.1), (r - 0.05, h - 0.03), (r - 0.12, h), (0.0, h)], n=12, sharp=80.0)
    lathe('trim', fr, 0, 0, [(r + 0.12, 0.0), (r + 0.12, 0.22), (r + 0.05, 0.32), (r, 0.34)], n=12, sharp=80.0)
    lathe('steel', fr, 0, 0, [(r, h), (r, h + 0.12), (r - 0.08, h + 0.18), (0.0, h + 0.18)], n=12, sharp=80.0)
    for j in range(4):                                                    # a hazard band round the foot
        yb = 0.4 + j * 0.2
        lathe('lines' if j % 2 == 0 else 'dark', fr, 0, 0, [(r + 0.012, yb), (r + 0.012, yb + 0.2)], n=12)
    for yb in (h - 0.55, h - 0.35):                                       # form bands near the head
        lathe('trim', fr, 0, 0, [(r + 0.04, yb), (r + 0.04, yb + 0.12)], n=12)


def stencil(fr, size, h, face):
    """A painted label on one face of a crate: a pale plate with a dark border strip."""
    hs = size / 2 + 0.006
    w, hh = size * 0.42, 0.14
    y = h * 0.55
    if face == 0:
        pts = [(-w, y - hh, hs), (w, y - hh, hs), (w, y + hh, hs), (-w, y + hh, hs)]
        facing('lines', fr, pts, nz=1.0)
        facing('dark', fr, [(-w * 0.8, y - hh * 0.4, hs + 0.002), (w * 0.8, y - hh * 0.4, hs + 0.002),
                            (w * 0.8, y + hh * 0.4, hs + 0.002), (-w * 0.8, y + hh * 0.4, hs + 0.002)], nz=1.0)


def ladder(fr, x, z, h, w=0.5):
    """A steel ladder up a face, standing 0.1 m off it: two rails and rungs every 0.3 m."""
    for sx in (-1, 1):
        tube('metal', fr, [(x + sx * w / 2, 0.05, z), (x + sx * w / 2, h, z)], 0.025, n=6, caps=False)
    for y in lin(0.3, h - 0.2, int((h - 0.5) / 0.3)):
        tube('metal', fr, [(x - w / 2, y, z), (x + w / 2, y, z)], 0.02, n=5, caps=False)


def quadrant(k):
    """One quarter's cover, laid out for the quarter x, z > 0 and turned into place."""
    # two pillars
    pillar(QF(k, 11.5, 11.5), 1.2)
    pillar(QF(k, 22.0, 22.0), 1.4)
    # a low L, a pocket facing the middle
    qwall(k, 16.0, 6.0, 16.0, 15.0, 1.0, 0.6, 'concrete')
    qwall(k, 16.0, 15.0, 25.0, 15.0, 1.0, 0.6, 'concrete')
    # two stacked crates
    qcrate(k, 22.0, 7.5, 2.0, 1.0)
    qcrate(k, 22.0, 7.5, 1.3, 1.0, base=1.0, yaw=0.3)
    # a tall block, and a jersey barrier by the gate
    qsolid(k, 'concrete', 24.5, 20.5, 3.4, 2.8, 1.4)
    qsolid(k, 'concrete', 8.5, 24.0, 3.0, 1.0, 0.6, yaw=math.pi / 2)
    # a steel ladder up the face of the block that looks at the middle, and a hazard band round its foot
    fb = QF(k, 24.5, 20.5, math.pi)
    ladder(fb, 0.9, 0.78, 2.9)
    for j in range(4):
        yb = 0.3 + j * 0.25
        facing('lines' if j % 2 == 0 else 'dark', fb, [(-1.7, yb, 0.706), (-0.1, yb, 0.706), (-0.1, yb + 0.25, 0.706), (-1.7, yb + 0.25, 0.706)])


exec(open(os.path.join(REPO, 'scripts', 'blender', 'arenadetail.py')).read())   # signs, crowd, fittings, floor marks


def build_layout():
    ground()
    dais()
    perimeter()
    stands()
    towers()
    for k in range(4):
        gate(k)
        quadrant(k)
    arena_detail()
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
