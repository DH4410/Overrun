"""
SNOW: a research outpost in a mountain valley at the end of a winter afternoon, generated in
Blender.

Run inside Blender 4.2+ (Scripting tab, or through the Blender MCP):

    OVERRUN_REPO = r"C:/path/to/repo"
    exec(open(OVERRUN_REPO + "/scripts/blender/build_snow.py").read())

It rebuilds the SNOW collection and writes assets/maps/snow.glb and snow.json. Run it with plain
Python instead and it only works out the collider tables (see mapkit.py, plan mode).

The layout, south half (the north half is the same turned half a turn):

    spawn yard      |x| < 13, z 23..34: two cabins against the fence, a snow-block wall in front
    approach        |x| < 13, z 12..23: a container across the road, barriers, a woodpile
    the pond        |x| < 13, |z| < 9: open ice round a radio mast on a concrete island
    station         x 18..38, z 9..16: a building you can walk through, two rooms and a hall,
                    real window openings
    tank farm       x 26..41, z 21.5..32.5: fuel tanks behind a hop-high concrete bund
    motor pool      x -36..-22, z 14..24: an open-fronted garage with a snowcat in it

so each flank has a station at one end and a garage at the other, and a duel starts from two
identical ends.

Heights, for movement: berms, bunds, crates, counters and the mast island are 1.0 m or under
(a hop); a container is 2.59 m and everything else a player should not climb is 4 m or more.
The station and the garage are roofed at 4.0 m, which is CEIL_Y.
"""
import math
import os

MAP = 'snow'
HX, HZ = 44.0, 34.0      # playable half extents
FENCE_H = 4.6            # the perimeter fence
CEIL_Y = 4.0             # underside of the station and garage roofs

# key: (preview colour, metres per texture tile). src/mapSnow.js picks the texture per key.
MATERIALS = {
    'snow':     ((0.88, 0.90, 0.93), 4.0),
    'drift':    ((0.88, 0.90, 0.93), 10.0),    # beyond the fence, no collider
    'snowcap':  ((0.90, 0.92, 0.95), 3.0),     # snow lying on roofs and wall tops
    'track':    ((0.55, 0.56, 0.58), 4.0),     # packed, dirty snow on the roads: decal
    'ice':      ((0.60, 0.70, 0.78), 6.0),     # the pond: decal
    'berm':     ((0.85, 0.88, 0.92), 1.6),     # cut snow blocks
    'concrete': ((0.55, 0.55, 0.53), 3.0),
    'floor':    ((0.45, 0.45, 0.44), 3.0),     # indoor floors: decal
    'red':      ((0.55, 0.17, 0.13), 2.5),     # corrugated cladding, painted
    'ochre':    ((0.72, 0.50, 0.18), 2.5),
    'grey':     ((0.45, 0.48, 0.50), 2.5),     # the fence
    'lining':   ((0.80, 0.78, 0.72), 3.0),     # inside walls, no collider of its own
    'steel':    ((0.30, 0.31, 0.32), 1.5),     # counters, racks, posts
    'rail':     ((0.30, 0.31, 0.32), 1.5),     # the same steel on visual-only bits
    'tank':     ((0.80, 0.80, 0.76), 3.0),     # white-painted fuel tanks
    'container': ((1.00, 1.00, 1.00), 2.0),    # ribbed container steel, tinted
    'wood':     ((0.45, 0.35, 0.25), 1.5),
    'trunk':    ((0.35, 0.28, 0.22), 1.0),
    'fir':      ((1.00, 1.00, 1.00), 1.0),     # fir foliage, tinted, no collider
    'paint':    ((1.00, 1.00, 1.00), 1.0),     # mast bands, the snowcat, signs, tinted
    'black':    ((0.05, 0.05, 0.05), 1.0),     # tracks, rubber
    'dark':     ((0.04, 0.05, 0.06), 1.0),     # window and doorway shadow, flush
    'glow':     ((1.00, 0.82, 0.55), 1.0),     # lit windows and lamps
    'far':      ((1.00, 1.00, 1.00), 12.0),    # backdrop, tinted
}
TINTED = {'container', 'fir', 'paint', 'far'}
SMOOTH = {'drift'}

# Poly Haven models: (slug, max triangles, collider, approximate w/h/d for plan mode). Named
# apart from DESERT's props, which share the Blender file.
PROPS = {
    'drum':      ('Barrel_01', 500, 'cyl', (0.56, 0.88, 0.56)),
    'barrier':   ('concrete_road_barrier', 500, 'box', (1.55, 0.84, 0.64)),
    'cabinet':   ('utility_box_02', 500, 'box', (0.92, 1.12, 0.43)),
    'snowcar':   ('covered_car', 2000, 'box', (1.79, 1.41, 4.38)),
    'shelves':   ('steel_frame_shelves_01', 500, 'box', (1.10, 2.14, 0.50)),
    'tyre':      ('old_tyre', 300, None, (0.60, 0.17, 0.60)),
}

exec(open(os.path.join(globals()['OVERRUN_REPO'], 'scripts', 'blender', 'mapkit.py')).read())
crate_kit = crate

TRIM = 0.003             # decoration stands this proud of a wall, so it adds nothing to walk into

CONTAINERS = [srgb(h) for h in (0x2f5d8a, 0x3f6b3a, 0x9a3a2a, 0xb07a2a)]
NEEDLES = srgb(0x2c4632)
NEEDLES_LIT = srgb(0x3b5a3c)
SNOWY = srgb(0xdfe6ec)
WHITE_PAINT = srgb(0xe8e8e4)
RED_PAINT = srgb(0xb3261e)
ORANGE = srgb(0xd9661f)


def rnd_gen(seed):
    state = [seed * 2654435761 % 2147483647 or 1]

    def rnd():
        state[0] = (state[0] * 1103515245 + 12345) & 0x7fffffff
        return state[0] / 0x7fffffff
    return rnd


# ------------------------------------------------------------------ building pieces

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


