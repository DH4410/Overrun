"""
DEPOT: a warehouse hall for the 1v1 duel, generated in Blender. 36 by 52 m under one roof,
small enough that the other player is never more than a few seconds away and big enough to have
a lane to take.

Run inside Blender 4.2+ (Scripting tab, or through the Blender MCP):

    OVERRUN_REPO = r"C:/path/to/repo"
    exec(open(OVERRUN_REPO + "/scripts/blender/build_depot.py").read())

It rebuilds the DEPOT collection and writes assets/maps/depot.glb and depot.json.

The layout, south half (the north half is the same turned half a turn):

    spawn end       z 18..26: a roller door in the end wall, a pair of hop-high barriers in front
    west lane       x -17..-10: two containers with a gap between, racking on the wall, crates
    stage           |x| < 6.5, |z| < 5.5: a raised steel deck, 1.4 m, a ramp at each end
    east lane       x 10..17: two containers, racking, a roofless site office in the corner
    pillars         steel columns in two rows, full height

Heights: crates and barriers are 1.0 m (a hop), the stage is 1.4 m (the ramps, or a hop off a
crate), containers are 2.59 m (walls). The roof is at 7.0 m, which is CEIL_Y.
"""
import math
import os

MAP = 'depot'
HX, HZ = 18.0, 26.0      # playable half extents
WALL_H = 7.0
CEIL_Y = 7.0             # underside of the roof

MATERIALS, TINTED, PROPS = {}, set(), {}
SMOOTH = set()
exec(open(os.path.join(globals()['OVERRUN_REPO'], 'scripts', 'blender', 'mapkit.py')).read())
exec(open(os.path.join(globals()['OVERRUN_REPO'], 'scripts', 'blender', 'urbankit.py')).read())
MATERIALS.update(URBAN_MATERIALS)
MATERIALS['skylight'] = ((0.80, 0.90, 1.00), 1.0)
TINTED |= URBAN_TINTED
PROPS.update(URBAN_PROPS)


def shell():
    t = 0.6
    H = WALL_H + 0.3
    for sx in (-1, 1):
        wall(sx * (HX + t / 2), -HZ - t, sx * (HX + t / 2), HZ + t, H, t, 'cmu', block=0)
    for sz in (-1, 1):
        wall(-HX - t, sz * (HZ + t / 2), HX + t, sz * (HZ + t / 2), H, t, 'cmu', block=0)
    for face, (xa, xb, za, zb) in (('+x', (-HX - t, -HX, -HZ, HZ)), ('-x', (HX, HX + t, -HZ, HZ)),
                                   ('+z', (-HX, HX, -HZ - t, -HZ)), ('-z', (-HX, HX, HZ, HZ + t))):
        L, P = face_fn(face, xa, xb, za, zb)
        face_quad('concrete', P, 0, L, 0, 1.3)               # a dado of poured concrete
        o = {'+z': (0, 0, 0.12), '-z': (0, 0, -0.12), '+x': (0.12, 0, 0), '-x': (-0.12, 0, 0)}[face]
        k = 3.0
        while k < L - 0.5:                                    # pilasters
            c = P(k, 0)
            vbox('concrete', Frame(c[0] + o[0], 0, c[2] + o[2]), 0, WALL_H / 2, 0, 0.5, WALL_H, 0.5)
            k += 6.0
    # roller doors in the end walls and a loading door in each side wall: dark leaves with a glow
    # strip over them, painted on the inside face
    for sz in (-1, 1):
        zf = sz * (HZ - TRIM)
        q = [(-3.4, 0.0, zf), (3.4, 0.0, zf), (3.4, 4.6, zf), (-3.4, 4.6, zf)]
        poly('dark', Frame(), q if sz < 0 else q[::-1])
        for r in range(8):
            y = 0.5 + r * 0.55
            q2 = [(-3.4, y, zf - sz * 0.01), (3.4, y, zf - sz * 0.01), (3.4, y + 0.06, zf - sz * 0.01), (-3.4, y + 0.06, zf - sz * 0.01)]
            poly('steel', Frame(), q2 if sz < 0 else q2[::-1])
        vbox('glow', Frame(0, 0, zf - sz * 0.05), 0, 5.2, 0, 1.2, 0.16, 0.05, skip=())
    for sx in (-1, 1):
        xf = sx * (HX - TRIM)
        q = [(xf, 0.0, -3.0), (xf, 0.0, 3.0), (xf, 3.8, 3.0), (xf, 3.8, -3.0)]
        poly('dark', Frame(), q if sx < 0 else q[::-1])
        vbox('glow', Frame(xf - sx * 0.05, 0, 0), 0, 4.4, 0, 0.05, 0.16, 1.2, skip=())


