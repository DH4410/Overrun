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

Detail and rounding come from roundkit_dh.py; nothing it or the detail below emits is a collider.
Detail that sticks out of a collider uses the keys the ghost probe ignores (trim, metal, paint,
rail, dark, lines, glow, skylight).
"""
import math
import os

MAP = 'depot'
HX, HZ = 18.0, 26.0      # playable half extents
WALL_H = 7.0
CEIL_Y = 7.0             # underside of the roof

MATERIALS, TINTED, PROPS = {}, set(), {}
SMOOTH = set()

# Rounded edges, smooth normals and wear (roundkit_dh.py).
RK_ROUND = {'cmu': 0.06, 'concrete': 0.08, 'steel': 0.04, 'wood': 0.05, 'stucco': 0.06, 'plaster': 0.05,
            'container': 0.05, 'rail': 0.03, 'trim': 0.04, 'metal': 0.025}
RK_ROUND_DEFAULT = 0.04
RK_CELL = 8.0
RK_PLAIN = {'floor', 'lines', 'dark', 'glow', 'skylight', 'roof', 'sand', 'far', 'paint', 'ground', 'outer',
            'fit', 'mark', 'glyph', 'tmark', 'tglyph'}
RK_WEAR = {'cmu': (0.30, 0.14), 'concrete': (0.30, 0.14), 'steel': (0.14, 0.08), 'rail': (0.14, 0.08),
           'wood': (0.22, 0.10), 'stucco': (0.22, 0.10, True), 'plaster': (0.20, 0.10, True),
           'trim': (0.22, 0.10), 'metal': (0.0, 0.08)}

exec(open(os.path.join(globals()['OVERRUN_REPO'], 'scripts', 'blender', 'mapkit.py')).read())
exec(open(os.path.join(globals()['OVERRUN_REPO'], 'scripts', 'blender', 'urbankit.py')).read())
exec(open(os.path.join(REPO, 'scripts', 'blender', 'roundkit_dh.py')).read())
MATERIALS.update(URBAN_MATERIALS)
MATERIALS['skylight'] = ((0.80, 0.90, 1.00), 1.0)
# Detail with no collider: none of these is in the ghost probe's touch list.
MATERIALS['trim'] = ((0.60, 0.59, 0.56), 3.0)      # precast bases, capitals, cornices, hoods
MATERIALS['metal'] = ((0.26, 0.28, 0.30), 2.0)     # frames, pipes, ducts, hangers, housings
# The detail pass (depotdetail.py): hardware, matte paint, lit lamps and sign text from the glyph
# atlas (src/typeAtlas.js), each tinted per piece. None of them is a collider or a ghost-probe key.
MATERIALS['fit'] = ((0.35, 0.37, 0.40), 1.0)
for _k in ('mark', 'glyph', 'tmark', 'tglyph'):
    MATERIALS[_k] = ((1.00, 1.00, 1.00), 1.0)
TINTED |= URBAN_TINTED | set(RK_WEAR) | {'fit', 'mark', 'glyph', 'tmark', 'tglyph'}
PROPS.update(URBAN_PROPS)

_vbox_round = vbox


def vbox(key, frame, cx, cy, cz, w, h, d, tint=WHITE, skip=('-y',)):
    """The rounding kit's box, except where the box is too slim for a bevel to show."""
    if min(w, h, d) < 0.2:
        return _vbox0(key, frame, cx, cy, cz, w, h, d, tint, skip)
    return _vbox_round(key, frame, cx, cy, cz, w, h, d, tint, skip)


YELLOW = srgb(0xd9a900)
BLACK = srgb(0x1b1b1b)
GREEN = srgb(0x1f8a4c)
RED = srgb(0xb3261e)
PAPER = srgb(0xe8e8e4)

FACE_YAW = {'+z': 0.0, '-z': math.pi, '+x': math.pi / 2, '-x': -math.pi / 2}


def onface(face, P, t, y=0.0):
    """A frame standing on a wall face, t along it and y up, its local +z pointing out of the wall."""
    x, _, z = P(t, 0.0)
    return Frame(x, y, z, FACE_YAW[face])


