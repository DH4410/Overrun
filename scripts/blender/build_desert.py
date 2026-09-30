"""
DESERT: a walled desert town at midday, generated in Blender.

Run inside Blender 4.2+ (Scripting tab, or through the Blender MCP):

    OVERRUN_REPO = r"C:/path/to/repo"
    exec(open(OVERRUN_REPO + "/scripts/blender/build_desert.py").read())

It rebuilds the DESERT collection and writes assets/maps/desert.glb and desert.json. Run it with
plain Python instead and it only works out the collider tables (see mapkit.py, plan mode).

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
    'beam':    ((0.40, 0.30, 0.20), 1.5),     # visual timber: beam ends, lintels, well frames
    'cloth':   ((1.00, 1.00, 1.00), 1.0),     # awnings and banners, tinted, no collider
    'frond':   ((1.00, 1.00, 1.00), 1.0),     # palm leaves, tinted, no collider
    'trunk':   ((0.42, 0.34, 0.25), 1.0),
    'dark':    ((0.08, 0.06, 0.05), 1.0),     # window and doorway shadow, flush
    'water':   ((0.12, 0.16, 0.14), 1.0),
    'metal':   ((0.20, 0.20, 0.20), 1.0),     # lantern frames, no collider
    'lamp':    ((1.00, 0.80, 0.50), 1.0),     # emissive
    'dome':    ((0.85, 0.80, 0.72), 3.0),     # above the cistern roof, out of reach
    'far':     ((1.00, 1.00, 1.00), 8.0),     # backdrop beyond the wall, tinted
}
TINTED = {'cloth', 'frond', 'far'}
SMOOTH = {'dune'}

# Poly Haven models: (slug, max triangles, collider, approximate w/h/d for plan mode)
PROPS = {
    'barrel': ('wine_barrel_01', 1000, 'cyl', (0.76, 0.87, 0.76)),
    'chest':  ('wooden_crate_02', 800, 'box', (1.17, 0.46, 0.53)),
    'pot':    ('planter_pot_clay', 600, 'cyl', (0.27, 0.22, 0.26)),
    'car':    ('covered_car', 2500, 'box', (1.79, 1.41, 4.38)),
    'bucket': ('wooden_bucket_01', 600, None, (0.37, 0.55, 0.34)),
}

exec(open(os.path.join(globals()['OVERRUN_REPO'], 'scripts', 'blender', 'mapkit.py')).read())

TRIM = 0.003             # decoration stands this proud of a wall, so it adds nothing to walk into

CLOTHS = [srgb(h) for h in (0xa8322a, 0x2f5d8a, 0xc9a13a, 0x3f7a4a, 0x8b3f6e, 0xd9cdb4)]
GREENS = [srgb(h) for h in (0x4d6b2a, 0x5f7d33, 0x6b8a3a, 0x566f2c)]


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


def face_quad(key, P, t0, t1, y0, y1):
    poly(key, Frame(), [P(t0, y0), P(t1, y0), P(t1, y1), P(t0, y1)])


def off(face, d):
    return {'+z': (0, 0, d), '-z': (0, 0, -d), '+x': (d, 0, 0), '-x': (-d, 0, 0)}[face]


def shift(P, face, d=TRIM):
    """The same face function, d further out."""
    o = off(face, d)
    return lambda t, y: tuple(a + b for a, b in zip(P(t, y), o))


def house(x0, z0, x1, z1, h, key='plaster', faces='+x-x+z-z', vigas=False, seed=1, door=None):
    """A flat-roofed house: a solid block with a stone plinth, a coping band, shuttered windows
    and, with vigas, roof-beam ends along two sides. The collider is exactly the block."""
    xa, xb = sorted((x0, x1))
    za, zb = sorted((z0, z1))
    solid(key, Frame(), (xa + xb) / 2, h / 2, (za + zb) / 2, xb - xa, h, zb - za)
    rnd = rnd_gen(seed)
    for face in ('+x', '-x', '+z', '-z'):
        if face not in faces:
            continue
        L, P = face_fn(face, xa, xb, za, zb)
        face_quad('stone', P, 0, L, 0, 0.45)
        face_quad('stone' if key != 'lime' else 'plaster', P, 0, L, h - 0.3, h)
        rows = [2.3] + ([5.0] if h >= 6.8 else [])
        n = int(L // 3.4)
        for i in range(n):
            t = (i + 0.5) * L / n
            for y in rows:
                if rnd() < 0.3:
                    continue
                wdt = 0.7 + 0.2 * (rnd() < 0.5)
                face_quad('dark', P, t - wdt / 2, t + wdt / 2, y, y + 1.0)
                face_quad('beam', shift(P, face), t - wdt / 2 - 0.15, t + wdt / 2 + 0.15, y + 1.0, y + 1.14)
        if vigas and face in ('+z', '-z'):
            k = int(L // 1.1)
            for i in range(k):
                t = (i + 0.5) * L / k
                c = P(t, h - 0.62)
                o = off(face, 0.35)
                vbox('beam', Frame(c[0] + o[0], c[1], c[2] + o[2]), 0, 0, 0, 0.16, 0.16, 0.7)
    if door:
        face, t = door
        L, P = face_fn(face, xa, xb, za, zb)
        face_quad('stone', P, t - 0.85, t + 0.85, 0, 2.55)
        face_quad('wood', shift(P, face), t - 0.65, t + 0.65, 0, 2.35)


def arcade(x0, z0, x1, z1, h, t, key, n, pier, spring, seg=8, block_lintel=0):
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
    # piers
    for i in range(n + 1):
        u0 = -L / 2 + i * (pier + ow)
        solid(key, fr, u0 + pier / 2, h / 2, 0, pier, h, t, skip=('-y', '+y'))
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
            # the opening's stone surround, TRIM proud
            for k in range(seg):
                th0, th1 = math.pi * k / seg, math.pi * (k + 1) / seg
                p = []
                for th, rr in ((th0, r), (th1, r), (th1, r + 0.22), (th0, r + 0.22)):
                    p.append((a - rr * math.cos(th), spring + rr * math.sin(th), zf + side * TRIM))
                poly('stone', fr, p if side > 0 else p[::-1])
        # jambs up to the springing
        for sx in (-1, 1):
            u = a + sx * r
            quad = [(u, 0, -ht), (u, 0, ht), (u, spring, ht), (u, spring, -ht)]
            poly(key, fr, quad if sx > 0 else [quad[1], quad[0], quad[3], quad[2]])
    # plinth band on both faces
    for side in (1, -1):
        for i in range(n + 1):
            u0 = -L / 2 + i * (pier + ow)
            q = [(u0, 0, side * (ht + TRIM)), (u0 + pier, 0, side * (ht + TRIM)),
                 (u0 + pier, 0.45, side * (ht + TRIM)), (u0, 0.45, side * (ht + TRIM))]
            poly('stone', fr, q if side > 0 else [q[1], q[0], q[3], q[2]])


def slats(x0, z0, x1, z1, y, along_x, pitch=0.62, w=0.24, t=0.14):
    """Timber slats over a street: shade in stripes. Each slat is its own (non-blocking)
    collider, so a shot through a gap goes through."""
    xa, xb = sorted((x0, x1))
    za, zb = sorted((z0, z1))
    if along_x:        # slats run along X, spaced along Z
        n = int((zb - za) // pitch)
        for i in range(n):
            z = za + (i + 0.5) * (zb - za) / n
            solid('wood', Frame(), (xa + xb) / 2, y + t / 2, z, xb - xa, t, w, skip=(), block=0)
    else:
        n = int((xb - xa) // pitch)
        for i in range(n):
            x = xa + (i + 0.5) * (xb - xa) / n
            solid('wood', Frame(), x, y + t / 2, (za + zb) / 2, w, t, zb - za, skip=(), block=0)


def lantern(x, y, z, hang=0.6):
    """A hanging lantern: frame and glass only; the light itself is a lamp in mapDesert.js."""
    fr = Frame(x, y, z)
    vbox('metal', fr, 0, hang / 2, 0, 0.03, hang, 0.03, skip=())
    vbox('metal', fr, 0, 0.02, 0, 0.3, 0.05, 0.3, skip=())
    vbox('lamp', fr, 0, -0.2, 0, 0.22, 0.34, 0.22, skip=())
    vbox('metal', fr, 0, -0.4, 0, 0.26, 0.05, 0.26, skip=())


def palm(s, x, z, h=6.4, lean=0.0, seed=3):
    """A date palm. The trunk collides as a cylinder; the crown is out of reach."""
    fr = F(s, x, z)
    wx, _, wz = fr.world((0, 0, 0))
    CYLINDERS.append([round(wx, 4), round(h / 2, 4), round(wz, 4), 0.26, round(h, 4), 1])
    rnd = rnd_gen(seed)
    # the trunk in rings, each a little flared at its top like the old leaf bases
    y = 0.0
    while y < h - 0.3:
        r0 = 0.3 - 0.07 * y / h
        vcyl('trunk', fr, 0, 0, r0, y, y + 0.6, n=6, r1=r0 - 0.04, top=False)
        vcyl('trunk', fr, 0, 0, r0 + 0.02, y + 0.44, y + 0.6, n=6, top=False)
        y += 0.6
    vcyl('trunk', fr, 0, 0, 0.3, h - 0.3, h + 0.1, n=6, r1=0.18)
    nf = 14
    for i in range(nf):
        ang = 2 * math.pi * i / nf + rnd() * 0.3
        up = 0.35 - 0.9 * (i % 3) / 2 + rnd() * 0.15     # three tiers of droop
        L = 3.0 + rnd() * 0.8
        tint = GREENS[int(rnd() * len(GREENS))]
        tip = tuple(min(1.0, c * 1.25) for c in tint)
        pts = []
        for k in range(4):
            u = k / 3
            dist = L * u
            yy = h + math.sin(up) * dist - 1.6 * u * u
            wdt = 0.55 * math.sin(math.pi * min(1.0, u * 1.15 + 0.05))
            pts.append((dist, yy, wdt))
        ca, sa = math.cos(ang), math.sin(ang)
        for k in range(3):
            (d0, y0, w0), (d1, y1, w1) = pts[k], pts[k + 1]
            col = tint if k < 2 else tip
            for sgn in (1, -1):        # two leaf halves folded up along the midrib
                a0 = (d0 * ca - sgn * w0 * sa, y0 + w0 * 0.35, d0 * sa + sgn * w0 * ca)
                a1 = (d1 * ca - sgn * w1 * sa, y1 + w1 * 0.35, d1 * sa + sgn * w1 * ca)
                m0, m1 = (d0 * ca, y0, d0 * sa), (d1 * ca, y1, d1 * sa)
                q = [m0, m1, a1, a0] if sgn > 0 else [m1, m0, a0, a1]
                poly('frond', fr, q, col)


def stall(s, x, z, along_x=True, length=3.0, seed=5):
    """A market stall: a 1.0 m counter with goods, four poles and a cloth awning."""
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2)
    rnd = rnd_gen(seed)
    solid('wood', fr, 0, 0.5, 0, length, 1.0, 0.8)
    # poles stand on the ground just outside the counter
    for sx in (-1, 1):
        for sz, ph in ((1, 2.35), (-1, 2.7)):
            solid('wood', fr, sx * (length / 2 + 0.1), ph / 2, sz * 0.55, 0.09, ph, 0.09)
    tint = CLOTHS[int(rnd() * len(CLOTHS))]
    hw = length / 2 + 0.35
    q = [(-hw, 2.3, 1.0), (hw, 2.3, 1.0), (hw, 2.75, -0.8), (-hw, 2.75, -0.8)]
    poly('cloth', fr, q, tint)
    poly('cloth', fr, q[::-1], tuple(c * 0.7 for c in tint))
    # goods: small crates of produce on the counter
    for i in range(3):
        u = -length / 2 + (i + 0.5) * length / 3
        solid('wood', fr, u, 1.0 + 0.11, 0.05, 0.62, 0.22, 0.46, block=0)


def well(s, x, z):
    """A round stone well, 0.9 m: a hop up. The water sits 0.2 m below the rim."""
    fr = F(s, x, z)
    r, h = 1.15, 0.9
    x0, y0, z0 = fr.world((0, h / 2, 0))
    CYLINDERS.append([round(x0, 4), round(y0, 4), round(z0, 4), r, h, 1])
    vcyl('stone', fr, 0, 0, r, 0, h, n=16, top=False)
    outer, inner = ring(r, 16), ring(r - 0.22, 16)
    for i in range(16):
        j = (i + 1) % 16
        # the rim, facing up, and the inside of the shaft down to the water, facing in
        poly('stone', fr, [(inner[i][0], h, inner[i][1]), (inner[j][0], h, inner[j][1]),
                           (outer[j][0], h, outer[j][1]), (outer[i][0], h, outer[i][1])])
        poly('stone', fr, [(inner[i][0], h, inner[i][1]), (inner[i][0], h - 0.2, inner[i][1]),
                           (inner[j][0], h - 0.2, inner[j][1]), (inner[j][0], h, inner[j][1])])
    poly('water', fr, [(px, h - 0.2, pz) for px, pz in inner][::-1])
    # a timber frame over it, out of reach above the rim
    for sx in (-1, 1):
        solid('wood', fr, sx * (r - 0.11), h + 0.85, 0, 0.14, 1.7, 0.14)
    vbox('beam', fr, 0, h + 1.75, 0, 2 * r + 0.1, 0.14, 0.14, skip=())


def cistern():
    """The domed cistern in the middle of the square: breaks the sight line between the gates."""
    fr = Frame()
    S, H = 4.6, 3.4
    solid('stone', fr, 0, H / 2, 0, S, H, S)
    for sx in (-1, 1):
        for sz in (-1, 1):
            vbox('stone', fr, sx * (S / 2 - 0.25), H / 2, sz * (S / 2 - 0.25), 0.5 + 2 * TRIM, H, 0.5 + 2 * TRIM, skip=('-y', '+y'))
    for face in ('+x', '-x', '+z', '-z'):
        L, P = face_fn(face, -S / 2, S / 2, -S / 2, S / 2)
        face_quad('dark', P, L / 2 - 0.7, L / 2 + 0.7, 0.5, 2.3)
        face_quad('stone', P, 0, L, H - 0.35, H)
    # dome on a drum, out of reach
    vcyl('dome', fr, 0, 0, 1.9, H, H + 0.6, n=16, top=False)
    rings = 6
    for k in range(rings):
        a0, a1 = math.pi / 2 * k / rings, math.pi / 2 * (k + 1) / rings
        r0, r1 = 1.9 * math.cos(a0), 1.9 * math.cos(a1)
        y0, y1 = H + 0.6 + 1.9 * math.sin(a0), H + 0.6 + 1.9 * math.sin(a1)
        vcyl('dome', fr, 0, 0, r0, y0, y1, n=16, r1=max(r1, 0.001), top=False)
    vcyl('metal', fr, 0, 0, 0.06, H + 2.5, H + 3.3, n=6)


def low_wall(s, x, z, along_x, length, h=1.0, t=0.6, key='stone'):
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2)
    solid(key, fr, 0, h / 2, 0, length, h, t)


def trough(s, x, z, along_x=True):
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2)
    solid('stone', fr, 0, 0.35, 0, 2.4, 0.7, 0.8)
    # a hair above the stone, so the trough reads as brim-full
    poly('water', fr, [(-1.05, 0.704, 0.25), (1.05, 0.704, 0.25), (1.05, 0.704, -0.25), (-1.05, 0.704, -0.25)])


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


def perimeter():
    t = 1.5
    for sx in (-1, 1):
        wall(sx * (HX + t / 2), -HZ - t, sx * (HX + t / 2), HZ + t, WALL_H, t, 'mud', block=0)
    for sz in (-1, 1):
        wall(-HX - t, sz * (HZ + t / 2), HX + t, sz * (HZ + t / 2), WALL_H, t, 'mud', block=0)
    # merlons along the top, and a stone plinth band on the inner face
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
    # corner towers, outside the playable area
    for sx in (-1, 1):
        for sz in (-1, 1):
            vbox('mud', Frame(), sx * (HX + 3.45), 4.5, sz * (HZ + 3.45), 5.4, 9.0, 5.4)
            vbox('stone', Frame(), sx * (HX + 3.45), 9.15, sz * (HZ + 3.45), 5.8, 0.3, 5.8)
    # the town gate behind each spawn, shut: a stone arch and timber doors on the wall's face
    for s in (1, -1):
        L, P = face_fn('-z' if s > 0 else '+z', -HX, HX, s * HZ if s > 0 else -HZ - 1, s * HZ + 1 if s > 0 else -HZ)
        mid = L / 2
        face_quad('stone', P, mid - 3.2, mid + 3.2, 0, 4.6)
        face = '-z' if s > 0 else '+z'
        face_quad('wood', shift(P, face), mid - 2.6, mid + 2.6, 0, 4.0)
        face_quad('beam', shift(P, face, 2 * TRIM), mid - 0.06, mid + 0.06, 0, 4.0)
        # gatehouse above the gate, rising over the wall
        vbox('mud', Frame(), 0, 4.5, s * (HZ + 3.0), 9.0, 9.0, 4.5)
        vbox('stone', Frame(), 0, 9.15, s * (HZ + 3.0), 9.4, 0.3, 4.9)


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
        vcyl('far', Frame(), mx, mz, 1.6, 0, 24, n=12, tint=srgb(0xd8c3a0))
        vcyl('far', Frame(), mx, mz, 2.3, 24, 25.2, n=12, tint=srgb(0xc9b38e))
        vcyl('far', Frame(), mx, mz, 1.3, 25.2, 29, n=12, tint=srgb(0xd8c3a0))
        vcyl('far', Frame(), mx, mz, 1.35, 29, 32, n=12, r1=0.05, tint=srgb(0x8f7a5a))
        for k in range(9):
            bx = s * (-40 + k * 11 + rnd() * 4)
            bz = s * (HZ + 12 + rnd() * 10)
            h = 8 + rnd() * 5
            vbox('far', fr, bx, h / 2, bz, 8 + rnd() * 4, h, 7 + rnd() * 4, tint=srgb(0xc7a57c if k % 2 else 0xb8946a))
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


result = run(build_layout)
