"""
WARZONE: a ruined town on open ground, generated in Blender. The big map, for the endless
deathmatch (and plain DM / TDM when the group is large).

Run inside Blender 4.2+ (Scripting tab, or through the Blender MCP):

    OVERRUN_REPO = r"C:/path/to/repo"
    exec(open(OVERRUN_REPO + "/scripts/blender/build_warzone.py").read())

It rebuilds the WARZONE collection and writes assets/maps/warzone.glb and warzone.json. Run it with
plain Python instead and it only works out the collider tables (see mapkit.py, plan mode).

The layout, south half (the north half is the same turned half a turn):

    base            |x| < 16, z 36..50: a walled yard, two gaps in the front wall, a barracks
    boulevard       |x| < 5, z 14..36: wrecked cars and barriers between the base and the plaza
    plaza           |x| < 16, |z| < 11: a monument, planters, sandbags, a wrecked bus
    west district   x -66..-20: an apartment block, a row of shops, a roofless ruin, a warehouse
    east district   x 20..66: a roofless church, a fuel station, a factory, two houses

so every end of the map has the same mix, and a team starting at either base gets the same fight.

Heights, for movement: sandbags, planters, crates, rubble and low walls are 1.0 m or under (a
hop); everything a player should not climb is 2.5 m or more. Every roof you can stand under is at
4.0 m, which is CEIL_Y; roofless ruins are walled to 4.0 m at most.
"""
import math
import os

MAP = 'warzone'
HX, HZ = 70.0, 50.0      # playable half extents
WALL_H = 5.5             # the perimeter wall
CEIL_Y = 4.0             # underside of every roof

# key: (preview colour, metres per texture tile). src/mapWarzone.js picks the texture per key.
MATERIALS = {
    'ground':   ((0.45, 0.40, 0.33), 5.0),
    'outer':    ((0.45, 0.40, 0.33), 12.0),    # beyond the wall, no collider
    'road':     ((0.22, 0.22, 0.23), 4.0),     # asphalt: decal
    'lines':    ((0.80, 0.75, 0.45), 1.0),     # road paint: decal
    'paving':   ((0.50, 0.47, 0.42), 3.0),     # the plaza's cobbles: decal
    'brick':    ((0.55, 0.30, 0.22), 3.0),
    'stucco':   ((0.70, 0.63, 0.50), 3.0),
    'cmu':      ((0.52, 0.52, 0.50), 3.0),     # concrete block
    'plaster':  ((0.75, 0.72, 0.64), 3.0),     # inside walls
    'concrete': ((0.50, 0.50, 0.48), 3.0),
    'floor':    ((0.38, 0.37, 0.35), 3.0),     # indoor floors: decal
    'roof':     ((0.40, 0.28, 0.24), 2.5),
    'rubble':   ((0.45, 0.42, 0.38), 2.0),
    'steel':    ((0.30, 0.31, 0.32), 1.5),
    'rail':     ((0.30, 0.31, 0.32), 1.5),
    'wood':     ((0.45, 0.35, 0.25), 1.5),
    'trunk':    ((0.30, 0.25, 0.20), 1.0),
    'container': ((1.00, 1.00, 1.00), 2.0),    # tinted
    'paint':    ((1.00, 1.00, 1.00), 1.0),     # vehicles, signs, tinted
    'sand':     ((1.00, 1.00, 1.00), 1.0),     # sandbags, tinted
    'dark':     ((0.04, 0.05, 0.06), 1.0),
    'glow':     ((1.00, 0.82, 0.55), 1.0),
    'far':      ((1.00, 1.00, 1.00), 12.0),    # skyline and mountains, tinted
}
TINTED = {'container', 'paint', 'sand', 'far'}
SMOOTH = {'outer'}

PROPS = {
    'drum':      ('Barrel_01', 500, 'cyl', (0.56, 0.88, 0.56)),
    'barrier':   ('concrete_road_barrier', 500, 'box', (1.55, 0.84, 0.64)),
    'cabinet':   ('utility_box_02', 500, 'box', (0.92, 1.12, 0.43)),
    'car':       ('covered_car', 2000, 'box', (1.79, 1.41, 4.38)),
    'shelves':   ('steel_frame_shelves_01', 500, 'box', (1.10, 2.14, 0.50)),
    'tyre':      ('old_tyre', 300, None, (0.60, 0.17, 0.60)),
}

exec(open(os.path.join(globals()['OVERRUN_REPO'], 'scripts', 'blender', 'mapkit.py')).read())
crate_kit = crate

TRIM = 0.003

CONTAINERS = [srgb(h) for h in (0x2f5d8a, 0x3f6b3a, 0x9a3a2a, 0xb07a2a, 0x6b6b66)]
SANDBAG = srgb(0xb59f72)
VEHICLES = [srgb(h) for h in (0x4a5a3a, 0x6b6558, 0x8a7a4a, 0x57606a)]
SKYLINE = [srgb(h) for h in (0x9a948a, 0x8a857d, 0xa59f93, 0x77746e, 0x8f8a82)]
HILLS = [srgb(h) for h in (0x8a7a5e, 0x7d7058, 0x76705f)]
ROCK = srgb(0x8a8a86)
FLIP = {'+x': '-x', '-x': '+x', '+z': '-z', '-z': '+z'}