def rb(key, fr, cx, cy, cz, w, h, d, r=0.03, tint=WHITE):
    """A small rounded block (the kit's vbox leaves anything under 0.2 m sharp)."""
    rbox(key, fr, cx, cy, cz, w, h, d, r, tint, ())


def pquad(fr, x0, x1, y0, y1, z, tint, key='paint', flip=False):
    """A flat painted rectangle in a frame, facing local +z (or -z with flip)."""
    q = [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)]
    poly(key, fr, q[::-1] if flip else q, tint)


def hazard(fr, x0, x1, y0, y1, z, seg=0.4):
    """Yellow and black blocks along a face, flush."""
    n = max(1, int(round((x1 - x0) / seg)))
    w = (x1 - x0) / n
    for i in range(n):
        pquad(fr, x0 + i * w, x0 + (i + 1) * w, y0, y1, z, YELLOW if i % 2 == 0 else BLACK)


# ------------------------------------------------------------------ the hall

def clerestory(fr, t, w=2.6, y0=4.55, y1=6.15):
    """A daylight window high in a wall: a pale pane flush with a steel frame, mullions and a hood."""
    pquad(fr, t - w / 2, t + w / 2, y0, y1, 0.004, srgb(0xcfe4ff), 'skylight')
    f = 0.1
    rb('metal', fr, t, y1 + f / 2, 0.06, w + 2 * f, f, 0.12, 0.03)
    rb('metal', fr, t, y0 - f / 2, 0.08, w + 2 * f, f, 0.16, 0.03)
    for sx in (-1, 1):
        rb('metal', fr, t + sx * (w / 2 + f / 2), (y0 + y1) / 2, 0.06, f, y1 - y0, 0.12, 0.03)
    for k in (-1, 0, 1):
        rb('metal', fr, t + k * w / 4, (y0 + y1) / 2, 0.04, 0.05, y1 - y0, 0.08, 0.02)
    rb('metal', fr, t, (y0 + y1) / 2, 0.04, w, 0.05, 0.08, 0.02)


def extinguisher(fr, t):
    """A red cylinder on a bracket under a green sign, at hand height."""
    rb('metal', fr, t, 1.15, 0.05, 0.28, 0.06, 0.1, 0.02)
    rb('metal', fr, t, 0.75, 0.05, 0.28, 0.06, 0.1, 0.02)
    lathe('paint', fr, t, 0.14, [(0.0, 0.62), (0.1, 0.62), (0.11, 0.74), (0.11, 1.1), (0.08, 1.2), (0.0, 1.22)], n=10, tint=RED)
    rb('metal', fr, t, 1.26, 0.14, 0.05, 0.08, 0.05, 0.015)
    pquad(fr, t - 0.28, t + 0.28, 1.65, 2.15, 0.004, GREEN)
    pquad(fr, t - 0.05, t + 0.05, 1.75, 2.05, 0.006, PAPER)
    pquad(fr, t - 0.15, t + 0.15, 1.85, 1.95, 0.006, PAPER)


