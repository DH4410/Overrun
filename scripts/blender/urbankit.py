"""
The urban pieces shared by the newer Blender maps (build_depot.py, build_bastion.py,
build_arena.py): buildings with door and window holes, sandbags, crates, containers, lamp posts,
rubble, wrecks, dead trees. They are the pieces build_warzone.py grew, moved here so a map
does not copy 250 lines. build_warzone.py itself still carries its own copy.

exec() it after mapkit.py, in the map script's namespace. Colliders and meshes come out of the
same call, as everywhere else. The map defines the materials these pieces use (see
URBAN_MATERIALS for the keys and a starting set).
"""

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



URBAN_MATERIALS = {
    'ground':   ((0.45, 0.40, 0.33), 5.0),
    'outer':    ((0.45, 0.40, 0.33), 12.0),
    'road':     ((0.22, 0.22, 0.23), 4.0),
    'lines':    ((0.80, 0.75, 0.45), 1.0),
    'paving':   ((0.50, 0.47, 0.42), 3.0),
    'brick':    ((0.55, 0.30, 0.22), 3.0),
    'stucco':   ((0.70, 0.63, 0.50), 3.0),
    'cmu':      ((0.52, 0.52, 0.50), 3.0),
    'plaster':  ((0.75, 0.72, 0.64), 3.0),
    'concrete': ((0.50, 0.50, 0.48), 3.0),
    'floor':    ((0.38, 0.37, 0.35), 3.0),
    'roof':     ((0.40, 0.28, 0.24), 2.5),
    'rubble':   ((0.45, 0.42, 0.38), 2.0),
    'steel':    ((0.30, 0.31, 0.32), 1.5),
    'rail':     ((0.30, 0.31, 0.32), 1.5),
    'wood':     ((0.45, 0.35, 0.25), 1.5),
    'trunk':    ((0.30, 0.25, 0.20), 1.0),
    'container': ((1.00, 1.00, 1.00), 2.0),
    'paint':    ((1.00, 1.00, 1.00), 1.0),
    'sand':     ((1.00, 1.00, 1.00), 1.0),
    'dark':     ((0.04, 0.05, 0.06), 1.0),
    'glow':     ((1.00, 0.82, 0.55), 1.0),
    'far':      ((1.00, 1.00, 1.00), 12.0),
}
URBAN_TINTED = {'container', 'paint', 'sand', 'far'}
URBAN_PROPS = {
    'drum':      ('Barrel_01', 500, 'cyl', (0.56, 0.88, 0.56)),
    'barrier':   ('concrete_road_barrier', 500, 'box', (1.55, 0.84, 0.64)),
    'cabinet':   ('utility_box_02', 500, 'box', (0.92, 1.12, 0.43)),
    'car':       ('covered_car', 2000, 'box', (1.79, 1.41, 4.38)),
    'shelves':   ('steel_frame_shelves_01', 500, 'box', (1.10, 2.14, 0.50)),
    'tyre':      ('old_tyre', 300, None, (0.60, 0.17, 0.60)),
}