def floor_and_roof():
    GX, GZ = HX + 0.6, HZ + 0.6
    poly('floor', Frame(), [(-GX, 0, GZ), (GX, 0, GZ), (GX, 0, -GZ), (-GX, 0, -GZ)])
    collider(Frame(), 0, -0.5, 0, 2 * GX, 1.0, 2 * GZ, block=0)
    # painted lanes: a hazard frame round the stage and walkway lines down both lanes
    for (x0, z0, x1, z1) in ((-7.4, -6.4, -7.1, 6.4), (7.1, -6.4, 7.4, 6.4), (-7.4, 6.1, 7.4, 6.4), (-7.4, -6.4, 7.4, -6.1)):
        flat('lines', x0, z0, x1, z1, 0.008)
    for sx in (-1, 1):
        flat('lines', sx * 9.5, -22.0, sx * 9.62, 22.0, 0.008)
    # the roof, its trusses, and skylight panels on its underside
    slab('roof', -GX, -GZ, GX, GZ, CEIL_Y, 0.3, block=0)
    for z in range(-21, 22, 7):
        vbox('steel', Frame(), 0, CEIL_Y - 0.35, z, 2 * HX, 0.5, 0.25, skip=())
    for x in (-12, -4, 4, 12):
        vbox('steel', Frame(), x, CEIL_Y - 0.2, 0, 0.18, 0.2, 2 * HZ, skip=())
    for xc in (-10.0, 0.0, 10.0):
        for z0 in range(-24, 24, 7):
            a, b = z0 + 0.5, z0 + 6.5
            poly('skylight', Frame(), [(xc - 1.3, CEIL_Y - 0.02, a), (xc + 1.3, CEIL_Y - 0.02, a),
                                       (xc + 1.3, CEIL_Y - 0.02, b), (xc - 1.3, CEIL_Y - 0.02, b)])


def hanging_lamp(x, z):
    fr = Frame(x, 0, z)
    vbox('rail', fr, 0, CEIL_Y - 0.65, 0, 0.04, 1.3, 0.04, skip=())
    vbox('rail', fr, 0, 5.78, 0, 0.9, 0.2, 0.9, skip=('-y',))
    vbox('glow', fr, 0, 5.66, 0, 0.7, 0.02, 0.7, skip=())


LAMP_AT = [(0.0, 0.0), (0.0, 12.0), (0.0, -12.0), (-9.0, 6.0), (9.0, -6.0), (9.0, 18.0), (-9.0, -18.0)]


def stage():
    # the raised deck: a hop off a crate, or up a ramp at either end
    box_xz('concrete', -6.5, 6.5, -5.5, 5.5, 0.0, 1.4, top_key='steel')
    for sx in (-1, 1):
        for sz in (-1, 1):
            vbox('rail', Frame(sx * 6.0, 1.4, sz * 5.0), 0, 0.07, 0, 0.5, 0.14, 0.5, skip=('-y',))


def per_side(s):
    ramp(s, 0, 0, 12.0, 0, 1.4, 5.5, 4.4, 'steel', 'concrete')
    # spawn end: two barriers in front of the door, a lane between them
    for sx in (-1, 1):
        wall(s * sx * 2.2, s * 18.0, s * sx * 6.8, s * 18.0, 1.0, 0.45, 'concrete', top_key='steel')
    crate(s, -10.2, 23.4, 1.2, 1.0)
    crate(s, 10.2, 23.0, 1.2, 1.0, yaw=0.3)
    # west lane
    container(s, -12.0, 9.0, False, CONTAINERS[0])
    container(s, -12.0, 17.2, False, CONTAINERS[2])
    crate(s, -15.0, 3.6, 1.4, 1.0)
    crate(s, -15.1, 5.0, 1.2, 1.0)
    crate(s, -15.0, 3.7, 1.0, 0.9, base=1.0, yaw=0.3)
    crate(s, -6.4, 15.6, 1.2, 1.0)
    crate(s, -5.0, 16.0, 1.0, 1.0, yaw=0.4)
    for z in (7.0, 8.2, 9.4):
        prop('shelves', s, -17.3, z, math.pi / 2)
    barrel_cluster(s, -15.6, 24.4, 3)
    # east lane
    container(s, 12.0, 10.0, False, CONTAINERS[1])
    container(s, 12.0, 18.2, False, CONTAINERS[3])
    crate(s, 14.6, 3.0, 1.4, 1.0)
    crate(s, 5.6, 13.6, 1.2, 1.0)
    for z in (13.5, 14.7, 15.9):
        prop('shelves', s, 17.3, z, -math.pi / 2)
    barrel_cluster(s, 15.8, 6.0, 5)
    bldg(s, 10.0, 17.0, 20.2, 25.6, {'N': [3.0], 'W': [2.5]}, 'stucco', False, h=3.0, seed=3)
    crate(s, 15.6, 23.6, 1.0, 1.0)
    # stage crates: cover on the deck
    crate(s, -4.4, 2.6, 1.4, 1.0, base=1.4)
    crate(s, 4.8, 3.6, 1.2, 1.0, base=1.4)
    # steel columns
    for (x, z) in ((-8.5, 12.5), (8.5, 12.5), (-8.5, 23.0), (8.5, 23.0)):
        cyl('steel', F(s, x, z), 0, 0, 0.45, CEIL_Y)


def build_layout():
    shell()
    floor_and_roof()
    stage()
    both(per_side)
    for x, z in LAMP_AT:
        hanging_lamp(x, z)


result = run(build_layout)