def panel(fr, t):
    """A grey electrical cabinet with a conduit climbing to the ceiling."""
    rb('metal', fr, t, 1.7, 0.14, 0.7, 0.95, 0.24, 0.04)
    rb('metal', fr, t, 1.7, 0.27, 0.52, 0.75, 0.03, 0.01)
    pquad(fr, t - 0.1, t + 0.1, 1.95, 2.1, 0.292, YELLOW)
    tube('metal', fr, [(t + 0.2, 2.2, 0.12), (t + 0.2, 6.9, 0.12)], 0.03, n=6, caps=True)


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
        fr = onface(face, P, L / 2)
        gap = 4.2 if face in ('+z', '-z') else 3.6            # half the clear span of the door in this wall
        for t0, t1 in ((0.0, L / 2 - gap), (L / 2 + gap, L)):    # the run either side of the door
            mid, w = (t0 + t1) / 2 - L / 2, t1 - t0
            rb('trim', fr, mid, 0.08, 0.04, w, 0.16, 0.1, 0.03)                     # skirting
            rb('trim', fr, mid, 1.33, 0.05, w, 0.14, 0.14, 0.04)                    # dado cap
            face_quad('paint', P, t0, t1, 1.55, 1.7, YELLOW)                        # a painted line above it
        rb('trim', fr, 0, WALL_H - 0.2, 0.1, L, 0.4, 0.2, 0.04)                     # cornice
        o = {'+z': (0, 0, 0.12), '-z': (0, 0, -0.12), '+x': (0.12, 0, 0), '-x': (-0.12, 0, 0)}[face]
        k = 3.0
        bay = 0
        # pipes along the wall on brackets, in front of the pilasters, stopping short of the door
        for a, b in ((-L / 2 + 0.2, -gap), (gap, L / 2 - 0.2)):
            tube('metal', fr, [(a, 3.4, 0.48), (b, 3.4, 0.48)], 0.07, n=8, caps=True)
            tube('metal', fr, [(a, 3.8, 0.48), (b, 3.8, 0.48)], 0.045, n=6, caps=True)
        while k < L - 0.5:                                    # pilasters
            if abs(k - L / 2) >= gap - 0.5:                   # none in front of a door
                c = P(k, 0)
                vbox('concrete', Frame(c[0] + o[0], 0, c[2] + o[2]), 0, WALL_H / 2, 0, 0.5, WALL_H, 0.5)
                pf = onface(face, P, k)
                rb('trim', pf, 0, 0.25, 0.14, 0.78, 0.5, 0.78, 0.06)                # base
                rb('trim', pf, 0, WALL_H - 0.3, 0.14, 0.72, 0.4, 0.72, 0.05)        # capital
                rb('metal', pf, 0, 3.6, 0.0, 0.1, 0.4, 0.66, 0.02)                  # pipe bracket
            if k + 3.0 < L - 0.5:
                mid = k + 3.0
                dist = abs(mid - L / 2)
                door_here = (face in ('+z', '-z') and dist < 4.6) or (face in ('+x', '-x') and dist < 3.6)
                if not door_here:
                    clerestory(fr, mid - L / 2)
                    if bay % 2 == 0:
                        panel(fr, mid - L / 2)
                    else:
                        extinguisher(fr, mid - L / 2)
                bay += 1
            k += 6.0
    # roller doors in the end walls and a loading door in each side wall: dark leaves with a glow
    # strip over them, painted on the inside face
    for sz in (-1, 1):
        zf = sz * (HZ - 2 * TRIM)
        q = [(-3.4, 0.0, zf), (3.4, 0.0, zf), (3.4, 4.6, zf), (-3.4, 4.6, zf)]
        poly('dark', Frame(), q if sz < 0 else q[::-1])
        for r in range(8):
            y = 0.5 + r * 0.55
            q2 = [(-3.4, y, zf - sz * 0.01), (3.4, y, zf - sz * 0.01), (3.4, y + 0.06, zf - sz * 0.01), (-3.4, y + 0.06, zf - sz * 0.01)]
            poly('steel', Frame(), q2 if sz < 0 else q2[::-1])
        vbox('glow', Frame(0, 0, zf - sz * 0.05), 0, 5.2, 0, 1.2, 0.16, 0.05, skip=())
        # guide rails, the roll housing, a bottom bar, hazard jambs and a pull handle
        fr = Frame(0, 0, zf, 0.0 if sz < 0 else math.pi)       # local +z points into the hall
        for sx in (-1, 1):
            rb('metal', fr, sx * 3.58, 2.4, 0.08, 0.2, 4.8, 0.16, 0.04)
            for i in range(13):
                y0 = i * 0.36
                pquad(fr, sx * 3.82 - 0.18, sx * 3.82 + 0.18, y0, min(y0 + 0.36, 4.7), 0.01, YELLOW if i % 2 == 0 else BLACK)
        rb('trim', fr, 0, 4.85, 0.3, 7.8, 0.45, 0.5, 0.06)
        rb('metal', fr, 0, 0.1, 0.06, 6.9, 0.14, 0.1, 0.03)
        rb('metal', fr, 2.4, 0.95, 0.06, 0.06, 0.34, 0.08, 0.02)
        pquad(fr, -0.9, 0.9, 5.6, 5.95, 0.585, GREEN)
        pquad(fr, -0.7, 0.7, 5.69, 5.86, 0.587, PAPER)
    for sx in (-1, 1):
        xf = sx * (HX - 2 * TRIM)
        q = [(xf, 0.0, -3.0), (xf, 0.0, 3.0), (xf, 3.8, 3.0), (xf, 3.8, -3.0)]
        poly('dark', Frame(), q[::-1] if sx < 0 else q)     # the leaf faces into the hall
        vbox('glow', Frame(xf - sx * 0.05, 0, 0), 0, 4.4, 0, 0.05, 0.16, 1.2, skip=())
        fr = Frame(xf, 0, 0, -sx * math.pi / 2)                 # local +z points into the hall
        for sz in (-1, 1):
            rb('metal', fr, sz * 3.12, 1.95, 0.08, 0.24, 3.9, 0.16, 0.04)
        rb('metal', fr, 0, 3.9, 0.08, 6.5, 0.24, 0.16, 0.04)
        rb('trim', fr, 0, 4.2, 0.28, 7.0, 0.14, 0.6, 0.04)                          # hood
        for sz in (-1, 1):
            rb('metal', fr, sz * 2.4, 0.6, 0.12, 0.28, 0.4, 0.22, 0.05)             # dock bumpers
        rb('metal', fr, 0, 0.05, 0.6, 5.6, 0.1, 1.0, 0.03)                          # dock leveller plate
        hazard(fr, -3.0, 3.0, 0.0, 0.14, 1.12, 0.3)


