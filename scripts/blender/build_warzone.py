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

Detail pass: rounded edges, smooth normals and wear (roundkit_dh.py), and a detail layer that has
no collider: plinths, cornices, quoins, lintels and sills, parapets and roof clutter on the
buildings; stacked bags, turned lamp posts, limbed trees, tyred and filleted vehicles. Every
collider is emitted exactly as before, so warzone.json (and the map hash) does not change.
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
    # Detail with no collider: neither is in the ghost probe's touch list.
    'trim':     ((0.66, 0.64, 0.59), 3.0),     # plinths, cornices, lintels, sills, copings
    'tyre':     ((0.03, 0.03, 0.035), 1.0),    # rubber
    # The detail pass (warzonedetail.py): per-piece colour, no collider, none in the ghost probe's list.
    'fit':      ((0.35, 0.37, 0.40), 1.0),     # hardware: frames, boards, plates, rubble, aerials
    'mark':     ((1.00, 1.00, 1.00), 1.0),     # paint, stains, pocks, cracks: decals
    'glyph':    ((1.00, 1.00, 1.00), 1.0),     # lit decals: unlit
    'tmark':    ((1.00, 1.00, 1.00), 1.0),     # sign text, a quad per character
    'tglyph':   ((1.00, 1.00, 1.00), 1.0),
}
TINTED = {'container', 'paint', 'sand', 'far', 'fit', 'mark', 'glyph', 'tmark', 'tglyph'}
SMOOTH = {'outer'}

PROPS = {
    'drum':      ('Barrel_01', 500, 'cyl', (0.56, 0.88, 0.56)),
    'barrier':   ('concrete_road_barrier', 500, 'box', (1.55, 0.84, 0.64)),
    'cabinet':   ('utility_box_02', 500, 'box', (0.92, 1.12, 0.43)),
    'car':       ('covered_car', 2000, 'box', (1.79, 1.41, 4.38)),
    'shelves':   ('steel_frame_shelves_01', 500, 'box', (1.10, 2.14, 0.50)),
    'tyre':      ('old_tyre', 300, None, (0.60, 0.17, 0.60)),
}

# Rounded edges, smooth normals and wear (roundkit_dh.py). Nothing in it emits a collider.
RK_ROUND = {'brick': 0.05, 'stucco': 0.05, 'cmu': 0.06, 'plaster': 0.03, 'concrete': 0.07, 'roof': 0.05,
            'rubble': 0.07, 'steel': 0.05, 'wood': 0.05, 'trim': 0.04, 'container': 0.05, 'paint': 0.05,
            'rail': 0.02, 'trunk': 0.03}
RK_ROUND_DEFAULT = 0.04
RK_CELL = 6.0
RK_PLAIN = {'ground', 'outer', 'road', 'lines', 'paving', 'floor', 'dark', 'glow', 'far',
            'fit', 'mark', 'glyph', 'tmark', 'tglyph'}
RK_WEAR = {'brick': (0.34, 0.18, True), 'stucco': (0.30, 0.16, True), 'cmu': (0.30, 0.14, True),
           'plaster': (0.20, 0.10), 'concrete': (0.30, 0.14), 'roof': (0.14, 0.20), 'rubble': (0.10, 0.16),
           'steel': (0.14, 0.10), 'wood': (0.22, 0.10), 'trim': (0.22, 0.10),
           'container': (0.24, 0.14), 'paint': (0.30, 0.18), 'sand': (0.18, 0.12)}
TINTED = TINTED | set(RK_WEAR)

exec(open(os.path.join(globals()['OVERRUN_REPO'], 'scripts', 'blender', 'mapkit.py')).read())
exec(open(os.path.join(REPO, 'scripts', 'blender', 'roundkit_dh.py')).read())
crate_kit = crate

_vbox_round = vbox


def vbox(key, frame, cx, cy, cz, w, h, d, tint=WHITE, skip=('-y',)):
    """The rounding kit's box, except where the box is too slim for a bevel to show."""
    if min(w, h, d) < 0.2:
        return _vbox0(key, frame, cx, cy, cz, w, h, d, tint, skip)
    return _vbox_round(key, frame, cx, cy, cz, w, h, d, tint, skip)


TRIM = 0.003
OUT_YAW = {'+z': 0.0, '-z': math.pi, '+x': math.pi / 2, '-x': -math.pi / 2}

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

def tbox(key, fr, cx, cy, cz, w, h, d, r=0.03, tint=WHITE, skip=()):
    """A small rounded detail box (trim, caps, bars) that the slim-box rule would leave sharp."""
    rbox(key, fr, cx, cy, cz, w, h, d, r, tint, skip)