def box_xz(key, xa, xb, za, zb, y0, y1, skip=('-y',), block=1, top_key=None):
    """An axis-aligned solid between two corners and two heights, with its collider."""
    cx, cz, w, d = (xa + xb) / 2, (za + zb) / 2, xb - xa, zb - za
    if top_key:
        vbox(key, Frame(), cx, (y0 + y1) / 2, cz, w, y1 - y0, d, skip=tuple(skip) + ('+y',))
        poly(top_key, Frame(), [(xa, y1, zb), (xb, y1, zb), (xb, y1, za), (xa, y1, za)])
    else:
        vbox(key, Frame(), cx, (y0 + y1) / 2, cz, w, y1 - y0, d, skip=skip)
    collider(Frame(), cx, (y0 + y1) / 2, cz, w, y1 - y0, d, block)


def window(face, P, t, y, w=1.1, hgt=0.9, lit=False):
    """A window on a cabin wall: the pane flush (dark, or lit), a steel frame round it and a sill."""
    face_quad('glow' if lit else 'dark', P, t - w / 2, t + w / 2, y, y + hgt)
    Q = lambda tt, yy: tuple(a + b for a, b in zip(P(tt, yy), off(face, TRIM)))
    f = 0.07
    face_quad('rail', Q, t - w / 2 - f, t + w / 2 + f, y - f, y)
    face_quad('rail', Q, t - w / 2 - f, t + w / 2 + f, y + hgt, y + hgt + f)
    face_quad('rail', Q, t - w / 2 - f, t - w / 2, y, y + hgt)
    face_quad('rail', Q, t + w / 2, t + w / 2 + f, y, y + hgt)


def off(face, d):
    return {'+z': (0, 0, d), '-z': (0, 0, -d), '+x': (d, 0, 0), '-x': (-d, 0, 0)}[face]


def wall_unit(face, P, t, y=2.55):
    """An air handler hung high on a wall, above head height: a steel box with a dark grille."""
    c = P(t, y + 0.35)
    o = off(face, 0.19)
    along_x = face in ('+z', '-z')
    fr = Frame(c[0] + o[0], c[1], c[2] + o[2], 0.0 if along_x else math.pi / 2)
    vbox('rail', fr, 0, 0, 0, 1.0, 0.7, 0.38, skip=())
    g = off(face, 0.38 + TRIM)
    Q = lambda tt, yy: tuple(a + b for a, b in zip(P(tt, yy), g))
    face_quad('dark', Q, t - 0.4, t + 0.1, y + 0.12, y + 0.58)