def floor_and_roof():
    GX, GZ = HX + 0.6, HZ + 0.6
    poly('floor', Frame(), [(-GX, 0, GZ), (GX, 0, GZ), (GX, 0, -GZ), (-GX, 0, -GZ)])
    collider(Frame(), 0, -0.5, 0, 2 * GX, 1.0, 2 * GZ, block=0)
    # painted lanes: a hazard frame round the stage and walkway lines down both lanes
    for (x0, z0, x1, z1) in ((-7.4, -6.4, -7.1, 6.4), (7.1, -6.4, 7.4, 6.4), (-7.4, 6.1, 7.4, 6.4), (-7.4, -6.4, 7.4, -6.1)):
        flat('lines', x0, z0, x1, z1, 0.008)
    for sx in (-1, 1):
        flat('lines', sx * 9.5, -22.0, sx * 9.62, 22.0, 0.008)
    # slab joints: the floor is poured in bays
    for x in (-12.0, -6.0, 0.0, 6.0, 12.0):
        flat('dark', x - 0.02, -HZ, x + 0.02, HZ, 0.006)
    for z in (-18.0, -12.0, -6.0, 0.0, 6.0, 12.0, 18.0):
        flat('dark', -HX, z - 0.02, HX, z + 0.02, 0.006)
    # the roof, its trusses, and skylight panels on its underside
    slab('roof', -GX, -GZ, GX, GZ, CEIL_Y, 0.3, block=0)
    for z in range(-21, 22, 7):
        vbox('steel', Frame(), 0, CEIL_Y - 0.35, z, 2 * HX, 0.5, 0.25, skip=())
        # a lattice truss under the beam: a bottom chord, uprights and diagonals, bolted to the walls
        yb, yt = 5.95, CEIL_Y - 0.6
        tube('metal', Frame(), [(-HX + 0.1, yb, z), (HX - 0.1, yb, z)], 0.05, n=6, caps=True)
        n = 16
        for i in range(n):
            xa = -HX + 0.1 + i * (2 * HX - 0.2) / n
            xb = xa + (2 * HX - 0.2) / n
            tube('metal', Frame(), [(xa, yb, z), (xa, yt, z)], 0.022, n=5, caps=True)
            a, b = ((xa, yb), (xb, yt)) if i % 2 == 0 else ((xa, yt), (xb, yb))
            tube('metal', Frame(), [(a[0], a[1], z), (b[0], b[1], z)], 0.022, n=5, caps=True)
        for sx in (-1, 1):
            rb('metal', Frame(), sx * (HX - 0.15), (yb + CEIL_Y - 0.3) / 2, z, 0.1, CEIL_Y - 0.3 - yb + 0.2, 0.5, 0.03)
    for x in (-12, -4, 4, 12):
        vbox('steel', Frame(), x, CEIL_Y - 0.2, 0, 0.18, 0.2, 2 * HZ, skip=())
    # ventilation: a round duct down each side of the hall on hangers, and a cable tray on each wall
    for dx in (-5.0, 5.0):
        tube('metal', Frame(), [(dx, 5.8, -HZ + 0.3), (dx, 5.8, HZ - 0.3)], 0.42, n=14, caps=True)
        for z in range(-24, 25, 6):
            torus('metal', Frame(), dx, 5.8, z, 0.42, 0.04, ax='z', n=14, m=5)
        for z in range(-21, 22, 7):
            for ddx in (-0.3, 0.3):
                tube('metal', Frame(), [(dx + ddx, 6.2, z), (dx + ddx, CEIL_Y - 0.55, z)], 0.015, n=4, caps=True)
    for dx in (-15.4, 15.4):
        rb('metal', Frame(), dx, 5.3, 0.0, 0.55, 0.08, 2 * HZ - 1.0, 0.02)
        for sx in (-1, 1):
            rb('metal', Frame(), dx + sx * 0.28, 5.36, 0.0, 0.04, 0.14, 2 * HZ - 1.0, 0.01)
        for z in range(-21, 22, 7):
            for sx in (-1, 1):
                tube('metal', Frame(), [(dx + sx * 0.25, 5.3, z), (dx + sx * 0.25, CEIL_Y - 0.55, z)], 0.014, n=4, caps=True)
    # sprinkler mains between the trusses, with a head every few metres
    for z in range(-17, 18, 7):
        tube('metal', Frame(), [(-HX + 0.4, 6.15, z), (HX - 0.4, 6.15, z)], 0.04, n=6, caps=True)
        for x in range(-15, 16, 5):
            lathe('metal', Frame(), x, z, [(0.0, 5.98), (0.035, 5.98), (0.035, 6.15)], n=6)
            lathe('metal', Frame(), x, z, [(0.0, 5.98), (0.09, 6.0), (0.0, 6.04)], n=8)
    for xc in (-10.0, 0.0, 10.0):
        for z0 in range(-24, 24, 7):
            a, b = z0 + 0.5, z0 + 6.5
            poly('skylight', Frame(), [(xc - 1.3, CEIL_Y - 0.02, a), (xc + 1.3, CEIL_Y - 0.02, a),
                                       (xc + 1.3, CEIL_Y - 0.02, b), (xc - 1.3, CEIL_Y - 0.02, b)])
            for sx in (-1, 1):
                rb('metal', Frame(), xc + sx * 1.35, CEIL_Y - 0.06, (a + b) / 2, 0.1, 0.1, b - a + 0.2, 0.025)
            for z in (a - 0.05, b + 0.05):
                rb('metal', Frame(), xc, CEIL_Y - 0.06, z, 2.8, 0.1, 0.1, 0.025)