def fillet(pts, radii, seg=4):
    """Round the corners of a closed 2D outline: radii[i] is the radius at pts[i] (0 = sharp)."""
    out = []
    m = len(pts)
    for i, p in enumerate(pts):
        r = radii[i]
        a, b = pts[i - 1], pts[(i + 1) % m]
        ux, uy = a[0] - p[0], a[1] - p[1]
        vx, vy = b[0] - p[0], b[1] - p[1]
        lu, lv = math.hypot(ux, uy), math.hypot(vx, vy)
        if r <= 0 or lu < 1e-9 or lv < 1e-9:
            out.append(p)
            continue
        ux, uy, vx, vy = ux / lu, uy / lu, vx / lv, vy / lv
        ang = math.acos(max(-1.0, min(1.0, ux * vx + uy * vy)))
        if ang < 1e-3 or ang > math.pi - 1e-3:
            out.append(p)
            continue
        tn = min(r / math.tan(ang / 2), 0.45 * min(lu, lv))
        re = tn * math.tan(ang / 2)
        t1 = (p[0] + ux * tn, p[1] + uy * tn)
        t2 = (p[0] + vx * tn, p[1] + vy * tn)
        bx, by = ux + vx, uy + vy
        lb = math.hypot(bx, by)
        d = re / math.sin(ang / 2)
        c = (p[0] + bx / lb * d, p[1] + by / lb * d)
        a1 = math.atan2(t1[1] - c[1], t1[0] - c[0])
        a2 = math.atan2(t2[1] - c[1], t2[0] - c[0])
        da = (a2 - a1 + math.pi) % (2 * math.pi) - math.pi
        for k in range(seg + 1):
            ak = a1 + da * k / seg
            out.append((c[0] + re * math.cos(ak), c[1] + re * math.sin(ak)))
    return out


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


def box_xz(key, xa, xb, za, zb, y0, y1, skip=('-y',), block=1, top_key=None, plain=False):
    cx, cz, w, d = (xa + xb) / 2, (za + zb) / 2, xb - xa, zb - za
    vb = _vbox0 if plain else vbox
    if top_key:
        vb(key, Frame(), cx, (y0 + y1) / 2, cz, w, y1 - y0, d, skip=tuple(skip) + ('+y',))
        poly(top_key, Frame(), [(xa, y1, zb), (xb, y1, zb), (xb, y1, za), (xa, y1, za)])
    else:
        vb(key, Frame(), cx, (y0 + y1) / 2, cz, w, y1 - y0, d, skip=skip)
    collider(Frame(), cx, (y0 + y1) / 2, cz, w, y1 - y0, d, block)