def rnd_gen(seed):
    state = [seed * 2654435761 % 2147483647 or 1]

    def rnd():
        state[0] = (state[0] * 1103515245 + 12345) & 0x7fffffff
        return state[0] / 0x7fffffff
    return rnd


# ------------------------------------------------------------------ pieces

def face_fn(face, xa, xb, za, zb, e=TRIM):
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
    cx, cz, w, d = (xa + xb) / 2, (za + zb) / 2, xb - xa, zb - za
    if top_key:
        vbox(key, Frame(), cx, (y0 + y1) / 2, cz, w, y1 - y0, d, skip=tuple(skip) + ('+y',))
        poly(top_key, Frame(), [(xa, y1, zb), (xb, y1, zb), (xb, y1, za), (xa, y1, za)])
    else:
        vbox(key, Frame(), cx, (y0 + y1) / 2, cz, w, y1 - y0, d, skip=skip)
    collider(Frame(), cx, (y0 + y1) / 2, cz, w, y1 - y0, d, block)


def wall_holes(x0, z0, x1, z1, h, t, key, holes, inner):
    """An axis-aligned wall with openings, holes = [(u0, u1, y0, y1)] along it from its start.
    Every piece collides. `inner` is the face that looks into the building and gets the lining."""
    along_x = abs(x1 - x0) > abs(z1 - z0)
    L = abs(x1 - x0) if along_x else abs(z1 - z0)
    sgn = 1 if (x1 - x0 if along_x else z1 - z0) > 0 else -1
    outer = FLIP[inner]

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
        face_quad('plaster', Pi, 0, Li, y0, y1)
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


def rect(s, xa, xb, za, zb):
    a, b = sorted((s * xa, s * xb))
    c, d = sorted((s * za, s * zb))
    return a, b, c, d


def bldg(s, xa, xb, za, zb, doors, key='brick', roofed=True, h=CEIL_Y, seed=1, wins=True, notches=0.15, pitch=3.6):
    """A building whose wall pieces all collide. `doors` = {'N': [u..], 'S': [..], 'W': [..], 'E': [..]},
    u measured along the wall from its west (N, S) or north (W, E) end, in the south-half
    frame. Windows fill the rest, some wide breaks in a roofless ruin's walls."""
    t = 0.35
    H = CEIL_Y if roofed else h
    rnd = rnd_gen(seed)

    def holes_for(L, dl):
        hs = [(u - 0.8, u + 0.8, 0.0, 2.3) for u in dl]
        if not wins:
            return hs
        u = 1.7
        while u < L - 1.4:
            if all(abs(u - d) > 2.0 for d in dl):
                r = rnd()
                if r < 0.18:
                    pass
                elif r < 0.18 + notches and not roofed:
                    hs.append((u - 1.0, u + 1.0, 0.9, H))
                elif H >= 2.6:
                    hs.append((u - 0.7, u + 0.7, 1.1, 2.1))
            u += pitch
        return hs

    for side, zc, inner in (('N', za, '+z'), ('S', zb, '-z')):
        inn = inner if s > 0 else FLIP[inner]
        wall_holes(s * xa, s * zc, s * xb, s * zc, H, t, key, holes_for(xb - xa, doors.get(side, [])), inn)
    for side, xc, inner in (('W', xa, '+x'), ('E', xb, '-x')):
        inn = inner if s > 0 else FLIP[inner]
        wall_holes(s * xc, s * (za + t / 2), s * xc, s * (zb - t / 2), H, t, key,
                   holes_for(zb - za - t, doors.get(side, [])), inn)
    if roofed:
        a, b, c, d = rect(s, xa - t / 2, xb + t / 2, za - t / 2, zb + t / 2)
        box_xz('roof', a, b, c, d, H, H + 0.3, skip=(), block=0)
    a, b, c, d = rect(s, xa, xb, za, zb)
    flat('floor', a, c, b, d, 0.004)


def partition(s, x0, z0, x1, z1, doors=(), h=CEIL_Y):
    """A thin inner wall from (x0, z0) to (x1, z1), a doorway at each u along it."""
    along_x = abs(x1 - x0) > abs(z1 - z0)
    inner = ('+z' if s > 0 else '-z') if along_x else ('+x' if s > 0 else '-x')
    wall_holes(s * x0, s * z0, s * x1, s * z1, h, 0.2, 'plaster', [(u - 0.8, u + 0.8, 0.0, 2.3) for u in doors], inner)


def sandbag(s, x, z, along_x=True, length=3.0, h=1.0, t=0.7):
    """Stacked sandbags, a hop high and cover from a crouch."""
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2)
    vbox('sand', fr, 0, h / 2, 0, length, h, t, tint=SANDBAG, skip=('-y',))
    collider(fr, 0, h / 2, 0, length, h, t)
    for k in range(1, 4):
        y = k * h / 4
        for sz in (-1, 1):
            vbox('dark', fr, 0, y, sz * (t / 2 + TRIM), length - 0.1, 0.03, 0.01, skip=())