def hanging_lamp(x, z):
    """A high-bay light on a stem: a spun reflector over a glowing face."""
    fr = Frame(x, 0, z)
    tube('metal', fr, [(0, 5.95, 0), (0, CEIL_Y - 0.05, 0)], 0.03, n=6, caps=True)
    lathe('metal', fr, 0, 0, [(0.07, 6.1), (0.16, 6.0), (0.45, 5.78), (0.52, 5.68), (0.46, 5.67)], n=14)
    vbox('glow', fr, 0, 5.66, 0, 0.7, 0.02, 0.7, skip=())


LAMP_AT = [(0.0, 0.0), (0.0, 12.0), (0.0, -12.0), (-9.0, 6.0), (9.0, -6.0), (9.0, 18.0), (-9.0, -18.0)]


def stage():
    # the raised deck: a hop off a crate, or up a ramp at either end
    box_xz('concrete', -6.5, 6.5, -5.5, 5.5, 0.0, 1.4, top_key='steel')
    for sx in (-1, 1):
        for sz in (-1, 1):
            vbox('rail', Frame(sx * 6.0, 1.4, sz * 5.0), 0, 0.07, 0, 0.5, 0.14, 0.5, skip=('-y',))
            lathe('metal', Frame(sx * 6.0, 1.4, sz * 5.0), 0, 0, [(0.0, 0.14), (0.1, 0.14), (0.12, 0.2), (0.0, 0.22)], n=8)
    # a hazard border painted round the deck top, and an angle iron on its edge
    h = 0.5
    for sz in (-1, 1):
        z = sz * (5.5 - 0.2)
        n = int(13.0 / h)
        for i in range(n):
            x0 = -6.5 + i * 13.0 / n
            poly('paint', Frame(), [(x0, 1.404, z + 0.15), (x0 + 13.0 / n, 1.404, z + 0.15), (x0 + 13.0 / n, 1.404, z - 0.15), (x0, 1.404, z - 0.15)],
                 YELLOW if i % 2 == 0 else BLACK)
    for sx in (-1, 1):
        x = sx * (6.5 - 0.2)
        n = int(11.0 / h)
        for i in range(n):
            z0 = -5.5 + i * 11.0 / n
            poly('paint', Frame(), [(x - 0.15, 1.404, z0 + 11.0 / n), (x + 0.15, 1.404, z0 + 11.0 / n), (x + 0.15, 1.404, z0), (x - 0.15, 1.404, z0)],
                 YELLOW if i % 2 == 0 else BLACK)
    for sz in (-1, 1):
        rb('metal', Frame(), 0, 1.36, sz * 5.5, 13.04, 0.1, 0.06, 0.02)
    for sx in (-1, 1):
        rb('metal', Frame(), sx * 6.5, 1.36, 0, 0.06, 0.1, 11.04, 0.02)