def wall(x0, z0, x1, z1, h, t, key, block=1, y=0.0, top_key=None):
    """mapkit's wall, with a cap laid on the rounded top instead of a second box over it."""
    along_x = abs(x1 - x0) > abs(z1 - z0)
    length = abs(x1 - x0) if along_x else abs(z1 - z0)
    if length < 0.05:
        return
    w, d = (length, t) if along_x else (t, length)
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    if top_key:
        # the cap is the flat middle of the rounded top, in its own material
        vbox(key, Frame(), cx, y + h / 2, cz, w, h, d, skip=('-y', '+y'))
        inset = min(RK_ROUND.get(key, RK_ROUND_DEFAULT), min(w, h, d) * 0.3)
        poly(top_key, Frame(), [(cx - w / 2 + inset, y + h, cz + d / 2 - inset),
                                (cx + w / 2 - inset, y + h, cz + d / 2 - inset),
                                (cx + w / 2 - inset, y + h, cz - d / 2 + inset),
                                (cx - w / 2 + inset, y + h, cz - d / 2 + inset)])
        # a pilaster on each face, in the middle of a long run (trim: no collider under it)
        if length >= 5.0:
            n = int(length // 3.5)
            for k in range(n):
                u = -length / 2 + length * (k + 0.5) / n
                px, pz = (cx + u, cz) if along_x else (cx, cz + u)
                pw, pd = (0.5, t + 0.2) if along_x else (t + 0.2, 0.5)
                tbox('trim', Frame(), px, y + (h - 0.1) / 2, pz, pw, h - 0.1, pd, 0.05)
                tbox('trim', Frame(), px, y + h, pz, pw + 0.12, 0.14, pd + 0.12, 0.04)
    else:
        vbox(key, Frame(), cx, y + h / 2, cz, w, h, d, skip=('-y',))
    collider(Frame(), cx, y + h / 2, cz, w, h, d, block)


def wall_holes(x0, z0, x1, z1, h, t, key, holes, inner, detail=False):
    """An axis-aligned wall with openings, holes = [(u0, u1, y0, y1)] along it from its start.
    Every piece collides. `inner` is the face that looks into the building and gets the lining.
    detail adds a plinth, a skirting and the lintels, sills and jambs of the openings."""
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
        box_xz(key, xa, xb, za, zb, y0, y1, skip=('-y',) if y0 == 0 else (), plain=True)
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
    if detail:
        # one plinth along the outside, broken only by the doorways
        gaps = sorted((u0, u1) for (u0, u1, y0, y1) in holes if y0 == 0)
        a = 0.0
        for g0, g1 in gaps + [(L, L)]:
            if g0 - a > 0.3:
                c = (a + g0) / 2
                wx, wz = (x0 + sgn * c, z0) if along_x else (x0, z0 + sgn * c)
                tbox('trim', Frame(wx, 0, wz, OUT_YAW[outer]), 0, 0.2, t / 2 + 0.01, g0 - a, 0.4, 0.22, 0.04)
            a = g1
        for (u0, u1, y0, y1) in holes:
            c = (u0 + u1) / 2
            wx, wz = (x0 + sgn * c, z0) if along_x else (x0, z0 + sgn * c)
            fr = Frame(wx, 0, wz, OUT_YAW[outer])
            wd = u1 - u0
            zf = t / 2 + 0.02
            if y1 + 0.2 <= h:
                tbox('trim', fr, 0, y1 + 0.1, zf, wd + 0.3, 0.2, 0.26, 0.04)
            if y0 > 0.3:
                tbox('trim', fr, 0, y0 - 0.05, zf + 0.02, wd + 0.26, 0.1, 0.3, 0.03)
            if y0 == 0:
                for sg in (-1, 1):
                    tbox('trim', fr, sg * (wd / 2 + 0.07), y1 / 2, zf, 0.14, y1, 0.22, 0.03)


def rect(s, xa, xb, za, zb):
    a, b = sorted((s * xa, s * xb))
    c, d = sorted((s * za, s * zb))
    return a, b, c, d


def roof_detail(s, xa, xb, za, zb, H, seed, t=0.35):
    """What a flat roof carries: a parapet and its coping, a chimney, a unit, a tank, vents."""
    rnd = rnd_gen(seed * 31 + 7)
    fr = F(s, (xa + xb) / 2, (za + zb) / 2)
    hx, hz = (xb - xa) / 2, (zb - za) / 2
    top = H + 0.3
    # the parapet starts at the roof's underside, so it hides the slab's edge
    for sz in (-1, 1):
        tbox('trim', fr, 0, H + 0.35, sz * hz, (xb - xa) + t + 0.02, 0.7, t + 0.02, 0.05)
        tbox('trim', fr, 0, H + 0.74, sz * hz, (xb - xa) + t + 0.16, 0.08, t + 0.16, 0.03)
    for sx in (-1, 1):
        tbox('trim', fr, sx * hx, H + 0.35, 0, t + 0.02, 0.7, (zb - za) - t, 0.05)
        tbox('trim', fr, sx * hx, H + 0.74, 0, t + 0.16, 0.08, (zb - za) - t, 0.03)
    spanx, spanz = max(0.0, (xb - xa) - 2.6), max(0.0, (zb - za) - 2.6)
    for _ in range(1 + int(rnd() * 3)):
        x, z = (rnd() - 0.5) * spanx, (rnd() - 0.5) * spanz
        kind = int(rnd() * 3)
        if kind == 0:
            tbox('trim', fr, x, top + 0.7, z, 0.7, 1.4, 0.7, 0.06)
            tbox('trim', fr, x, top + 1.46, z, 0.92, 0.14, 0.92, 0.04)
            lathe('dark', fr, x, z, [(0.26, top + 1.535), (0.0, top + 1.535)], n=8)
        elif kind == 1:
            tbox('rail', fr, x, top + 0.35, z, 1.3, 0.7, 0.9, 0.05)
            tbox('rail', fr, x, top + 0.74, z, 1.0, 0.08, 0.7, 0.03)
            lathe('dark', fr, x - 0.3, z, [(0.3, top + 0.785), (0.0, top + 0.785)], n=10)
        else:
            y0 = top + 1.1
            for sx in (-1, 1):
                for sz in (-1, 1):
                    _vbox0('rail', fr, x + sx * 0.5, y0 / 2 + top / 2 - 0.0, z + sz * 0.5, 0.08, y0 - top, 0.08, skip=())
            lathe('rail', fr, x, z, [(0.0, y0), (0.72, y0), (0.8, y0 + 0.12), (0.8, y0 + 1.2), (0.72, y0 + 1.32),
                                     (0.0, y0 + 1.32)], n=12)
            lathe('rail', fr, x, z, [(0.82, y0 + 1.32), (0.0, y0 + 1.85)], n=12)
    # a vent stack
    lathe('rail', fr, (rnd() - 0.5) * spanx, (rnd() - 0.5) * spanz,
          [(0.0, top), (0.11, top), (0.11, top + 0.9), (0.2, top + 0.98), (0.2, top + 1.05), (0.0, top + 1.05)], n=8)


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
        wall_holes(s * xa, s * zc, s * xb, s * zc, H, t, key, holes_for(xb - xa, doors.get(side, [])), inn, True)
    for side, xc, inner in (('W', xa, '+x'), ('E', xb, '-x')):
        inn = inner if s > 0 else FLIP[inner]
        wall_holes(s * xc, s * (za + t / 2), s * xc, s * (zb - t / 2), H, t, key,
                   holes_for(zb - za - t, doors.get(side, [])), inn, True)
    if roofed:
        a, b, c, d = rect(s, xa - t / 2, xb + t / 2, za - t / 2, zb + t / 2)
        box_xz('roof', a, b, c, d, H, H + 0.3, skip=(), block=0)
    a, b, c, d = rect(s, xa, xb, za, zb)
    flat('floor', a, c, b, d, 0.004)
    # detail, none of it with a collider
    fr = F(s, (xa + xb) / 2, (za + zb) / 2)
    hx, hz = (xb - xa) / 2, (zb - za) / 2
    for sx in (-1, 1):
        for sz in (-1, 1):
            tbox('trim', fr, sx * hx, H / 2, sz * hz, t + 0.12, H, t + 0.12, 0.05)
    if roofed:
        for sz in (-1, 1):
            tbox('trim', fr, 0, H - 0.1, sz * hz, (xb - xa) + 0.3, 0.2, t + 0.24, 0.04)
        for sx in (-1, 1):
            tbox('trim', fr, sx * hx, H - 0.1, 0, t + 0.24, 0.2, (zb - za) - t, 0.04)
        span = min(xb - xa, zb - za)
        if xb - xa >= zb - za:
            k = xa + 3.0
            while k < xb - 1.5:
                tbox('trim', fr, k - (xa + xb) / 2, H - 0.15, 0, 0.26, 0.3, span - t, 0.04)
                k += 6.0
        else:
            k = za + 3.0
            while k < zb - 1.5:
                tbox('trim', fr, 0, H - 0.15, k - (za + zb) / 2, span - t, 0.3, 0.26, 0.04)
                k += 6.0
        roof_detail(s, xa, xb, za, zb, H, seed, t)
    else:
        # a broken coping along the top of the roofless walls
        for sz in (-1, 1):
            tbox('trim', fr, 0, H + 0.04, sz * hz, (xb - xa) + 0.2, 0.1, t + 0.1, 0.03)
        for sx in (-1, 1):
            tbox('trim', fr, sx * hx, H + 0.04, 0, t + 0.1, 0.1, (zb - za) - t, 0.03)


def partition(s, x0, z0, x1, z1, doors=(), h=CEIL_Y):
    """A thin inner wall from (x0, z0) to (x1, z1), a doorway at each u along it."""
    along_x = abs(x1 - x0) > abs(z1 - z0)
    inner = ('+z' if s > 0 else '-z') if along_x else ('+x' if s > 0 else '-x')
    wall_holes(s * x0, s * z0, s * x1, s * z1, h, 0.2, 'plaster', [(u - 0.8, u + 0.8, 0.0, 2.3) for u in doors], inner)


def sandbag(s, x, z, along_x=True, length=3.0, h=1.0, t=0.7):
    """Stacked sandbags, a hop high and cover from a crouch: three courses of fat rounded bags,
    each course shifted half a bag, over the one box that collides."""
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2)
    collider(fr, 0, h / 2, 0, length, h, t)
    rnd = rnd_gen(int(abs(x * 7 + z * 13 + length * 100)) + 5)
    rows = 3
    nb = max(1, round(length / 0.8))
    bl = length / nb
    ch = h / rows

    def cuts_for(off):
        return [-length / 2] + [-length / 2 + off + i * bl for i in range(nb)
                                if 0.05 < off + i * bl < length - 0.05] + [length / 2]
    # the top course takes the shift that leaves the middle of the run on a bag, not a seam
    offs = [0.0, bl / 2]
    top = max(offs, key=lambda o: min(abs(c) for c in cuts_for(o)))
    other = bl / 2 if top == 0.0 else 0.0
    for k in range(rows):
        cuts = cuts_for(top if (rows - 1 - k) % 2 == 0 else other)
        for a, b in zip(cuts, cuts[1:]):
            shade = 1.0 - 0.14 * rnd()
            rbox('sand', fr, (a + b) / 2, k * ch + ch / 2, 0, b - a, ch, t, 0.07,
                 tuple(c * shade for c in SANDBAG), skip=('-y',) if k == 0 else ())


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
            # the cast corner fittings
            for yy in (0.1, h - 0.1):
                _vbox0('rail', fr, sx * (L / 2 - 0.09), yy, sz * (W / 2 - 0.09), 0.2, 0.2, 0.2, skip=())
    for k in range(2, 12, 2):
        x_ = -L / 2 + k * L / 12
        for sz in (-1, 1):
            vbox('rail', fr, x_, h / 2, sz * (W / 2 + 0.01), 0.05, h - 0.2, 0.02, skip=())
    for yy in (0.06, h - 0.06):
        for sz in (-1, 1):
            vbox('rail', fr, 0, yy, sz * (W / 2 - 0.03), L - 0.3, 0.1, 0.07, skip=())