def crate(s, x, z, size=1.2, h=1.0, base=0.0, yaw=0.0):
    crate_kit(s, x, z, size, h, base, 'wood', yaw)


def container(s, x, z, along_x, tint, h=2.59, stack=False):
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2)
    L, W = 6.06, 2.44
    vbox('container', fr, 0, h / 2, 0, L, h, W, tint=tint, skip=('-y',))
    collider(fr, 0, h / 2, 0, L, h, W)
    q = [(L / 2 + TRIM, 0.1, W / 2 - 0.08), (L / 2 + TRIM, 0.1, -W / 2 + 0.08),
         (L / 2 + TRIM, h - 0.1, -W / 2 + 0.08), (L / 2 + TRIM, h - 0.1, W / 2 - 0.08)]
    poly('container', fr, q, tuple(c * 0.8 for c in tint))
    for zz in (-0.75, -0.35, 0.35, 0.75):
        vbox('rail', fr, L / 2 + 0.03, h / 2, zz, 0.04, h - 0.3, 0.04)
    for sx in (-1, 1):
        for sz in (-1, 1):
            vbox('rail', fr, sx * (L / 2 - 0.06), h / 2, sz * (W / 2 - 0.06), 0.12 + 2 * TRIM, h, 0.12 + 2 * TRIM, skip=('-y', '+y'))
    for k in range(1, 12):
        x_ = -L / 2 + k * L / 12
        for sz in (-1, 1):
            vbox('rail', fr, x_, h / 2, sz * (W / 2 + 0.01), 0.05, h - 0.2, 0.02, skip=())


def lamp_post(s, x, z, yaw=0.0, h=4.4):
    fr = F(s, x, z, yaw)
    solid('steel', fr, 0, h / 2, 0, 0.14, h, 0.14)
    vbox('rail', fr, 0, h - 0.1, -0.55, 0.08, 0.08, 1.1, skip=())
    vbox('rail', fr, 0, h - 0.2, -1.1, 0.34, 0.14, 0.5, skip=())
    vbox('glow', fr, 0, h - 0.28, -1.1, 0.26, 0.02, 0.4, skip=())


def member(p0, p1, w, key, tint=WHITE):
    dx, dy, dz = p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]
    L = math.sqrt(dx * dx + dy * dy + dz * dz)
    ux, uy, uz = dx / L, dy / L, dz / L
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


def rubble(s, x, z, yaw=0.0, size=1.0, seed=1):
    """A pile of broken masonry a hop high: one box collider, lumpy chunks drawn over it."""
    fr = F(s, x, z, yaw)
    w, d, h = 2.8 * size, 1.9 * size, 0.85
    collider(fr, 0, h / 2, 0, w, h, d, prop=1)
    rnd = rnd_gen(seed)
    vbox('rubble', fr, 0, h / 2 - 0.05, 0, w - 0.2, h - 0.1, d - 0.2, skip=('-y', '+y'))
    for k in range(7):
        rx, rz = rnd() - 0.5, rnd() - 0.5
        cw, ch, cd = 0.5 + rnd() * 0.7, 0.2 + rnd() * 0.3, 0.4 + rnd() * 0.6
        reach = math.hypot(cw, cd) / 2          # a chunk turned any way stays over the collider
        cx, cz = rx * max(0.0, w - 0.2 - 2 * reach), rz * max(0.0, d - 0.2 - 2 * reach)
        yy = min(h - ch / 2, 0.3 + rnd() * 0.5)
        vbox('rubble', Frame(fr.o[0], fr.o[1], fr.o[2], fr.yaw + rnd() * 1.2), cx, yy, cz, cw, ch, cd, skip=('-y',))
    vbox('rubble', fr, 0, h - 0.02, 0, w - 0.3, 0.04, d - 0.3, skip=('-y',))


def wheel(fr, x, y, r, z0, z1, n=10):
    prism('dark', fr, [(x + r * math.cos(2 * math.pi * k / n), y + r * math.sin(2 * math.pi * k / n)) for k in range(n)], z0, z1)