def ramp_marks(s):
    """Painted bars across the ramp: it runs from z 12 at the floor to z 5.5 at 1.4 m, 4.4 m wide."""
    slope = lambda z: 1.4 * (12.0 - z) / 6.5
    for k in range(6):
        zb = 11.3 - k * 1.05
        za = zb - 0.28
        pts = [(-2.0, slope(zb) + 0.012, zb), (2.0, slope(zb) + 0.012, zb), (2.0, slope(za) + 0.012, za), (-2.0, slope(za) + 0.012, za)]
        poly('paint', Frame(), [(s * x, y, s * z) for x, y, z in pts], YELLOW)


def container_detail(s, x, z, along_x, tint, h=2.59):
    """Corner castings, hinges and a lock set on the door end, and an ID plate on the side."""
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2)
    L, W = 6.06, 2.44
    for sx in (-1, 1):
        for sz in (-1, 1):
            for yy in (0.1, h - 0.1):
                rb('metal', fr, sx * (L / 2 - 0.1), yy, sz * (W / 2 - 0.1), 0.2, 0.2, 0.2, 0.04)
    for zz in (-1.0, 1.0):
        for yy in (0.4, h / 2, h - 0.4):
            rb('metal', fr, L / 2 + 0.04, yy, zz, 0.06, 0.16, 0.16, 0.02)
    for zz in (-0.55, 0.55):
        for yy in (0.6, h - 0.6):
            rb('metal', fr, L / 2 + 0.05, yy, zz, 0.07, 0.3, 0.05, 0.02)
    for sz in (-1, 1):
        rb('metal', fr, 0, 0.06, sz * (W / 2 + 0.01), L - 0.2, 0.12, 0.08, 0.025)
        # an ID plate by the door end: a pale rectangle with a few dark bars
        zf = sz * (W / 2 + 0.025)
        q = [(L / 2 - 1.5, 1.5, zf), (L / 2 - 0.4, 1.5, zf), (L / 2 - 0.4, 1.9, zf), (L / 2 - 1.5, 1.9, zf)]
        poly('paint', fr, q if sz > 0 else q[::-1], PAPER)
        for i in range(5):
            xx = L / 2 - 1.4 + i * 0.2
            q = [(xx, 1.56, zf + sz * 0.003), (xx + 0.1, 1.56, zf + sz * 0.003), (xx + 0.1, 1.84, zf + sz * 0.003), (xx, 1.84, zf + sz * 0.003)]
            poly('paint', fr, q if sz > 0 else q[::-1], BLACK)