def lamp_post(s, x, z, yaw=0.0, h=4.4):
    fr = F(s, x, z, yaw)
    # the collider is the same slim box as ever; the post turned inside it, a collar at its foot
    collider(fr, 0, h / 2, 0, 0.14, h, 0.14)
    # straight, and wide enough to cover the corners of the collider's footprint: the ghost probe
    # looks for steel wherever the box is
    lathe('steel', fr, 0, 0, [(0.085, 0.0), (0.085, h)], n=8, phase=math.pi / 8, caps=(False, True))
    lathe('trim', fr, 0, 0, [(0.17, 0.0), (0.17, 0.1), (0.1, 0.3), (0.075, 0.42)], n=10)
    tube('rail', fr, [(0, h - 0.15, 0), (0, h + 0.02, -0.12), (0, h + 0.1, -0.55), (0, h + 0.04, -1.0)], 0.04, n=6, caps=False)
    tbox('rail', fr, 0, h - 0.1, -1.12, 0.34, 0.14, 0.5, 0.04)
    _vbox0('glow', fr, 0, h - 0.18, -1.12, 0.26, 0.02, 0.4, skip=())


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
    # bent rebar out of the broken slab
    for k in range(3):
        bx, bz = (rnd() - 0.5) * (w - 0.8), (rnd() - 0.5) * (d - 0.6)
        a = rnd() * 6.28
        lean = 0.25 + rnd() * 0.35
        tube('rail', fr, [(bx, h - 0.1, bz), (bx + math.cos(a) * lean * 0.5, h + 0.35, bz + math.sin(a) * lean * 0.5),
                          (bx + math.cos(a) * lean, h + 0.55, bz + math.sin(a) * lean)], 0.014, n=4, caps=False)