def wreck(s, x, z, yaw, tint, L=4.4, W=1.9, H=1.45):
    """A burnt-out car: a side profile extruded across the width, dark windows, four wheels. The
    collider is the box round it: 1.45 m, cover from standing and a wall for a jump."""
    fr = F(s, x, z, yaw)
    collider(fr, 0, H / 2 + 0.15, 0, W, H - 0.3, L, prop=1)
    sf = Frame(fr.o[0], fr.o[1], fr.o[2], fr.yaw - math.pi / 2)
    k = L / 4.4
    prof = [(-2.2 * k, 0.3), (2.2 * k, 0.3), (2.25 * k, 0.8), (1.5 * k, 0.95), (0.7 * k, 1.45),
            (-0.9 * k, 1.45), (-1.6 * k, 1.0), (-2.2 * k, 0.95)]
    hw = W / 2 - 0.05
    prism('paint', sf, prof, -hw, hw, tint)
    win = [(-0.85 * k, 1.0), (0.75 * k, 1.0), (0.5 * k, 1.38), (-0.7 * k, 1.38)]
    poly('dark', sf, [(x_, y_, hw + TRIM) for x_, y_ in win])
    poly('dark', sf, [(x_, y_, -hw - TRIM) for x_, y_ in reversed(win)])
    for wx in (-1.4 * k, 1.35 * k):
        wheel(sf, wx, 0.33, 0.33, hw - 0.02, hw + 0.12)
        wheel(sf, wx, 0.33, 0.33, -hw - 0.12, -hw + 0.02)


def bus(s, x, z, yaw, tint):
    fr = F(s, x, z, yaw)
    L, W, H = 10.5, 2.5, 2.9
    collider(fr, 0, H / 2 + 0.2, 0, W, H - 0.4, L, prop=1)
    sf = Frame(fr.o[0], fr.o[1], fr.o[2], fr.yaw - math.pi / 2)
    hl = L / 2
    prof = [(-hl, 0.45), (hl, 0.45), (hl, 2.2), (hl - 0.5, H), (-hl, H)]
    hw = W / 2 - 0.02
    prism('paint', sf, prof, -hw, hw, tint)
    for side in (1, -1):
        z_ = side * (hw + TRIM)
        for k in range(8):
            x0 = -hl + 0.8 + k * 1.15
            q = [(x0, 1.6), (x0 + 0.95, 1.6), (x0 + 0.95, 2.55), (x0, 2.55)]
            poly('dark', sf, [(x_, y_, z_) for x_, y_ in (q if side > 0 else q[::-1])])
    for wx in (-3.3, 3.2):
        wheel(sf, wx, 0.5, 0.5, hw - 0.02, hw + 0.2, 12)
        wheel(sf, wx, 0.5, 0.5, -hw - 0.2, -hw + 0.02, 12)


def dead_tree(s, x, z, seed=1, h=5.0):
    fr = F(s, x, z)
    wx, _, wz = fr.world((0, 0, 0))
    CYLINDERS.append([round(wx, 4), round(h / 2, 4), round(wz, 4), 0.4, round(h, 4), 1, 1])
    rnd = rnd_gen(seed)
    vcyl('trunk', fr, 0, 0, 0.24, 0, h, n=6, r1=0.1, top=False)
    for k in range(5):
        a = rnd() * 6.28
        y0 = h * (0.45 + 0.12 * k)
        L = 1.0 + rnd() * 0.9
        p0 = fr.world((0, y0, 0))
        p1 = fr.world((math.cos(a) * L, y0 + 0.6 + rnd() * 0.6, math.sin(a) * L))
        member(p0, p1, 0.08, 'trunk')


def barrel_cluster(s, x, z, seed=1):
    rnd = rnd_gen(seed)
    for k in range(3):
        prop('drum', s, x + (rnd() - 0.5) * 1.6, z + (rnd() - 0.5) * 1.6, rnd() * 6.28)


# ------------------------------------------------------------------ layout

def ground():
    GX, GZ = HX + 1.5, HZ + 1.5
    poly('ground', Frame(), [(-GX, 0, GZ), (GX, 0, GZ), (GX, 0, -GZ), (-GX, 0, -GZ)])
    collider(Frame(), 0, -0.5, 0, 2 * HX + 3, 1.0, 2 * HZ + 3, block=0)
    # plaza
    flat('paving', -16, -11, 16, 11, 0.006)
    for s in (1, -1):
        # the boulevard from the base gate to the plaza, and the avenue to each district
        flat('road', s * -5, s * 11, s * 5, s * HZ, 0.005)
        flat('road', s * 16, s * -3.5, s * 66, s * 4.5, 0.005)
        # centre line of the boulevard, dashed
        k = 12.0
        while k < 35.0:
            flat('lines', s * -0.12, s * k, s * 0.12, s * (k + 1.8), 0.008)
            k += 3.6
        k = 18.0
        while k < 66.0:
            flat('lines', s * k, s * 0.4, s * (k + 1.8), s * 0.64, 0.008)
            k += 3.6