def cabin(x0, z0, x1, z1, h, key='red', faces='+x-x+z-z', seed=1, door=None, aircon=None):
    """A prefab cabin: a solid clad block with snow lying on its flat roof, a concrete footing,
    framed windows (some lit) and a steel door. The collider is exactly the block."""
    xa, xb = sorted((x0, x1))
    za, zb = sorted((z0, z1))
    box_xz(key, xa, xb, za, zb, 0, h, top_key='snowcap')
    rnd = rnd_gen(seed)
    for face in ('+x', '-x', '+z', '-z'):
        L, P = face_fn(face, xa, xb, za, zb)
        face_quad('concrete', P, 0, L, 0, 0.45)
        face_quad('rail', P, 0, L, h - 0.35, h - 0.12)          # fascia
        face_quad('snowcap', P, 0, L, h - 0.12, h)               # the snow on the roof edge
        if face not in faces:
            continue
        n = int(L // 2.6)
        for i in range(n):
            t = (i + 0.5) * L / n
            if door and door[0] == face and abs(t - door[1]) < 1.6:
                continue
            if rnd() < 0.25:
                continue
            window(face, P, t, 1.45, lit=rnd() < 0.35)
    if door:
        face, t = door
        L, P = face_fn(face, xa, xb, za, zb)
        face_quad('steel', P, t - 0.6, t + 0.6, 0.12, 2.3)
        Q = lambda tt, yy: tuple(a + b for a, b in zip(P(tt, yy), off(face, TRIM)))
        face_quad('glow', Q, t - 0.15, t + 0.15, 2.55, 2.7)      # the lamp over the door
    if aircon:
        face, t = aircon
        L, P = face_fn(face, xa, xb, za, zb, e=0.0)
        wall_unit(face, P, t)


def wall_holes(x0, z0, x1, z1, h, t, key, holes, inner):
    """An axis-aligned wall from (x0, z0) to (x1, z1) with openings, holes = [(u0, u1, y0, y1)]
    measured along the wall from its start. Every piece collides. `inner` is the face ('+x',
    '-z', ...) that looks into the building: it gets the lining, the outside gets a footing."""
    along_x = abs(x1 - x0) > abs(z1 - z0)
    L = abs(x1 - x0) if along_x else abs(z1 - z0)
    sgn = 1 if (x1 - x0 if along_x else z1 - z0) > 0 else -1
    outer = {'+x': '-x', '-x': '+x', '+z': '-z', '-z': '+z'}[inner]

    def piece(u0, u1, y0, y1):
        if u1 - u0 < 0.01 or y1 - y0 < 0.01:
            return
        a, b = sorted((u0 * sgn, u1 * sgn))
        if along_x:
            xa, xb, za, zb = x0 + a, x0 + b, z0 - t / 2, z0 + t / 2
        else:
            xa, xb, za, zb = x0 - t / 2, x0 + t / 2, z0 + a, z0 + b
        box_xz(key, xa, xb, za, zb, y0, y1, skip=('-y',) if y0 == 0 else ())
        Li, Pi = face_fn(inner, xa, xb, za, zb)
        face_quad('lining', Pi, 0, Li, y0, y1)
        if y0 == 0:
            Lo, Po = face_fn(outer, xa, xb, za, zb)
            face_quad('concrete', Po, 0, Lo, 0, min(0.4, y1))
    u = 0.0
    for (u0, u1, y0, y1) in sorted(holes):
        piece(u, u0, 0, h)
        piece(u0, u1, 0, y0)
        piece(u0, u1, y1, h)
        u = u1
    piece(u, L, 0, h)


def roof(xa, xb, za, zb, y, t=0.35):
    """A flat roof slab resting on walls, snow on top, a steel fascia round its edge."""
    box_xz('rail', xa, xb, za, zb, y, y + t, skip=(), block=0, top_key='snowcap')


def fir(s, x, z, h=7.0, seed=1):
    """A snow-dusted fir. The trunk and the dense lower skirt collide as one cylinder; the
    foliage above head height is out of reach."""
    fr = F(s, x, z)
    wx, _, wz = fr.world((0, 0, 0))
    CYLINDERS.append([round(wx, 4), round(h / 2, 4), round(wz, 4), 0.7, round(h, 4), 1, 1])
    rnd = rnd_gen(seed)
    vcyl('trunk', fr, 0, 0, 0.2, 0, 1.2, n=6, r1=0.16, top=False)
    tiers = 4
    y = 0.75
    R = h * 0.29
    for k in range(tiers):
        th = (h - 0.75) / tiers * 1.45
        r0 = R * (1 - 0.2 * k) * (0.92 + 0.16 * rnd())
        ph = rnd() * 1.0
        n = 8
        lo, mid, hi = ring(r0, n, ph), ring(r0 * 0.55, n, ph), ring(0.08, n, ph)
        ym, yt = y + th * 0.42, y + th
        for i in range(n):
            j = (i + 1) % n
            poly('fir', fr, [(lo[j][0], y, lo[j][1]), (lo[i][0], y, lo[i][1]),
                             (mid[i][0], ym, mid[i][1]), (mid[j][0], ym, mid[j][1])],
                 NEEDLES if i % 2 else NEEDLES_LIT)
            poly('fir', fr, [(mid[j][0], ym, mid[j][1]), (mid[i][0], ym, mid[i][1]),
                             (hi[i][0], yt, hi[i][1]), (hi[j][0], yt, hi[j][1])], SNOWY)
        y += (h - 0.75) / tiers * 0.8


def tank(s, x, z, r=1.6, h=4.8, seed=1):
    """A fuel tank: a painted steel cylinder on a concrete ring, with hoops, a ladder and a
    domed lid. It collides as the kit's 12-sided cylinder, drawn with the same 12 sides."""
    fr = F(s, x, z)
    cyl('tank', fr, 0, 0, r, h)
    vcyl('concrete', fr, 0, 0, r + 0.25, 0, 0.25, 12)
    CYLINDERS.append(list(map(lambda v: round(v, 4), fr.world((0, 0.125, 0)))) + [round(r + 0.25, 4), 0.25, 1])
    for yy in (1.4, 2.8, 4.2):
        if yy < h - 0.2:
            vcyl('rail', fr, 0, 0, r + TRIM * 2, yy, yy + 0.08, 12, top=False)
    vcyl('snowcap', fr, 0, 0, r - 0.02, h, h + 0.35, 12, r1=0.35)
    # ladder up the side facing the bund's opening, visual only
    for sx in (-0.22, 0.22):
        vbox('rail', fr, sx, h / 2 + 0.2, r + 0.12, 0.05, h + 0.4, 0.05)
    k = 0.4
    while k < h:
        vbox('rail', fr, 0, k, r + 0.12, 0.44, 0.03, 0.03, skip=())
        k += 0.35
    poly('paint', fr, [(-0.5, 2.0, r + 0.02), (0.5, 2.0, r + 0.02), (0.5, 2.5, r + 0.02), (-0.5, 2.5, r + 0.02)], RED_PAINT)


def container(s, x, z, along_x, tint, h=2.59):
    """A 20 ft container: 6.06 by 2.44, too tall to jump. Doors drawn on one end."""
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2)
    L, W = 6.06, 2.44
    vbox('container', fr, 0, h / 2, 0, L, h, W, tint=tint, skip=('-y', '+y'))
    poly('snowcap', fr, [(-L / 2, h, W / 2), (L / 2, h, W / 2), (L / 2, h, -W / 2), (-L / 2, h, -W / 2)])
    collider(fr, 0, h / 2, 0, L, h, W)
    # door end: two leaves, lock bars
    q = [(L / 2 + TRIM, 0.1, W / 2 - 0.08), (L / 2 + TRIM, 0.1, -W / 2 + 0.08),
         (L / 2 + TRIM, h - 0.1, -W / 2 + 0.08), (L / 2 + TRIM, h - 0.1, W / 2 - 0.08)]
    poly('container', fr, q, tuple(c * 0.8 for c in tint))
    for zz in (-0.75, -0.35, 0.35, 0.75):
        vbox('rail', fr, L / 2 + 0.03, h / 2, zz, 0.04, h - 0.3, 0.04)
    # corner posts
    for sx in (-1, 1):
        for sz in (-1, 1):
            vbox('rail', fr, sx * (L / 2 - 0.06), h / 2, sz * (W / 2 - 0.06), 0.12 + 2 * TRIM, h, 0.12 + 2 * TRIM, skip=('-y', '+y'))


def berm(s, x, z, along_x, length, h=1.0, t=0.9):
    """A wall of cut snow blocks: a hop up, and cover from a crouch."""
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2)
    vbox('berm', fr, 0, h / 2, 0, length, h, t, skip=('-y', '+y'))
    poly('snowcap', fr, [(-length / 2, h, t / 2), (length / 2, h, t / 2), (length / 2, h, -t / 2), (-length / 2, h, -t / 2)])
    collider(fr, 0, h / 2, 0, length, h, t)


def bund(x0, z0, x1, z1, h=1.0, t=0.5):
    """A concrete bund wall, snow along its top."""
    wall(x0, z0, x1, z1, h, t, 'concrete', top_key='snowcap')