def scorch(x, z, r, seed):
    """A burn mark on the ground: a ragged dark decal."""
    rnd = rnd_gen(seed)
    pts = []
    for k in range(10):
        a = 2 * math.pi * k / 10
        rr = r * (0.75 + 0.25 * rnd())
        pts.append((x + rr * math.cos(a), 0.011, z - rr * math.sin(a)))
    poly('dark', Frame(), pts)


def wheel_pair(sf, wx, wy, R, hw, width=0.26, n=14):
    """A tyre with a hub on each side of a vehicle whose body is hw to either side of centre."""
    for sg in (-1, 1):
        zc = sg * (hw - 0.02)
        wheel('tyre', sf, wx, wy, zc, R, width, 'z', n, hub=0.5)
        z0, z1 = sorted((zc + sg * width / 2 - 0.01, zc + sg * (width / 2 + 0.03)))
        lathe('rail', sf, wx, wy, [(0.0, z0), (R * 0.55, z0), (R * 0.55, z1), (0.0, z1)], n=10, ax='z')


def wreck(s, x, z, yaw, tint, L=4.4, W=1.9, H=1.45):
    """A burnt-out car: a filleted lower body and a narrower cabin, dark windows, four tyres.
    The collider is the box round it: 1.45 m, cover from standing and a wall for a jump."""
    fr = F(s, x, z, yaw)
    collider(fr, 0, H / 2 + 0.15, 0, W, H - 0.3, L, prop=1)
    sf = Frame(fr.o[0], fr.o[1], fr.o[2], fr.yaw - math.pi / 2)
    k = L / 4.4
    hw = W / 2 - 0.05
    lower = fillet([(-2.2 * k, 0.3), (2.2 * k, 0.3), (2.26 * k, 0.7), (2.18 * k, 0.97), (-2.2 * k, 0.97)],
                   [0.1, 0.12, 0.2, 0.14, 0.1])
    rprism('paint', sf, lower, -hw, hw, tint)
    cabin = fillet([(1.45 * k, 0.9), (0.75 * k, 1.45), (-0.85 * k, 1.45), (-1.6 * k, 0.9)], [0, 0.25, 0.3, 0])
    ch = hw - 0.1
    rprism('paint', sf, cabin, -ch, ch, tuple(c * 0.92 for c in tint))
    win = fillet([(-1.0 * k, 0.98), (1.15 * k, 0.98), (0.62 * k, 1.38), (-0.68 * k, 1.38)], [0.05, 0.05, 0.08, 0.08], 2)
    poly('dark', sf, [(x_, y_, ch + TRIM) for x_, y_ in win])
    poly('dark', sf, [(x_, y_, -ch - TRIM) for x_, y_ in reversed(win)])
    for sx in (-1, 1):
        tbox('rail', sf, sx * 2.2 * k, 0.45, 0, 0.18, 0.2, W - 0.1, 0.05)
    for wx in (-1.4 * k, 1.35 * k):
        wheel_pair(sf, wx, 0.33, 0.33, hw)
    scorch(fr.o[0], fr.o[2], L * 0.6, int(abs(fr.o[0] * 3 + fr.o[2] * 5)) + 11)