def perimeter():
    t = 0.5
    for sx in (-1, 1):
        wall(sx * (HX + t / 2), -HZ - t, sx * (HX + t / 2), HZ + t, WALL_H, t, 'cmu', block=0)
    for sz in (-1, 1):
        wall(-HX - t, sz * (HZ + t / 2), HX + t, sz * (HZ + t / 2), WALL_H, t, 'cmu', block=0)
    for face, (xa, xb, za, zb) in (('+x', (-HX - t, -HX, -HZ, HZ)), ('-x', (HX, HX + t, -HZ, HZ)),
                                   ('+z', (-HX, HX, -HZ - t, -HZ)), ('-z', (-HX, HX, HZ, HZ + t))):
        L, P = face_fn(face, xa, xb, za, zb)
        face_quad('concrete', P, 0, L, 0, 0.6)
        k = 0.0
        while k <= L + 0.01:
            c = P(min(k, L), 0)
            o = {'+z': (0, 0, 0.1), '-z': (0, 0, -0.1), '+x': (0.1, 0, 0), '-x': (-0.1, 0, 0)}[face]
            vbox('concrete', Frame(c[0] + o[0], 0, c[2] + o[2]), 0, WALL_H / 2, 0, 0.5, WALL_H, 0.5)
            k += 9.0
        # razor wire on the top: three taut lines
        for d, y in ((0.0, WALL_H + 0.25), (0.12, WALL_H + 0.45)):
            a, b = P(0, y), P(L, y)
            o = {'+z': (0, 0, d), '-z': (0, 0, -d), '+x': (d, 0, 0), '-x': (-d, 0, 0)}[face]
            member((a[0] + o[0], y, a[2] + o[2]), (b[0] + o[0], y, b[2] + o[2]), 0.03, 'rail')


def base():
    def per_side(s):
        # the yard: a front wall with two gaps, and a door-sized gap in each side wall
        for x0, x1 in ((-16, -9), (-5, 5), (9, 16)):
            wall(s * x0, s * 36.0, s * x1, s * 36.0, 2.8, 0.5, 'cmu', top_key='concrete')
        for sx in (-1, 1):
            wall(s * sx * 16.0, s * 36.25, s * sx * 16.0, s * 39.5, 2.8, 0.5, 'cmu', top_key='concrete')
            wall(s * sx * 16.0, s * 43.5, s * sx * 16.0, s * 50.0, 2.8, 0.5, 'cmu', top_key='concrete')
        sandbag(s, -7.0, 34.2, True, 3.0)
        sandbag(s, 7.0, 34.2, True, 3.0)
        sandbag(s, -12.5, 33.0, False, 2.4)
        sandbag(s, 12.5, 33.0, False, 2.4)
        # barracks in the west corner, door facing the yard
        bldg(s, -14.0, -6.0, 40.0, 49.0, {'N': [3.5], 'E': [5.5]}, 'stucco', True, seed=5)
        partition(s, -14.0, 44.5, -6.0, 44.5, [5.0])
        for k in range(3):
            solid('steel', F(s, -13.0, 41.5 + k * 1.7), 0, 0.5, 0, 0.9, 1.0, 1.7)
        container(s, 10.0, 45.0, True, CONTAINERS[0])
        container(s, 4.0, 48.8, True, CONTAINERS[3])
        crate(s, 14.2, 40.0, 1.2, 1.0)
        crate(s, 14.3, 41.3, 1.0, 1.0)
        crate(s, 14.2, 40.2, 0.9, 0.9, base=1.0, yaw=0.3)
        crate(s, 0.0, 41.5, 1.2, 1.0, yaw=0.2)
        barrel_cluster(s, 12.0, 38.5, 3)
        prop('barrier', s, -3.5, 38.5, 0.0)
        prop('barrier', s, 3.5, 38.5, 0.0)
        lamp_post(s, -4.0, 37.2, 0.0)
        lamp_post(s, 4.0, 37.2, 0.0)
        lamp_post(s, 12.5, 47.0, math.pi / 2)
        dead_tree(s, -3.0, 47.0, 21 + s, 4.6)
    both(per_side)


def boulevard():
    def per_side(s):
        wreck(s, -2.6, 31.0, 0.08, VEHICLES[0])
        wreck(s, 2.8, 25.0, -0.15, VEHICLES[1])
        wreck(s, -3.0, 18.0, 3.0, VEHICLES[2])
        prop('barrier', s, -4.2, 21.4, 0.1)
        prop('barrier', s, 0.4, 21.8, 0.05)
        prop('barrier', s, 4.0, 21.4, -0.1)
        rubble(s, 3.4, 33.0, 0.5, 0.9, 1 + s)
        rubble(s, -3.6, 27.0, 0.3, 0.8, 4 + s)
        lamp_post(s, -6.4, 30.0, -math.pi / 2)
        lamp_post(s, 6.4, 22.0, math.pi / 2)
        dead_tree(s, 7.5, 33.0, 31 + s, 5.2)
        dead_tree(s, -7.5, 17.0, 33 + s, 4.4)
    both(per_side)