def woodpile(s, x, z, along_x=True, length=2.6):
    """Split logs stacked 1.0 m high between two posts. One box collider, flagged as a prop: the
    log ends are rounder than it."""
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2)
    collider(fr, 0, 0.5, 0, length, 1.0, 1.0, prop=1)
    r = 0.12
    hexa = [(r * math.cos(a), r * math.sin(a)) for a in [k * math.pi / 3 for k in range(6)]]
    rnd = rnd_gen(7)
    for row in range(4):
        yy = 0.13 + row * 0.235
        for c in range(4):
            zz = -0.36 + c * 0.24 + (0.12 if row % 2 else 0)
            if zz > 0.4:
                continue
            prof = [(-length / 2 + 0.1 + rnd() * 0.05, 0), (length / 2 - 0.1 - rnd() * 0.05, 0)]
            # a log along local x: extrude the hexagon along x by building its faces directly
            x0, x1 = prof[0][0], prof[1][0]
            for i in range(6):
                (ya, za), (yb, zb) = hexa[i], hexa[(i + 1) % 6]
                poly('trunk', fr, [(x0, yy + ya, zz + za), (x0, yy + yb, zz + zb), (x1, yy + yb, zz + zb), (x1, yy + ya, zz + za)][::-1])
            poly('wood', fr, [(x1, yy + ya, zz + za) for ya, za in hexa][::-1])
            poly('wood', fr, [(x0, yy + ya, zz + za) for ya, za in hexa])
    for sx in (-1, 1):
        vbox('rail', fr, sx * length / 2, 0.55, 0, 0.08, 1.1, 1.0)
    poly('snowcap', fr, [(-length / 2, 1.0, 0.5), (length / 2, 1.0, 0.5), (length / 2, 1.0, -0.5), (-length / 2, 1.0, -0.5)])


def crate(s, x, z, size=1.2, h=1.0, base=0.0, yaw=0.0):
    """The kit's framed crate, with snow on its lid."""
    crate_kit(s, x, z, size, h, base, 'wood', yaw)
    fr = F(s, x, z, yaw, base)
    hs = size / 2 - 0.015
    poly('snowcap', fr, [(-hs, h + 0.004, hs), (hs, h + 0.004, hs), (hs, h + 0.004, -hs), (-hs, h + 0.004, -hs)])


def lamp_post(s, x, z, yaw=0.0, h=4.4):
    """A steel lamp post: the pole collides; the arm and head are out of reach. The light is a
    lamp in mapSnow.js."""
    fr = F(s, x, z, yaw)
    solid('steel', fr, 0, h / 2, 0, 0.14, h, 0.14)
    vbox('rail', fr, 0, h - 0.1, -0.55, 0.08, 0.08, 1.1, skip=())
    vbox('rail', fr, 0, h - 0.2, -1.1, 0.34, 0.14, 0.5, skip=())
    vbox('glow', fr, 0, h - 0.28, -1.1, 0.26, 0.02, 0.4, skip=())


def member(p0, p1, w, key, tint=WHITE):
    """A thin square beam between two world points, for the lattice mast."""
    dx, dy, dz = p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]
    L = math.sqrt(dx * dx + dy * dy + dz * dz)
    ux, uy, uz = dx / L, dy / L, dz / L
    # any vector not parallel to the beam, then two perpendiculars
    ax, ay, az = (0, 1, 0) if abs(uy) < 0.9 else (1, 0, 0)
    px, py, pz = uy * az - uz * ay, uz * ax - ux * az, ux * ay - uy * ax
    n = math.sqrt(px * px + py * py + pz * pz)
    px, py, pz = px / n * w / 2, py / n * w / 2, pz / n * w / 2
    qx, qy, qz = uy * pz - uz * py, uz * px - ux * pz, ux * py - uy * px
    corners = [(px + qx, py + qy, pz + qz), (-px + qx, -py + qy, -pz + qz),
               (-px - qx, -py - qy, -pz - qz), (px - qx, py - qy, pz - qz)]
    for i in range(4):
        a, b = corners[i], corners[(i + 1) % 4]
        pts = [(p0[0] + a[0], p0[1] + a[1], p0[2] + a[2]), (p0[0] + b[0], p0[1] + b[1], p0[2] + b[2]),
               (p1[0] + b[0], p1[1] + b[1], p1[2] + b[2]), (p1[0] + a[0], p1[1] + a[1], p1[2] + a[2])]
        poly(key, Frame(), pts[::-1], tint)