def bus(s, x, z, yaw, tint):
    fr = F(s, x, z, yaw)
    L, W, H = 10.5, 2.5, 2.9
    collider(fr, 0, H / 2 + 0.2, 0, W, H - 0.4, L, prop=1)
    sf = Frame(fr.o[0], fr.o[1], fr.o[2], fr.yaw - math.pi / 2)
    hl = L / 2
    prof = fillet([(-hl, 0.45), (hl, 0.45), (hl, 2.2), (hl - 0.5, H), (-hl, H)], [0.1, 0.15, 0.35, 0.5, 0.35])
    hw = W / 2 - 0.02
    rprism('paint', sf, prof, -hw, hw, tint)
    for side in (1, -1):
        z_ = side * (hw + TRIM)
        for k in range(8):
            x0 = -hl + 0.8 + k * 1.15
            q = fillet([(x0, 1.6), (x0 + 0.95, 1.6), (x0 + 0.95, 2.55), (x0, 2.55)], [0.08] * 4, 2)
            poly('dark', sf, [(x_, y_, z_) for x_, y_ in (q if side > 0 else q[::-1])])
    # the windscreen, a bumper each end and the unit on the roof
    poly('dark', sf, [(hl + TRIM, 1.0, hw - 0.2), (hl + TRIM, 1.0, -hw + 0.2), (hl + TRIM, 2.1, -hw + 0.2),
                      (hl + TRIM, 2.1, hw - 0.2)])
    for sx in (-1, 1):
        tbox('rail', sf, sx * (hl + 0.03), 0.55, 0, 0.2, 0.24, W - 0.1, 0.06)
    tbox('paint', sf, -1.2, H + 0.14, 0, 3.0, 0.3, 1.3, 0.1, tuple(c * 0.85 for c in tint))
    for wx in (-3.3, 3.2):
        wheel_pair(sf, wx, 0.5, 0.5, hw, 0.34, 16)
    scorch(fr.o[0], fr.o[2], 5.6, int(abs(fr.o[0] * 3 + fr.o[2] * 5)) + 13)


def dead_tree(s, x, z, seed=1, h=5.0):
    fr = F(s, x, z)
    wx, _, wz = fr.world((0, 0, 0))
    CYLINDERS.append([round(wx, 4), round(h / 2, 4), round(wz, 4), 0.4, round(h, 4), 1, 1])
    rnd = rnd_gen(seed)
    lathe('trunk', fr, 0, 0, [(0.38, 0.0), (0.28, 0.3), (0.21, 0.9), (0.17, h * 0.45), (0.11, h * 0.85), (0.06, h)],
          n=7, caps=(False, True))
    for k in range(5):
        a = rnd() * 6.28
        y0 = h * (0.45 + 0.12 * k)
        L = 1.0 + rnd() * 0.9
        rise = 0.6 + rnd() * 0.6
        c, sn = math.cos(a), math.sin(a)
        r0 = 0.075 * (1 - 0.12 * k)
        path = [(c * 0.05, y0, sn * 0.05), (c * L * 0.5, y0 + rise * 0.55, sn * L * 0.5), (c * L, y0 + rise, sn * L)]
        tube('trunk', fr, path, [r0, r0 * 0.7, 0.02], n=5)
        f = a + 0.8
        pm = path[1]
        tube('trunk', fr, [pm, (pm[0] + math.cos(f) * 0.5, pm[1] + 0.4, pm[2] + math.sin(f) * 0.5),
                           (pm[0] + math.cos(f) * 0.95, pm[1] + 0.85, pm[2] + math.sin(f) * 0.95)],
             [r0 * 0.6, 0.03, 0.012], n=4)


def barrel_cluster(s, x, z, seed=1):
    rnd = rnd_gen(seed)
    for k in range(3):
        prop('drum', s, x + (rnd() - 0.5) * 1.6, z + (rnd() - 0.5) * 1.6, rnd() * 6.28)