def plaza():
    # the monument: a stepped plinth and an obelisk
    box_xz('concrete', -3.2, 3.2, -3.2, 3.2, 0, 0.5, skip=('-y',))
    box_xz('stucco', -2.0, 2.0, -2.0, 2.0, 0.5, 1.0, skip=('-y',))
    solid('stucco', Frame(), 0, 3.6, 0, 1.3, 5.2, 1.3)
    vbox('concrete', Frame(), 0, 6.3, 0, 1.0, 0.3, 1.0, skip=('-y',))
    vbox('concrete', Frame(), 0, 6.6, 0, 0.6, 0.3, 0.6, skip=('-y',))

    def per_side(s):
        # planters: stone troughs along the plaza's long edges
        box_xz('concrete', *rect(s, 6.0, 12.0, 8.0, 9.2), 0, 1.0, skip=('-y',))
        box_xz('concrete', *rect(s, -12.0, -6.0, 8.0, 9.2), 0, 1.0, skip=('-y',))
        for px in (9.0, -9.0):
            vbox('trunk', F(s, px, 8.6), 0, 1.02, 0, 4.8, 0.04, 0.8, skip=('-y',))
        bus(s, -12.0, 1.0, math.pi / 2, VEHICLES[3])
        sandbag(s, 8.0, 4.0, True, 3.2)
        sandbag(s, 13.0, -2.5, False, 2.4)
        rubble(s, 12.5, 6.0, 0.4, 0.8, 11 + s)
        wreck(s, 6.5, -5.5, 1.3, VEHICLES[0])
        lamp_post(s, 14.5, 9.5, math.pi)
        lamp_post(s, -14.5, 9.5, math.pi)
        dead_tree(s, 15.0, 7.0, 41 + s, 4.8)
    both(per_side)


def west_district():
    def per_side(s):
        # W1: apartment block, two rooms on a corridor
        bldg(s, -62.0, -46.0, 8.0, 20.0, {'E': [3.5, 8.0], 'S': [4.0, 11.0]}, 'brick', True, seed=7)
        partition(s, -62.0, 14.0, -46.0, 14.0, [4.0, 12.0])
        partition(s, -54.0, 8.0, -54.0, 14.0, [3.0])
        solid('wood', F(s, -60.0, 10.0), 0, 0.5, 0, 2.0, 1.0, 0.9)
        solid('steel', F(s, -57.0, 18.8), 0, 0.5, 0, 3.0, 1.0, 0.9)
        crate(s, -48.0, 18.0, 1.0, 1.0)
        prop('shelves', s, -61.4, 16.5, math.pi / 2)
        # W2: a row of three shops, doors on the street side
        bldg(s, -42.0, -24.0, 8.0, 16.0, {'S': [3.0, 9.0, 15.0]}, 'stucco', True, seed=9)
        partition(s, -36.0, 8.0, -36.0, 16.0, [])
        partition(s, -30.0, 8.0, -30.0, 16.0, [])
        for cx in (-39.0, -33.0, -27.0):
            solid('wood', F(s, cx, 9.2), 0, 0.5, 0, 3.2, 1.0, 0.7)
        # W3: a roofless ruin
        bldg(s, -62.0, -50.0, 26.0, 36.0, {'E': [4.0, 8.0], 'N': [3.0]}, 'brick', False, h=3.6, seed=13)
        rubble(s, -54.5, 31.0, 0.7, 0.9, 21 + s)
        rubble(s, -48.0, 28.0, 0.2, 1.0, 23 + s)
        # W4: warehouse, wide loading doors
        bldg(s, -44.0, -26.0, 22.0, 34.0, {'N': [5.0, 13.0], 'S': [9.0], 'E': [6.0]}, 'cmu', True, seed=17, pitch=6.0)
        for cx in (-38.0, -32.0):
            for cz in (26.0, 30.5):
                solid('steel', F(s, cx, cz), 0, 2.0, 0, 0.5, 4.0, 0.5)
        crate(s, -41.5, 32.0, 1.4, 1.0)
        crate(s, -41.5, 30.5, 1.0, 1.0)
        crate(s, -41.4, 32.1, 0.9, 0.9, base=1.0, yaw=0.4)
        solid('wood', F(s, -34.5, 33.0), 0, 0.5, 0, 6.0, 1.0, 1.2)
        prop('shelves', s, -28.0, 28.0, -math.pi / 2)
        prop('shelves', s, -28.0, 29.2, -math.pi / 2)
        # the open ground between the district and the boulevard
        container(s, -17.0, 14.0, True, CONTAINERS[1])
        container(s, -12.0, 24.0, False, CONTAINERS[2])
        wreck(s, -21.0, 28.0, 1.4, VEHICLES[2])
        rubble(s, -22.0, 18.0, 0.6, 1.0, 31 + s)
        sandbag(s, -17.0, 6.0, True, 3.4)
        barrel_cluster(s, -46.0, 3.0, 5)
        lamp_post(s, -45.0, 21.0, 0.0)
        dead_tree(s, -66.0, 22.0, 51 + s, 5.0)
        dead_tree(s, -23.0, 38.0, 53 + s, 4.2)
        dead_tree(s, -58.0, 41.0, 55 + s, 5.4)
        wreck(s, -28.0, 2.5, 0.2, VEHICLES[3])
        sandbag(s, -40.0, 3.5, True, 3.2)
        rubble(s, -52.0, 1.0, 0.5, 1.0, 91 + s)
        container(s, -60.0, 3.5, True, CONTAINERS[1])
        wreck(s, -46.0, -3.5, 1.1, VEHICLES[0])
        container(s, -52.0, 44.0, True, CONTAINERS[4])
        rubble(s, -40.0, 40.0, 0.3, 1.1, 41 + s)
    both(per_side)