def mast(h=24.0):
    """The radio mast on its island in the middle of the pond: a 3.2 m concrete plinth, 1.0 m
    high, with a lattice tower painted in red and white bands. Only the legs collide, and only
    where a player can reach them."""
    box_xz('concrete', -1.6, 1.6, -1.6, 1.6, 0, 1.0, top_key='snowcap')
    base, top_w = 1.2, 0.35
    half = lambda y: base - (base - top_w) * (y - 1.0) / (h - 1.0)
    band = 2.0
    n = int((h - 1.0) // band)
    for k in range(n):
        y0, y1 = 1.0 + k * band, 1.0 + (k + 1) * band
        a0, a1 = half(y0), half(y1)
        tint = RED_PAINT if (k // 2) % 2 == 0 else WHITE_PAINT
        c0 = [(a0, y0, a0), (-a0, y0, a0), (-a0, y0, -a0), (a0, y0, -a0)]
        c1 = [(a1, y1, a1), (-a1, y1, a1), (-a1, y1, -a1), (a1, y1, -a1)]
        for i in range(4):
            j = (i + 1) % 4
            member(c0[i], c1[i], 0.14, 'paint', tint)             # leg
            if k > 0:                                              # clear of heads on the plinth
                member(c0[i], c1[j], 0.06, 'paint', tint)         # diagonals
                member(c0[j], c1[i], 0.06, 'paint', tint)
            member(c1[i], c1[j], 0.07, 'paint', tint)             # strut
    for sx in (-1, 1):
        for sz in (-1, 1):
            c = half(2.25)
            collider(Frame(), sx * c, 2.25, sz * c, 0.2, 2.5, 0.2, block=0, prop=1)
    top = 1.0 + n * band
    a = half(top)
    box = Frame(0, top, 0)
    vbox('rail', box, 0, 0.05, 0, 2 * a + 0.4, 0.1, 2 * a + 0.4, skip=())
    member((0, top, 0), (0, top + 5.0, 0), 0.1, 'rail')
    for i, yaw in enumerate((0.3, 2.4, 4.4)):
        fr = Frame(0, top - 2.5, 0, yaw)
        vbox('paint', fr, 0, 0, a + 0.12, 0.5, 1.4, 0.12, tint=WHITE_PAINT, skip=())
    vbox('glow', box, 0, 5.1, 0, 0.22, 0.22, 0.22, skip=())


def dish(s, x, z, yaw=0.0):
    """A satellite dish on a 1.0 m concrete plinth, looking up at the southern sky."""
    fr = F(s, x, z, yaw)
    solid('concrete', fr, 0, 0.5, 0, 2.4, 1.0, 2.4, skip=('-y', '+y'))
    poly('snowcap', fr, [(-1.2, 1.0, 1.2), (1.2, 1.0, 1.2), (1.2, 1.0, -1.2), (-1.2, 1.0, -1.2)])
    vcyl('rail', fr, 0, 0, 0.16, 1.0, 3.2, n=8)
    # the bowl: rings of a paraboloid, tilted 40 degrees up, facing local -z
    R, depth, tilt = 1.7, 0.35, math.radians(50)
    ct, st = math.cos(tilt), math.sin(tilt)
    cy = 3.35

    def P(r, a):
        u, v = r * math.cos(a), r * math.sin(a)
        w = depth * (r / R) ** 2
        # dish-local (u right, v up, w toward the back) -> tilt about local x -> frame
        y = v * st + w * ct
        zz = -(- v * ct + w * st) + 0.3
        return (u, cy + y, zz)
    rings, seg = 3, 14
    for i in range(rings):
        r0, r1 = R * i / rings, R * (i + 1) / rings
        for k in range(seg):
            a0, a1 = 2 * math.pi * k / seg, 2 * math.pi * (k + 1) / seg
            q = [P(r0, a0), P(r1, a0), P(r1, a1), P(r0, a1)] if i else [P(0, 0), P(r1, a0), P(r1, a1)]
            poly('paint', fr, q, WHITE_PAINT)
            poly('paint', fr, q[::-1], srgb(0x9a9c9e))
    # the feed on three struts
    feed = P(0, 0)
    fx, fy, fz = fr.world((feed[0], feed[1] + 1.1 * ct, feed[2] - 1.1 * st))
    for k in range(3):
        a = 2 * math.pi * k / 3 + 0.5
        e = fr.world(P(R * 0.95, a))
        member(e, (fx, fy, fz), 0.04, 'rail')
    vbox('rail', Frame(fx, fy, fz), 0, 0, 0, 0.2, 0.2, 0.2, skip=())


def snowcat(s, x, z, yaw=0.0):
    """A tracked snowcat: tracks, hull, cab and a plough blade. One box collider, as a prop."""
    fr = F(s, x, z, yaw)
    collider(fr, 0, 1.3, -0.15, 3.2, 2.6, 5.3, prop=1)
    for sx in (-1, 1):
        vbox('black', fr, sx * 1.2, 0.45, 0.2, 0.8, 0.9, 4.2)
    vbox('paint', fr, 0, 1.2, 0.35, 1.7, 0.6, 3.7, tint=ORANGE)
    vbox('paint', fr, 0, 1.95, -0.2, 2.0, 0.9, 2.0, tint=ORANGE)
    vbox('paint', fr, 0, 2.47, -0.2, 2.1, 0.14, 2.1, tint=srgb(0x222222), skip=())
    for face in ('+x', '-x', '-z'):
        L, P = face_fn(face, -1.0, 1.0, -1.2, 0.8)
        Pl = lambda t, y, P=P: fr.world(P(t, y))
        poly('dark', Frame(), [Pl(0.15, 1.7), Pl(L - 0.15, 1.7), Pl(L - 0.15, 2.3), Pl(0.15, 2.3)])
    # plough blade in front (local -z)
    vbox('paint', fr, 0, 0.55, -2.35, 3.1, 0.9, 0.12, tint=srgb(0xd8b21c), skip=())
    vbox('rail', fr, 0, 0.7, -1.95, 0.2, 0.2, 0.8, skip=())
    vbox('glow', fr, 0.7, 2.3, -1.215, 0.25, 0.12, 0.02, skip=())
    vbox('glow', fr, -0.7, 2.3, -1.215, 0.25, 0.12, 0.02, skip=())


# ------------------------------------------------------------------ layout

def ground():
    GX, GZ = HX + 1.5, HZ + 1.5
    poly('snow', Frame(), [(-GX, 0, GZ), (GX, 0, GZ), (GX, 0, -GZ), (-GX, 0, -GZ)])
    collider(Frame(), 0, -0.5, 0, 2 * HX + 3, 1.0, 2 * HZ + 3, block=0)
    # the pond, an ellipse of ice
    n = 32
    pts = [(12.5 * math.cos(2 * math.pi * k / n), 0.006, -8.5 * math.sin(2 * math.pi * k / n)) for k in range(n)]
    poly('ice', Frame(), pts)
    for s in (1, -1):
        # the road from the gate to the pond, and the track round to each flank
        flat('track', s * -2.5, s * 9.0, s * 2.5, s * HZ, 0.005)
        flat('track', s * 2.5, s * 18.5, s * 18.0, s * 21.5, 0.005)
        flat('track', s * -22.0, s * 10.0, s * -2.5, s * 13.0, 0.005)


def perimeter():
    t = 0.3
    for sx in (-1, 1):
        wall(sx * (HX + t / 2), -HZ - t, sx * (HX + t / 2), HZ + t, FENCE_H, t, 'grey', block=0, top_key='snowcap')
    for sz in (-1, 1):
        wall(-HX - t, sz * (HZ + t / 2), HX + t, sz * (HZ + t / 2), FENCE_H, t, 'grey', block=0, top_key='snowcap')
    # a concrete footing and steel posts on the inner face, and wire on brackets along the top
    for face, (xa, xb, za, zb) in (('+x', (-HX - t, -HX, -HZ, HZ)), ('-x', (HX, HX + t, -HZ, HZ)),
                                   ('+z', (-HX, HX, -HZ - t, -HZ)), ('-z', (-HX, HX, HZ, HZ + t))):
        L, P = face_fn(face, xa, xb, za, zb)
        face_quad('concrete', P, 0, L, 0, 0.5)
        k = 0.0
        while k <= L + 0.01:
            c = P(min(k, L), 0)
            o = off(face, 0.06)
            fr = Frame(c[0] + o[0], 0, c[2] + o[2])
            vbox('rail', fr, 0, FENCE_H / 2 + 0.3, 0, 0.12, FENCE_H + 0.6, 0.12)
            ib = off(face, 0.35)
            member((c[0] + o[0], FENCE_H + 0.55, c[2] + o[2]), (c[0] + ib[0], FENCE_H + 0.95, c[2] + ib[2]), 0.05, 'rail')
            k += 3.0
        for i, (d, y) in enumerate(((0.12, FENCE_H + 0.62), (0.22, FENCE_H + 0.74), (0.32, FENCE_H + 0.88))):
            a, b = P(0, y), P(L, y)
            o = off(face, d)
            member((a[0] + o[0], y, a[2] + o[2]), (b[0] + o[0], y, b[2] + o[2]), 0.02, 'rail')
    # a gate behind each spawn, shut, and a guard hut outside it
    for s in (1, -1):
        face = '-z' if s > 0 else '+z'
        za, zb = (HZ, HZ + t) if s > 0 else (-HZ - t, -HZ)
        L, P = face_fn(face, -HX, HX, za, zb, e=2 * TRIM)
        mid = L / 2
        face_quad('rail', P, mid - 3.3, mid + 3.3, 0, FENCE_H + 0.3)
        face_quad('grey', P, mid - 3.1, mid - 0.05, 0.1, FENCE_H)
        face_quad('grey', P, mid + 0.05, mid + 3.1, 0.1, FENCE_H)
        Q = lambda tt, yy: tuple(a + b for a, b in zip(P(tt, yy), off(face, TRIM)))
        for k in range(6):
            c = WHITE_PAINT if k % 2 else RED_PAINT
            face_quad('paint', Q, mid - 3.0 + k, mid - 2.0 + k, 1.9, 2.3, c)
        vbox('red', Frame(), s * 7.0, 1.6, s * (HZ + 3.5), 3.0, 3.2, 3.0)
        vbox('snowcap', Frame(), s * 7.0, 3.26, s * (HZ + 3.5), 3.1, 0.12, 3.1, skip=('-y',))
    # corner watchtowers, outside the fence
    for sx in (-1, 1):
        for sz in (-1, 1):
            cx, cz = sx * (HX + 4.5), sz * (HZ + 4.5)
            for lx in (-1.3, 1.3):
                for lz in (-1.3, 1.3):
                    member((cx + lx * 1.3, 0, cz + lz * 1.3), (cx + lx, 6.0, cz + lz), 0.18, 'rail')
            vbox('grey', Frame(cx, 6.0, cz), 0, 1.2, 0, 3.0, 2.4, 3.0)
            vbox('dark', Frame(cx, 6.0, cz), 0, 1.4, 0, 3.0 + 2 * TRIM, 0.8, 3.0 + 2 * TRIM, skip=('-y', '+y'))
            vbox('snowcap', Frame(cx, 6.0, cz), 0, 2.5, 0, 3.6, 0.2, 3.6, skip=())


def spawn_yard():
    def per_side(s):
        cabin(s * -13, s * 28, s * -5, s * HZ, 4.6, 'red', seed=11 + s, door=('-z' if s > 0 else '+z', 4.0),
              aircon=('+x' if s > 0 else '-x', 2.8))
        cabin(s * 5, s * 28, s * 13, s * HZ, 4.4, 'ochre', seed=13 + s, door=('-z' if s > 0 else '+z', 4.5))
        berm(s, -6.25, 23.0, True, 6.5)
        berm(s, 6.25, 23.0, True, 6.5)
        crate(s, -0.6, 33.1, 1.2, 1.0)
        prop('drum', s, -2.4, 33.3, 0.3)
        prop('drum', s, 2.9, 33.3, 2.0)
        prop('tyre', s, 4.3, 27.7, 0.4)
        lamp_post(s, -3.4, 25.2, 0.0)
        lamp_post(s, 3.4, 25.2, 0.0)
        fir(s, -17.0, 31.5, 7.4, seed=15 + s)
        fir(s, 16.8, 31.0, 6.8, seed=17 + s)
    both(per_side)


def approach():
    def per_side(s):
        container(s, 0.0, 17.8, True, CONTAINERS[0])
        prop('barrier', s, -6.8, 15.0, 0.25)
        prop('barrier', s, 7.4, 14.2, -0.2)
        prop('barrier', s, -2.2, 12.6, 0.05)
        woodpile(s, -10.5, 18.5, True, 2.6)
        crate(s, 9.6, 18.8)
        crate(s, 10.6, 17.5, 1.0, 1.0)
        crate(s, 9.7, 18.8, 0.9, 0.9, base=1.0, yaw=0.3)
        prop('drum', s, 4.4, 19.4, 0.8)
        fir(s, -12.2, 13.8, 6.6, seed=21 + s)
    both(per_side)


def pond():
    mast()

    def per_side(s):
        berm(s, 7.8, 3.2, False, 3.6)
        berm(s, -5.0, 6.2, True, 3.4)
        crate(s, 2.6, -2.6)
        prop('cabinet', s, -1.6, 2.5, 0.0)
        fir(s, 13.2, -6.5, 7.0, seed=31 + s)
        fir(s, 14.6, -3.4, 6.0, seed=33 + s)
    both(per_side)


def station():
    """The research station: a west room and an east room either side of a hall that runs
    through the building, a door out of each end and each side of the hall, and windows."""
    def per_side(s):
        # built for the south half with world x and z multiplied by s
        X0, X1, Z0, Z1 = 18.0, 38.0, 9.0, 16.0
        t = 0.35
        H = CEIL_Y
        sx = lambda v: s * v
        # windows 1.4 wide at 1.1..2.1, doors 1.4 wide to 2.4
        win = lambda u: (u - 0.7, u + 0.7, 1.1, 2.1)
        door = lambda u: (u - 0.7, u + 0.7, 0.0, 2.4)
        # north and south walls run west to east (s = 1); u measured from x = 18
        for zc, inner in ((Z0, '+z'), (Z1, '-z')):
            holes = [win(3.0), win(6.0), door(10.0), win(14.0), win(17.0)]
            if s > 0:
                wall_holes(sx(X0), sx(zc), sx(X1), sx(zc), H, t, 'red', holes, inner)
            else:
                flip = {'+z': '-z', '-z': '+z'}[inner]
                wall_holes(sx(X0), sx(zc), sx(X1), sx(zc), H, t, 'red', holes, flip)
        # end walls run north to south; u measured from z = 9
        for xc, inner in ((X0, '+x'), (X1, '-x')):
            if s < 0:
                inner = {'+x': '-x', '-x': '+x'}[inner]
            wall_holes(sx(xc), sx(Z0 + t / 2), sx(xc), sx(Z1 - t / 2), H, t, 'red', [door(3.3)], inner)
        # the hall's walls, a doorway into each room
        for xc, inner in ((26.0, '+x'), (30.0, '-x')):
            if s < 0:
                inner = {'+x': '-x', '-x': '+x'}[inner]
            wall_holes(sx(xc), sx(Z0 + t / 2), sx(xc), sx(Z1 - t / 2), H, 0.2, 'lining', [door(3.3)], inner)
        xa, xb = sorted((sx(X0 - t / 2), sx(X1 + t / 2)))
        za, zb = sorted((sx(Z0 - t / 2), sx(Z1 + t / 2)))
        roof(xa, xb, za, zb, H)
        xa, xb = sorted((sx(X0), sx(X1)))
        za, zb = sorted((sx(Z0), sx(Z1)))
        flat('floor', xa, za, xb, zb, 0.004)
        # outside: a lamp over each door, a cabinet, an aircon unit, a dish on the far side
        for u in (10.0,):
            for zc, face in ((Z0, '-z'), (Z1, '+z')):
                f = face if s > 0 else {'-z': '+z', '+z': '-z'}[face]
                vbox('glow', Frame(sx(X0 + u), 2.75, sx(zc) + off(f, t / 2 + TRIM)[2]), 0, 0, 0, 0.3, 0.12, 0.02, skip=())
        face = '+z' if s > 0 else '-z'
        za_, zb_ = sorted((sx(Z1 - t / 2), sx(Z1 + t / 2)))
        xa_, xb_ = sorted((sx(X0), sx(X1)))
        L_, P_ = face_fn(face, xa_, xb_, za_, zb_, e=0.0)
        wall_unit(face, P_, 15.0 if s > 0 else 5.0)
        prop('cabinet', s, 22.0, Z0 - t / 2 - 0.22, math.pi)
        # inside, west room: a desk and shelving; east room: benches and a rack
        solid('steel', F(s, 20.2, 12.5, math.pi / 2), 0, 0.5, 0, 3.0, 1.0, 0.8)
        prop('shelves', s, 23.2, Z0 + t / 2 + 0.3, 0.0)
        prop('shelves', s, 24.5, Z0 + t / 2 + 0.3, 0.0)
        crate(s, 24.6, 14.9, 0.9, 0.9)
        solid('steel', F(s, 34.0, Z1 - t / 2 - 0.45), 0, 0.5, 0, 4.0, 1.0, 0.9)
        solid('steel', F(s, 36.9, 11.0), 0, 1.0, 0, 1.2, 2.0, 0.7)
        prop('drum', s, 31.0, 10.0, 0.4)
        # the hall: a bench
        solid('wood', F(s, 28.0, 12.5, math.pi / 2), 0, 0.25, 0, 1.6, 0.5, 0.5)
    both(per_side)


def tank_farm():
    def per_side(s):
        # the bund: gaps on the west side and the north side
        def bw(x0, z0, x1, z1):
            bund(s * x0, s * z0, s * x1, s * z1)
        bw(26.0, 21.5, 31.0, 21.5)
        bw(34.0, 21.5, 41.25, 21.5)
        bw(26.0, 32.5, 41.25, 32.5)
        bw(41.0, 21.75, 41.0, 32.25)
        bw(26.0, 21.75, 26.0, 25.0)
        bw(26.0, 28.0, 26.0, 32.25)
        tank(s, 30.5, 27.0, 1.7, 4.8, seed=41 + s)
        tank(s, 37.0, 25.5, 1.6, 4.6, seed=43 + s)
        tank(s, 37.2, 30.0, 1.3, 4.2, seed=45 + s)
        prop('drum', s, 33.5, 23.0, 0.2)
        lamp_post(s, 24.5, 26.5, math.pi / 2)
        dish(s, 20.0, 29.5, 0.6)
    both(per_side)


def motor_pool():
    """An open-fronted garage, facing the middle of the map, with a snowcat and a covered car."""
    def per_side(s):
        X0, X1, Z0, Z1 = -36.0, -22.0, 14.0, 24.0
        t = 0.35
        H = CEIL_Y
        sx = lambda v: s * v
        inner_back = '-z' if s > 0 else '+z'
        wall_holes(sx(X0 - t / 2), sx(Z1), sx(X1 + t / 2), sx(Z1), H, t, 'ochre', [], inner_back)
        for xc, inner in ((X0, '+x'), (X1, '-x')):
            if s < 0:
                inner = {'+x': '-x', '-x': '+x'}[inner]
            holes = [(5.0, 6.3, 0.0, 2.3)] if xc == X1 else []
            wall_holes(sx(xc), sx(Z0), sx(xc), sx(Z1 - t / 2), H, t, 'ochre', holes, inner)
        # posts across the open front
        for px in (-31.3, -26.7):
            solid('steel', F(s, px, Z0 + 0.15), 0, H / 2, 0, 0.3, H, 0.3)
        xa, xb = sorted((sx(X0 - t / 2), sx(X1 + t / 2)))
        za, zb = sorted((sx(Z0), sx(Z1 + t / 2)))
        roof(xa, xb, za, zb, H)
        # the rolled-up shutter boxes under the roof edge, out of reach
        for a, b in ((-36.0, -31.45), (-31.15, -26.85), (-26.55, -22.0)):
            vbox('rail', F(s, (a + b) / 2, Z0 + 0.35, 0.0, H - 0.25), 0, 0, 0, b - a - 0.1, 0.4, 0.45, skip=())
        xa, xb = sorted((sx(X0), sx(X1)))
        za, zb = sorted((sx(Z0), sx(Z1)))
        flat('floor', xa, za, xb, zb, 0.004)
        snowcat(s, -32.6, 19.2, 0.0)
        prop('snowcar', s, -25.2, 19.6, 0.05)
        prop('shelves', s, -29.0, Z1 - t / 2 - 0.3, math.pi)
        prop('shelves', s, -27.7, Z1 - t / 2 - 0.3, math.pi)
        solid('wood', F(s, -35.3, 20.0, math.pi / 2), 0, 0.5, 0, 3.0, 1.0, 0.9)
        prop('tyre', s, -35.4, 16.0, 0.0)
        prop('tyre', s, -35.3, 16.1, 0.6, y=0.165)
        prop('tyre', s, -35.4, 16.0, 1.1, y=0.33)
        # the yard in front: barriers, drums, a berm
        prop('barrier', s, -30.0, 8.8, 0.0)
        prop('barrier', s, -24.4, 6.4, 0.4)
        prop('drum', s, -35.2, 11.4, 0.3)
        prop('drum', s, -35.9, 10.7, 1.9)
        berm(s, -18.5, 8.0, False, 4.2)
        container(s, -41.2, 19.0, False, CONTAINERS[1])
        fir(s, -40.8, 8.5, 7.2, seed=51 + s)
        fir(s, -38.4, 29.0, 7.6, seed=53 + s)
        fir(s, -33.5, 30.5, 6.4, seed=55 + s)
        fir(s, -28.0, 29.2, 7.0, seed=57 + s)
        woodpile(s, -23.5, 30.5, True, 2.6)
    both(per_side)


def flank_middle():
    """The open ground between a station and the next garage along the same flank."""
    def per_side(s):
        dish(s, 34.5, 3.5, 2.4)
        container(s, 40.3, 5.0, False, CONTAINERS[2])
        prop('barrier', s, 22.0, 5.4, 1.57)
        prop('barrier', s, 27.5, 1.4, 0.2)
        berm(s, 17.4, 2.2, False, 4.0)
        crate(s, 29.8, 6.2)
        crate(s, 30.9, 6.6, 0.9, 0.9)
        fir(s, 21.5, -1.0, 6.2, seed=61 + s)
        lamp_post(s, 16.0, 12.0, math.pi / 2)
    both(per_side)


def backdrop():
    """Beyond the fence: the valley floor banked into drifts, fir forest climbing the slopes,
    and mountains all round. No colliders."""
    E = 0.5              # a strip of flat snow outside the fence before the drifts start

    def height(x, z):
        dx = max(0.0, abs(x) - (HX + 0.3 + E))
        dz = max(0.0, abs(z) - (HZ + 0.3 + E))
        d = math.hypot(dx, dz)
        if d <= 0:
            return 0.0
        # a drift banked against the fence, then the valley sides climbing into mountains
        drift = 1.6 * math.exp(-((d - 3.0) / 2.2) ** 2) if d < 9 else 0.0
        k = min(1.0, d / 170.0)
        k = k * k * (3 - 2 * k)
        n = (math.sin(x * 0.031 + 1.3) * math.cos(z * 0.027) + 0.7 * math.sin(x * 0.017 - z * 0.023 + 0.7)
             + 0.3 * math.sin(x * 0.07 + z * 0.05))
        return drift + k * (70.0 + 32.0 * n)

    def lines(edge):
        vs = list(range(-280, -100, 20)) + list(range(-100, 101, 8)) + list(range(120, 281, 20))
        return sorted([v for v in vs if abs(v) > edge + 3] + [-edge, edge, -(edge + 2.5), edge + 2.5, -(edge + 5.0), edge + 5.0])
    xs, zs = lines(HX + 1.5), lines(HZ + 1.5)
    for i in range(len(xs) - 1):
        for j in range(len(zs) - 1):
            x0, x1, z0, z1 = xs[i], xs[i + 1], zs[j], zs[j + 1]
            if max(abs(x0), abs(x1)) <= HX + 1.5 and max(abs(z0), abs(z1)) <= HZ + 1.5:
                continue
            a, b, c, d = height(x0, z1), height(x1, z1), height(x1, z0), height(x0, z0)
            poly('drift', Frame(), [(x0, a, z1), (x1, b, z1), (x1, c, z0)])
            poly('drift', Frame(), [(x0, a, z1), (x1, c, z0), (x0, d, z0)])
    rnd = rnd_gen(99)
    # fir forest on the lower slopes: simple two-tier cones, thinning out with height
    placed = 0
    tries = 0
    while placed < 170 and tries < 3000:
        tries += 1
        x = (rnd() * 2 - 1) * 150
        z = (rnd() * 2 - 1) * 130
        if abs(x) < HX + 9 and abs(z) < HZ + 9:
            continue
        y = height(x, z)
        if y > 32 or rnd() < y / 40:
            continue
        h = 7 + rnd() * 6
        fr = Frame(x, y - 0.3, z, rnd() * 6.28)
        r = h * 0.3
        for k, (y0, y1, rr) in enumerate(((0.8, h * 0.6, r), (h * 0.4, h, r * 0.66))):
            pts = ring(rr, 6)
            for i in range(6):
                j = (i + 1) % 6
                poly('fir', fr, [(pts[j][0], y0, pts[j][1]), (pts[i][0], y0, pts[i][1]), (0, y1, 0)],
                     SNOWY if (i + k) % 3 == 0 else NEEDLES)
        placed += 1
    # a radome on the ridge to the north-east, and its twin to the south-west
    for s in (1, -1):
        cx, cz = s * 70.0, s * -95.0
        base = height(cx, cz)
        fr = Frame(cx, base, cz)
        vcyl('far', fr, 0, 0, 7.0, -2, 4, n=16, top=False, tint=srgb(0xd9dde0))
        for k in range(6):
            a0, a1 = math.pi / 2 * k / 6, math.pi / 2 * (k + 1) / 6
            vcyl('far', fr, 0, 0, 7.4 * math.cos(a0), 4 + 7.4 * math.sin(a0), 4 + 7.4 * math.sin(a1), n=16,
                 r1=max(7.4 * math.cos(a1), 0.001), top=False, tint=srgb(0xeef0f2))


def build_layout():
    ground()
    perimeter()
    spawn_yard()
    approach()
    pond()
    station()
    tank_farm()
    motor_pool()
    flank_middle()
    backdrop()


result = run(build_layout)