def column(s, x, z):
    """A steel column: the kit's 12-sided collider cylinder, with a base plate and bolts, a yellow
    guard band at the foot, a collar and a cap plate carrying the truss."""
    fr = F(s, x, z)
    cyl('steel', fr, 0, 0, 0.45, CEIL_Y)
    rb('metal', fr, 0, 0.04, 0, 1.15, 0.08, 1.15, 0.03)
    for a in range(4):
        ang = math.pi / 4 + a * math.pi / 2
        lathe('metal', fr, 0.52 * math.cos(ang), 0.52 * math.sin(ang), [(0.0, 0.08), (0.05, 0.08), (0.05, 0.16), (0.0, 0.18)], n=6)
    vcyl('paint', fr, 0, 0, 0.47, 0.08, 1.3, 12, tint=YELLOW, top=False)
    for k in range(4):
        vcyl('paint', fr, 0, 0, 0.475, 0.08 + 0.2 + k * 0.3, 0.08 + 0.3 + k * 0.3, 12, tint=BLACK, top=False)
    torus('metal', fr, 0, 3.0, 0, 0.45, 0.04, n=12, m=5)
    rb('metal', fr, 0, CEIL_Y - 0.08, 0, 1.0, 0.16, 1.0, 0.03)


def per_side(s):
    ramp(s, 0, 0, 12.0, 0, 1.4, 5.5, 4.4, 'steel', 'concrete')
    ramp_marks(s)
    # spawn end: two barriers in front of the door, a lane between them
    for sx in (-1, 1):
        x0, x1 = s * sx * 2.2, s * sx * 6.8
        wall(x0, s * 18.0, x1, s * 18.0, 1.0, 0.45, 'concrete', top_key='steel')
        # hazard blocks along both long faces
        xa, xb = sorted((x0, x1))
        n = int(round((xb - xa) / 0.4))
        for i in range(n):
            xs, xe = xa + i * (xb - xa) / n, xa + (i + 1) * (xb - xa) / n
            c = YELLOW if i % 2 == 0 else BLACK
            for zf, up in ((s * 18.0 + 0.225 + TRIM, True), (s * 18.0 - 0.225 - TRIM, False)):
                q = [(xs, 0.14, zf), (xe, 0.14, zf), (xe, 0.4, zf), (xs, 0.4, zf)]
                poly('paint', Frame(), q if up else q[::-1], c)
    crate(s, -10.2, 23.4, 1.2, 1.0)
    crate(s, 10.2, 23.0, 1.2, 1.0, yaw=0.3)
    # west lane
    container(s, -12.0, 9.0, False, CONTAINERS[0])
    container(s, -12.0, 17.2, False, CONTAINERS[2])
    container_detail(s, -12.0, 9.0, False, CONTAINERS[0])
    container_detail(s, -12.0, 17.2, False, CONTAINERS[2])
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
    container_detail(s, 12.0, 10.0, False, CONTAINERS[1])
    container_detail(s, 12.0, 18.2, False, CONTAINERS[3])
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
        column(s, x, z)


def build_layout():
    shell()
    floor_and_roof()
    stage()
    both(per_side)
    for x, z in LAMP_AT:
        hanging_lamp(x, z)
    depot_detail()
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


exec(open(os.path.join(REPO, 'scripts', 'blender', 'depotdetail.py')).read())

result = run_round(build_layout)