def east_district():
    def per_side(s):
        # E1: a roofless hall with a row of columns down the middle
        bldg(s, 22.0, 36.0, 8.0, 22.0, {'S': [7.0], 'W': [7.0]}, 'brick', False, h=4.0, seed=21, notches=0.3)
        for cz in (11.5, 15.0, 18.5):
            for cx in (27.0, 31.0):
                solid('concrete', F(s, cx, cz), 0, 2.0, 0, 0.7, 4.0, 0.7)
        rubble(s, 24.5, 20.0, 0.4, 0.9, 61 + s)
        rubble(s, 34.0, 10.5, 1.0, 0.9, 63 + s)
        # E2: the fuel station, a canopy on four posts and a kiosk
        for px in (43.0, 53.0):
            for pz in (11.0, 17.0):
                solid('steel', F(s, px, pz), 0, CEIL_Y / 2, 0, 0.5, CEIL_Y, 0.5)
        a, b, c, d = rect(s, 41.5, 54.5, 9.5, 18.5)
        box_xz('roof', a, b, c, d, CEIL_Y, CEIL_Y + 0.3, skip=(), block=0)
        a, b, c, d = rect(s, 41.5, 54.5, 9.5, 18.5)
        flat('floor', a, c, b, d, 0.004)
        for px in (46.0, 50.0):
            solid('steel', F(s, px, 14.0), 0, 0.65, 0, 0.9, 1.3, 0.6)
            vbox('glow', F(s, px, 14.0), 0, 1.0, 0.31, 0.5, 0.3, 0.02, skip=())
        bldg(s, 57.0, 64.0, 8.0, 15.0, {'W': [3.5]}, 'cmu', True, seed=25)
        wreck(s, 47.0, 22.0, 0.6, VEHICLES[1])
        # E3: the factory
        bldg(s, 40.0, 64.0, 24.0, 34.0, {'N': [4.0, 12.0, 20.0], 'S': [8.0, 16.0], 'W': [5.0]}, 'cmu', True, seed=29, pitch=6.0)
        partition(s, 52.0, 24.0, 52.0, 34.0, [5.0])
        solid('steel', F(s, 44.0, 28.0), 0, 1.0, 0, 3.0, 2.0, 1.6)
        solid('steel', F(s, 47.5, 31.5), 0, 0.7, 0, 2.0, 1.4, 1.2)
        solid('steel', F(s, 58.0, 29.0), 0, 1.0, 0, 2.5, 2.0, 2.0)
        solid('steel', F(s, 62.5, 32.5), 0, 0.5, 0, 1.4, 1.0, 1.4)
        crate(s, 55.5, 26.0, 1.2, 1.0)
        crate(s, 56.9, 26.2, 1.0, 1.0)
        prop('shelves', s, 63.4, 28.0, -math.pi / 2)
        # E4: two houses
        bldg(s, 22.0, 30.0, 26.0, 34.0, {'N': [3.5], 'W': [4.0]}, 'stucco', True, seed=33)
        bldg(s, 33.0, 37.0, 28.0, 33.0, {'W': [2.5]}, 'brick', True, seed=35)
        solid('wood', F(s, 26.0, 31.8), 0, 0.5, 0, 2.4, 1.0, 0.9)
        # the ground between
        wreck(s, 30.0, 2.5, -0.3, VEHICLES[2])
        sandbag(s, 52.0, -3.0, True, 3.2)
        rubble(s, 60.0, 2.0, 0.7, 1.0, 93 + s)
        container(s, 44.0, -6.0, True, CONTAINERS[3])
        container(s, 18.5, 14.0, False, CONTAINERS[0])
        container(s, 38.0, 40.0, True, CONTAINERS[3])
        container(s, 38.0, 42.5, True, CONTAINERS[2])
        wreck(s, 24.0, 40.5, 0.4, VEHICLES[0])
        sandbag(s, 20.1, 26.0, False, 2.6)
        sandbag(s, 40.0, 5.0, True, 3.2)
        sandbag(s, 60.0, 20.0, True, 3.2)
        rubble(s, 46.0, 28.5, 0.3, 0.8, 71 + s)
        rubble(s, 64.5, 40.0, 0.9, 1.1, 73 + s)
        rubble(s, 28.0, 4.5, 0.2, 1.0, 75 + s)
        barrel_cluster(s, 56.0, 21.0, 8)
        barrel_cluster(s, 24.0, 22.5, 9)
        lamp_post(s, 40.0, 20.5, 0.0)
        lamp_post(s, 66.0, 22.0, math.pi / 2)
        dead_tree(s, 66.0, 6.0, 81 + s, 5.2)
        dead_tree(s, 48.0, 46.0, 83 + s, 4.6)
        dead_tree(s, 28.0, 46.0, 85 + s, 5.0)
        dead_tree(s, 62.0, 46.0, 87 + s, 4.2)
    both(per_side)


