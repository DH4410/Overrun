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
}
TINTED = {'stands'}
PROPS = {}

exec(open(os.path.join(globals()['OVERRUN_REPO'], 'scripts', 'blender', 'mapkit.py')).read())

TRIM = 0.004
QUARTER = math.pi / 2


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


def qsolid(k, key, x, z, w, h, d, yaw=0.0, base=0.0):
    solid(key, QF(k, x, z, yaw, base), 0, h / 2, 0, w, h, d)


def vquad(key, ax, az, bx, bz, y0, y1, nx, nz, tint=WHITE):
    """A vertical rectangle from (ax, az) to (bx, bz), facing (nx, nz)."""
    p = [(ax, y0, az), (bx, y0, bz), (bx, y1, bz), (ax, y1, az)]
    n = newell(p)
    if n[0] * nx + n[2] * nz < 0:
        p.reverse()
    poly(key, Frame(), p, tint)


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
    # No blocker: the people spawn on it. Its edge is the step the ramps climb.
    cyl('dais', Frame(), 0, 0, DAIS_R, DAIS_H, block=0)
    annulus('lines', 5.6, 5.8, DAIS_H + 0.006, n=64)
    for k in range(4):
        # Steps rather than a ramp: three treads, each 0.225 m up from the last (the hostiles' route
        # grid joins cells whose floors differ by up to 0.25) and none over 0.7 m, so none is a blocker.
        for i in (1, 2, 3):
            qsolid(k, 'dais', 0.0, 7.0 + (3 - i) * 1.4 + 0.7, 4.0, 0.225 * i, 1.4)
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


def stands():
    """Tiers of seating beyond each wall: dark masses, and a paler band on every tier."""
    t = 1.6
    base, seat = srgb(0x232a36), srgb(0x4a3f4c)
    for k in range(4):
        for i in range(4):
            d0 = HZ + t + 0.8 + i * 2.4
            h = 7.4 + i * 2.2
            fr = QF(k, 0, d0 + 1.2)
            w = 2 * (HX + t) + 4.0
            vbox('stands', fr, 0, h / 2, 0, w, h, 2.4, base)
            vbox('stands', fr, 0, h + 0.06, -0.55, w - 1.0, 0.12, 1.1, seat, skip=('-y',))


def towers():
    """A floodlight tower at each corner, outside the stands."""
    P = 38.0
    for sx in (-1, 1):
        for sz in (-1, 1):
            x, z = sx * P, sz * P
            vcyl('steel', Frame(x, 0, z), 0, 0, 0.55, 0.0, 26.0, n=8, top=False)
            vcyl('steel', Frame(x, 0, z), 0, 0, 1.2, 0.0, 1.2, n=8)
            fr = Frame(x, 0, z, math.atan2(-x, -z))
            vbox('steel', fr, 0, 27.6, 0, 7.0, 3.8, 0.7)
            vbox('glow', fr, 0, 27.6, 0.36, 6.2, 3.0, 0.08)


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


def quadrant(k):
    """One quarter's cover, laid out for the quarter x, z > 0 and turned into place."""
    # two pillars
    cyl('concrete', QF(k, 11.5, 11.5), 0, 0, 1.2, 3.6)
    vcyl('steel', QF(k, 11.5, 11.5), 0, 0, 1.2, 3.6, 3.78, n=12)
    cyl('concrete', QF(k, 22.0, 22.0), 0, 0, 1.4, 3.6)
    vcyl('steel', QF(k, 22.0, 22.0), 0, 0, 1.4, 3.6, 3.78, n=12)
    # a low L, a pocket facing the middle
    qwall(k, 16.0, 6.0, 16.0, 15.0, 1.0, 0.6, 'concrete')
    qwall(k, 16.0, 15.0, 25.0, 15.0, 1.0, 0.6, 'concrete')
    # two stacked crates
    qcrate(k, 22.0, 7.5, 2.0, 1.0)
    qcrate(k, 22.0, 7.5, 1.3, 1.0, base=1.0, yaw=0.3)
    # a tall block, and a jersey barrier by the gate
    qsolid(k, 'concrete', 24.5, 20.5, 3.4, 2.8, 1.4)
    qsolid(k, 'concrete', 8.5, 24.0, 3.0, 1.0, 0.6, yaw=math.pi / 2)


def build_layout():
    ground()
    dais()
    perimeter()
    stands()
    towers()
    for k in range(4):
        gate(k)
        quadrant(k)


result = run(build_layout)