def shrubs(s, px, pz, seed):
    """A few dead stems standing in a planter, from the soil at 1.0 m."""
    rnd = rnd_gen(seed)
    fr = F(s, px, pz)
    for k in range(5):
        bx = (rnd() - 0.5) * 3.6
        bz = (rnd() - 0.5) * 0.4
        a = rnd() * 6.28
        lean = 0.3 + rnd() * 0.4
        tube('trunk', fr, [(bx, 1.0, bz), (bx + math.cos(a) * lean * 0.5, 1.45, bz + math.sin(a) * lean * 0.5),
                           (bx + math.cos(a) * lean, 1.95 + rnd() * 0.4, bz + math.sin(a) * lean)],
             [0.035, 0.025, 0.008], n=4)


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
        # kerbs along both: a low rounded edge, too low to climb and with no collider
        for kx in (-5.1, 5.1):
            tbox('trim', Frame(), s * kx, 0.03, s * 23.5, 0.2, 0.08, 25.0, 0.025)
        for kz in (-3.6, 4.6):
            tbox('trim', Frame(), s * 41.0, 0.03, s * kz, 50.0, 0.08, 0.2, 0.025)
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
        o = {'+z': (0, 0, 0.1), '-z': (0, 0, -0.1), '+x': (0.1, 0, 0), '-x': (-0.1, 0, 0)}[face]
        k = 0.0
        while k <= L + 0.01:
            c = P(min(k, L), 0)
            vbox('concrete', Frame(c[0] + o[0], 0, c[2] + o[2]), 0, WALL_H / 2, 0, 0.5, WALL_H, 0.5)
            tbox('trim', Frame(c[0] + o[0], 0, c[2] + o[2]), 0, WALL_H + 0.05, 0, 0.7, 0.14, 0.7, 0.04)
            k += 9.0
        # a coping along the top
        tbox('trim', Frame(), (xa + xb) / 2, WALL_H + 0.04, (za + zb) / 2, (xb - xa) + 0.16, 0.12, (zb - za) + 0.16, 0.03)
        # razor wire on the top: two taut lines on stanchions
        for d, y in ((0.0, WALL_H + 0.25), (0.12, WALL_H + 0.45)):
            a, b = P(0, y), P(L, y)
            oo = {'+z': (0, 0, d), '-z': (0, 0, -d), '+x': (d, 0, 0), '-x': (-d, 0, 0)}[face]
            member((a[0] + oo[0], y, a[2] + oo[2]), (b[0] + oo[0], y, b[2] + oo[2]), 0.03, 'rail')
        k = 3.0
        while k < L:
            c = P(k, WALL_H + 0.35)
            _vbox0('rail', Frame(), c[0], c[1], c[2], 0.05, 0.5, 0.05, skip=())
            k += 6.0


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
    # the monument: a stepped plinth, an obelisk with collars and a pyramidion, and four urns
    box_xz('concrete', -3.2, 3.2, -3.2, 3.2, 0, 0.5, skip=('-y',))
    box_xz('stucco', -2.0, 2.0, -2.0, 2.0, 0.5, 1.0, skip=('-y',))
    solid('stucco', Frame(), 0, 3.6, 0, 1.3, 5.2, 1.3)
    tbox('trim', Frame(), 0, 1.12, 0, 1.75, 0.24, 1.75, 0.05)
    tbox('trim', Frame(), 0, 1.35, 0, 1.5, 0.2, 1.5, 0.04)
    tbox('trim', Frame(), 0, 6.1, 0, 1.55, 0.2, 1.55, 0.04)
    lathe('trim', Frame(), 0, 0, [(0.97, 6.2), (0.0, 7.5)], n=4, phase=math.pi / 4)
    for ux in (-1, 1):
        for uz in (-1, 1):
            lathe('trim', Frame(), ux * 2.7, uz * 2.7,
                  [(0.0, 0.5), (0.26, 0.5), (0.3, 0.6), (0.2, 0.78), (0.14, 0.95), (0.24, 1.18), (0.0, 1.18)], n=12)

    def per_side(s):
        # planters: stone troughs along the plaza's long edges
        box_xz('concrete', *rect(s, 6.0, 12.0, 8.0, 9.2), 0, 1.0, skip=('-y',))
        box_xz('concrete', *rect(s, -12.0, -6.0, 8.0, 9.2), 0, 1.0, skip=('-y',))
        for px in (9.0, -9.0):
            vbox('trunk', F(s, px, 8.6), 0, 1.02, 0, 4.8, 0.04, 0.8, skip=('-y',))
            shrubs(s, px, 8.6, 200 + int(px) + s)
            tbox('trim', F(s, px, 8.6), 0, 0.12, 0, 6.2, 0.24, 1.4, 0.05)
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
                # a capital and a base block on each column
                tbox('trim', F(s, cx, cz), 0, 3.9, 0, 0.95, 0.2, 0.95, 0.05)
                tbox('trim', F(s, cx, cz), 0, 0.12, 0, 0.9, 0.24, 0.9, 0.05)
        rubble(s, 24.5, 20.0, 0.4, 0.9, 61 + s)
        rubble(s, 34.0, 10.5, 1.0, 0.9, 63 + s)
        # E2: the fuel station, a canopy on four posts and a kiosk
        for px in (43.0, 53.0):
            for pz in (11.0, 17.0):
                solid('steel', F(s, px, pz), 0, CEIL_Y / 2, 0, 0.5, CEIL_Y, 0.5)
                tbox('trim', F(s, px, pz), 0, 0.15, 0, 0.8, 0.3, 0.8, 0.05)
        a, b, c, d = rect(s, 41.5, 54.5, 9.5, 18.5)
        box_xz('roof', a, b, c, d, CEIL_Y, CEIL_Y + 0.3, skip=(), block=0)
        a, b, c, d = rect(s, 41.5, 54.5, 9.5, 18.5)
        flat('floor', a, c, b, d, 0.004)
        # a fascia all round the canopy, with a lit stripe
        cfr = F(s, 48.0, 14.0)
        for sz in (-1, 1):
            tbox('trim', cfr, 0, CEIL_Y + 0.2, sz * 4.5, 13.3, 0.55, 0.3, 0.05)
            _vbox0('glow', cfr, 0, CEIL_Y + 0.2, sz * 4.67, 11.0, 0.08, 0.02, skip=())
        for sx in (-1, 1):
            tbox('trim', cfr, sx * 6.5, CEIL_Y + 0.2, 0, 0.3, 0.55, 9.3, 0.05)
        for px in (46.0, 50.0):
            solid('steel', F(s, px, 14.0), 0, 0.65, 0, 0.9, 1.3, 0.6)
            vbox('glow', F(s, px, 14.0), 0, 1.0, 0.31, 0.5, 0.3, 0.02, skip=())
            pf = F(s, px, 14.0)
            tbox('rail', pf, 0, 1.36, 0, 1.0, 0.12, 0.7, 0.04)
            tube('rail', pf, [(0.38, 1.0, 0.3), (0.55, 0.7, 0.42), (0.5, 0.35, 0.3), (0.42, 0.12, 0.28)], 0.022, n=5, caps=False)
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
        # a deep footing, so the block never hovers over the folds of the ground
        vbox('far', fr, 0, -4.0, 0, w * 0.96, 8.0, d * 0.96, tint=tuple(c * 0.8 for c in tint), skip=('-y',))
        # a snapped upper storey, set back and off-centre; a third of them break in a slanted edge
        ox, oz = (rnd() - 0.5) * 2, (rnd() - 0.5) * 2
        uh = 3.0 + rnd() * 2
        w2, d2 = w * 0.6, d * 0.6
        t2 = tuple(c * 0.9 for c in tint)
        r2 = rnd_gen(k + 500)
        if r2() < 0.35:
            a2 = w2 / 2
            ff = Frame(*fr.world((ox, h + 1.5 - uh / 2, oz)), fr.yaw)
            prism('far', ff, [(-a2, 0), (a2, 0), (a2, uh * 0.55), (a2 * 0.2, uh * 1.15), (-a2 * 0.25, uh * 0.75),
                              (-a2, uh * 1.0)], -d2 / 2, d2 / 2, t2)
        else:
            vbox('far', fr, ox, h + 1.5, oz, w2, uh, d2, tint=t2, skip=('-y',))
        # a deep parapet round the main roof, and now and again a tank on legs
        vbox('far', fr, 0, h + 0.3, 0, w + 0.5, 0.6, d + 0.5, tint=tuple(c * 0.82 for c in tint), skip=('-y',))
        if r2() < 0.3:
            tx, tz = (r2() - 0.5) * w * 0.5, (r2() - 0.5) * d * 0.5
            lathe('far', fr, tx, tz, [(0.0, h + 2.5), (1.4, h + 2.5), (1.5, h + 2.7), (1.5, h + 4.6), (1.4, h + 4.8),
                                       (0.0, h + 4.8)], n=10, tint=tuple(c * 0.7 for c in tint))
            lathe('far', fr, tx, tz, [(1.55, h + 4.8), (0.0, h + 5.9)], n=10, tint=tuple(c * 0.62 for c in tint))
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
    # foothills banked beyond the town: smooth domes with a shoulder
    for k in range(10):
        ang = k / 10 * math.tau + rnd() * 0.3
        dist = 150 + rnd() * 60
        x, z = math.cos(ang) * dist * 1.25, math.sin(ang) * dist
        hgt, r = 30 + rnd() * 26, 40 + rnd() * 30
        fr = Frame(x, height(x, z) - 6, z, rnd() * 6)
        tint = HILLS[k % len(HILLS)] if rnd() < 0.7 else ROCK
        lathe('far', fr, 0, 0, [(r * 1.25, -4.0), (r * 1.12, hgt * 0.1), (r * 0.9, hgt * 0.32), (r * 0.66, hgt * 0.58),
                                 (r * 0.4, hgt * 0.8), (r * 0.16, hgt * 0.95), (0.0, hgt)], n=14, tint=tint)


def build_layout():
    ground()
    perimeter()
    base()
    boulevard()
    plaza()
    west_district()
    east_district()
    backdrop()
    warzone_detail()
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


exec(open(os.path.join(REPO, 'scripts', 'blender', 'warzonedetail.py')).read())

result = run_round(build_layout)