def backdrop():
    """Beyond the wall: dry fields rolling up into hills, a broken skyline, mountains all round.
    No colliders."""
    E = 0.5

    def height(x, z):
        dx = max(0.0, abs(x) - (HX + 0.5 + E))
        dz = max(0.0, abs(z) - (HZ + 0.5 + E))
        d = math.hypot(dx, dz)
        if d <= 0:
            return 0.0
        k = min(1.0, d / 220.0)
        k = k * k * (3 - 2 * k)
        n = (math.sin(x * 0.021 + 1.3) * math.cos(z * 0.019) + 0.6 * math.sin(x * 0.012 - z * 0.017 + 0.7)
             + 0.25 * math.sin(x * 0.06 + z * 0.045))
        return k * (60.0 + 36.0 * n) + 0.8 * math.sin(d * 0.12) * min(1.0, d / 20.0)

    def lines(edge):
        vs = list(range(-340, -120, 24)) + list(range(-120, 121, 10)) + list(range(144, 341, 24))
        return sorted([v for v in vs if abs(v) > edge + 3] + [-edge, edge, -(edge + 2.5), edge + 2.5, -(edge + 6.0), edge + 6.0])
    xs, zs = lines(HX + 1.5), lines(HZ + 1.5)
    for i in range(len(xs) - 1):
        for j in range(len(zs) - 1):
            x0, x1, z0, z1 = xs[i], xs[i + 1], zs[j], zs[j + 1]
            if max(abs(x0), abs(x1)) <= HX + 1.5 and max(abs(z0), abs(z1)) <= HZ + 1.5:
                continue
            a, b, c, d = height(x0, z1), height(x1, z1), height(x1, z0), height(x0, z0)
            poly('outer', Frame(), [(x0, a, z1), (x1, b, z1), (x1, c, z0)])
            poly('outer', Frame(), [(x0, a, z1), (x1, c, z0), (x0, d, z0)])
    rnd = rnd_gen(77)
    # a broken skyline: the town carries on past the wall as shells of towers and blocks
    for k in range(64):
        ang = rnd() * math.tau
        dist = 14 + rnd() * 42
        x = math.cos(ang) * (HX + dist)
        z = math.sin(ang) * (HZ + dist)
        if abs(x) < HX + 8 and abs(z) < HZ + 8:
            continue
        w, d, h = 7 + rnd() * 10, 7 + rnd() * 8, 7 + rnd() * 16
        base = height(x, z)
        fr = Frame(x, base - 0.5, z, rnd() * 3.14)
        tint = SKYLINE[int(rnd() * len(SKYLINE))]
        vbox('far', fr, 0, h / 2, 0, w, h, d, tint=tint, skip=('-y',))
        # a snapped upper storey, set back and off-centre
        vbox('far', fr, (rnd() - 0.5) * 2, h + 1.5, (rnd() - 0.5) * 2, w * 0.6, 3.0 + rnd() * 2, d * 0.6,
             tint=tuple(c * 0.9 for c in tint), skip=('-y',))
        # window grid on the four faces: dark panes in rows, a few missing
        for face_sign in (1, -1):
            for axis in (0, 1):
                span = w if axis == 0 else d
                n = max(2, int(span // 2.6))
                for r_ in range(max(1, int(h // 3.2))):
                    for c_ in range(n):
                        if rnd() < 0.22:
                            continue
                        u = -span / 2 + (c_ + 0.5) * span / n
                        y = 1.4 + r_ * 3.2
                        if axis == 0:
                            Z = face_sign * (d / 2 + 0.02)
                            q = [(u - 0.55, y, Z), (u + 0.55, y, Z), (u + 0.55, y + 1.5, Z), (u - 0.55, y + 1.5, Z)]
                            poly('dark', fr, q if face_sign > 0 else q[::-1])
                        else:
                            X = face_sign * (w / 2 + 0.02)
                            q = [(X, y, u + 0.55), (X, y, u - 0.55), (X, y + 1.5, u - 0.55), (X, y + 1.5, u + 0.55)]
                            poly('dark', fr, q if face_sign > 0 else q[::-1])
    # foothills banked beyond the town: two-tier mounds
    for k in range(10):
        ang = k / 10 * math.tau + rnd() * 0.3
        dist = 150 + rnd() * 60
        x, z = math.cos(ang) * dist * 1.25, math.sin(ang) * dist
        hgt, r = 30 + rnd() * 26, 40 + rnd() * 30
        fr = Frame(x, height(x, z) - 6, z, rnd() * 6)
        tint = HILLS[k % len(HILLS)] if rnd() < 0.7 else ROCK
        vcyl('far', fr, 0, 0, r, 0, hgt * 0.6, n=9, r1=r * 0.6, top=False, tint=tint)
        vcyl('far', fr, 0, 0, r * 0.6, hgt * 0.6, hgt, n=9, r1=r * 0.12, tint=tuple(c * 1.06 for c in tint))


def build_layout():
    ground()
    perimeter()
    base()
    boulevard()
    plaza()
    west_district()
    east_district()
    backdrop()


result = run(build_layout)
