"""
METRO: a subterranean station hub, generated in Blender. 56 by 46 m under one flat ceiling at 6.2 m.
Two tracks run the length of the hall with a train parked on each, an island platform between them
and a wide platform on the outside of each, lined with kiosks. In the middle of the island a walled
information hall with a doorway on each side is where the people hold out in survival.

Run inside Blender 4.2+ (see build_depot.py for the exec line), or with plain Python for plan mode.

The layout, south half (the north half is the same turned half a turn, trains included, so the two
trains stand offset along the hall):

    island         |z| < 6: a platform 0.24 m up, the information hall at its middle (walls 3 m, a
                   doorway on every side), columns, benches, vending machines, a stair-head alcove
                   at each end
    track          z 6..11: ballast and rails, a train of three cars on it (the cars are 10 m and
                   solid, with 2.6 m between them to cross through)
    outer platform z 11..23: columns, benches, planters and a kiosk against the wall

Heights: platforms 0.24 (a step), planters, barriers, crates 1.0 (a hop), info hall walls 3.0,
trains 3.6. The ceiling is the lowest thing overhead, 6.2 m, which is CEIL_Y.
"""
import math
import os

MAP = 'metro'
HX, HZ = 28.0, 23.0      # playable half extents
CEIL_Y = 6.2             # underside of the ceiling
K = 0.24                 # platform height
ISL, TRK, OUT0 = 6.0, 8.5, 11.0
T = 0.6

MATERIALS = {
    'ballast':  ((0.20, 0.19, 0.18), 3.0),
    'floor':    ((0.42, 0.42, 0.40), 3.0),     # platform granite
    'tile':     ((1.00, 1.00, 1.00), 2.0),     # wall tile and columns, tinted
    'concrete': ((0.50, 0.50, 0.48), 3.0),
    'ceil':     ((0.36, 0.37, 0.38), 4.0),     # ceiling and everything under it: no collider
    'steel':    ((0.30, 0.31, 0.33), 2.0),
    'train':    ((1.00, 1.00, 1.00), 2.0),     # carriage skin, tinted
    'wood':     ((0.45, 0.33, 0.22), 1.5),
    'rail':     ((0.12, 0.12, 0.13), 1.0),     # rails, sleepers, fittings: no collider
    'dark':     ((0.03, 0.03, 0.04), 1.0),
    'glass':    ((0.10, 0.14, 0.20), 1.0),
    'lines':    ((0.90, 0.72, 0.10), 4.0),
    'glow':     ((1.00, 0.95, 0.85), 1.0),
    'signblue': ((0.10, 0.35, 0.90), 1.0),
    'signgreen': ((0.10, 0.85, 0.35), 1.0),
    'signred':  ((0.95, 0.15, 0.10), 1.0),
    'foliage':  ((0.12, 0.30, 0.10), 1.0),
}
TINTED = {'tile', 'train'}
PROPS = {}
SMOOTH = set()
ROUND_N = 24
BEVEL = {'width': 0.035, 'angle': 55, 'segments': 1,
         'skip': {'lines', 'dark', 'glass', 'glow', 'signblue', 'signgreen', 'signred', 'rail'}}

exec(open(os.path.join(globals()['OVERRUN_REPO'], 'scripts', 'blender', 'mapkit.py')).read())
exec(open(os.path.join(globals()['OVERRUN_REPO'], 'scripts', 'blender', 'urbankit.py')).read())

CREAM, GREEN, ORANGE = srgb(0xd9d4c4), srgb(0x2f5d4a), srgb(0xe0701c)
SILVER, SILVER2, GREY = srgb(0xb9c0c6), srgb(0x8d959c), srgb(0x4a5058)
STOCK = [srgb(0xd8402a), srgb(0xe0b020), srgb(0x2a7ad8)]

SIDES = {
    'S': ('-z', (-HX - T, HX + T, HZ, HZ + T), (0, -1)),
    'N': ('+z', (-HX - T, HX + T, -HZ - T, -HZ), (0, 1)),
    'E': ('-x', (HX, HX + T, -HZ, HZ), (-1, 0)),
    'W': ('+x', (-HX - T, -HX, -HZ, HZ), (1, 0)),
}


def vlist(key, side, pts, e=0.01):
    """A polygon on a wall's inner face: pts = [(t, y)] counter-clockwise as seen from the hall."""
    face, box, _ = SIDES[side]
    L, P = face_fn(face, *box, e)
    poly(key, Frame(), [P(t, y) for t, y in pts])


def vrect(key, side, t0, t1, y0, y1, e=0.01):
    vlist(key, side, [(t0, y0), (t1, y0), (t1, y1), (t0, y1)], e)


def wbox(key, side, t0, t1, y0, y1, d, tint=WHITE, e0=0.0):
    """A visual box standing proud of a wall's inner face by d: mouldings, frames, capitals."""
    face, box, n = SIDES[side]
    a = face_fn(face, *box, e0)[1](t0, y0)
    b = face_fn(face, *box, e0 + d)[1](t1, y1)
    skip = ['-y'] if y0 < 0.01 else []
    skip.append(('-x' if n[0] > 0 else '+x') if n[0] else ('-z' if n[1] > 0 else '+z'))
    vbox(key, Frame(), (a[0] + b[0]) / 2, (y0 + y1) / 2, (a[2] + b[2]) / 2,
         abs(a[0] - b[0]), y1 - y0, abs(a[2] - b[2]), tint, tuple(skip))


POSTERS = [srgb(h) for h in (0xe0701c, 0x2a7ad8, 0xd8402a, 0xe0b020, 0x2f8a6a)]


# ------------------------------------------------------------------ shell, floor, ceiling

def shell():
    for name, (face, box, n) in SIDES.items():
        box_xz('concrete', *box, 0, CEIL_Y + 0.6, block=0)
        L, P = face_fn(face, *box)
        face_quad('tile', P, 0, L, 0.0, 1.2, GREEN)
        face_quad('tile', P, 0, L, 1.2, 3.3, CREAM)
        face_quad('lines', P, 0, L, 3.3, 3.42)
        k = 4.0
        while k < L - 1.0:                      # pilasters between the bays, visual only
            c = P(k, 0)
            vbox('concrete', Frame(c[0] + n[0] * 0.2, 0, c[2] + n[1] * 0.2), 0, CEIL_Y / 2, 0,
                 0.7 if n[0] == 0 else 0.4, CEIL_Y, 0.7 if n[1] == 0 else 0.4)
            ww, dd = (0.86, 0.5) if n[0] == 0 else (0.5, 0.86)
            pf = Frame(c[0] + n[0] * 0.25, 0, c[2] + n[1] * 0.25)
            vbox('concrete', pf, 0, 0.15, 0, ww, 0.3, dd)                  # plinth
            vbox('concrete', pf, 0, 0.33, 0, ww - 0.1, 0.06, dd - 0.1)
            vbox('concrete', pf, 0, CEIL_Y - 0.25, 0, ww, 0.5, dd)         # capital
            vbox('concrete', pf, 0, CEIL_Y - 0.58, 0, ww - 0.1, 0.16, dd - 0.1)
            k += 8.0
        # mouldings: skirting, the cap of the green wainscot, a two-step cornice
        wbox('concrete', name, 0, L, 0.0, 0.14, 0.05)
        wbox('concrete', name, 0, L, 1.2, 1.28, 0.035)
        wbox('concrete', name, 0, L, CEIL_Y - 0.45, CEIL_Y, 0.12)
        wbox('concrete', name, 0, L, CEIL_Y - 0.55, CEIL_Y - 0.45, 0.07)
        # tile seams: a grout line every 0.75 m and one across the middle of the cream band
        t = 0.75
        while t < L - 0.5:
            vrect('rail', name, t, t + 0.012, 1.28, 3.3, 0.02)
            t += 0.75
        vrect('rail', name, 0, L, 2.25, 2.262, 0.02)
        vrect('rail', name, 0, L, 0.6, 0.612, 0.02)
        t = 0.75
        while t < L - 0.5:
            vrect('rail', name, t, t + 0.012, 0.14, 1.2, 0.02)
            t += 0.75
        if name in ('N', 'S'):                   # lit posters in some of the bays
            k = 8.0
            while k < L - 5.0:
                x = (-HX - T + L - k) if name == 'S' else (-HX - T + k)
                if (name == 'S' and (-21.5 < x < -13.5 or 4.0 < x < 12.0)) or \
                        (name == 'N' and (13.5 < x < 21.5 or -12.0 < x < -4.0)):
                    k += 8.0
                    continue
                wbox('rail', name, k - 0.62, k + 0.62, 1.4, 3.2, 0.05)
                wbox('glow', name, k - 0.55, k + 0.55, 1.47, 3.13, 0.04, e0=0.03)
                Lp, Pp = face_fn(face, *box, 0.075)
                col = POSTERS[int(k / 8.0) % len(POSTERS)]
                poly('tile', Frame(), [Pp(k - 0.45, 1.75), Pp(k + 0.45, 1.75), Pp(k + 0.45, 2.55), Pp(k - 0.45, 2.55)], col)
                poly('tile', Frame(), [Pp(k - 0.45, 2.75), Pp(k + 0.45, 2.75), Pp(k + 0.45, 3.0), Pp(k - 0.45, 3.0)], POSTERS[(int(k / 8.0) + 2) % len(POSTERS)])
                k += 16.0


def floors():
    poly('ballast', Frame(), [(-HX, 0, HZ), (HX, 0, HZ), (HX, 0, -HZ), (-HX, 0, -HZ)])
    collider(Frame(), 0, -0.5, 0, 2 * HX + 1.2, 1.0, 2 * HZ + 1.2, block=0)
    box_xz('concrete', -HX, HX, -ISL, ISL, 0.0, K, top_key='floor', block=0)
    box_xz('concrete', -HX, HX, OUT0, HZ, 0.0, K, top_key='floor', block=0)
    box_xz('concrete', -HX, HX, -HZ, -OUT0, 0.0, K, top_key='floor', block=0)
    for z0, z1 in ((-ISL, -ISL + 0.55), (ISL - 0.55, ISL), (OUT0, OUT0 + 0.55), (-OUT0 - 0.55, -OUT0)):
        flat('lines', -HX, z0, HX, z1, K + 0.006)
    for zc in (0.0, (OUT0 + HZ) / 2, -(OUT0 + HZ) / 2):
        flat('lines', -HX + 1.0, zc - 0.06, HX - 1.0, zc + 0.06, K + 0.006)
    # expansion joints across the platforms, a drain grate in each bay of the outer platforms
    for za, zb in ((-ISL + 0.55, ISL - 0.55), (OUT0 + 0.55, HZ), (-HZ, -OUT0 - 0.55)):
        for x in range(-27, 28, 3):
            flat('dark', x - 0.012, za, x + 0.012, zb, K + 0.004)
    for x in range(-24, 25, 8):
        for z in (17.0, -17.0):
            flat('glass', x - 0.45, z - 0.2, x + 0.45, z + 0.2, K + 0.005)
            for g in range(7):
                flat('dark', x - 0.4 + g * 0.133, z - 0.17, x - 0.4 + g * 0.133 + 0.05, z + 0.17, K + 0.009)


def ceiling():
    slab('ceil', -HX - T, -HZ - T, HX + T, HZ + T, CEIL_Y, 0.4, block=0)
    for x in range(-24, 25, 8):                     # ribs
        vbox('ceil', Frame(), x, CEIL_Y - 0.3, 0, 0.7, 0.6, 2 * HZ, skip=())
    for z in (-15.0, -4.5, 4.5, 15.0):             # cross beams
        vbox('ceil', Frame(), 0, CEIL_Y - 0.2, z, 2 * HX, 0.4, 0.6, skip=())
    for z in (0.0, TRK, -TRK, 16.5, -16.5):         # light troughs
        for x in range(-20, 21, 8):
            vbox('rail', Frame(), x, CEIL_Y - 0.16, z, 3.4, 0.12, 0.5, skip=())
            vbox('glow', Frame(), x, CEIL_Y - 0.225, z, 3.2, 0.02, 0.34, skip=())
    for x in (-18.0, 0.0, 18.0):                    # hanging platform signs
        for z in (0.0, 16.5, -16.5):
            fr = Frame(x, 0, z)
            vbox('rail', fr, -0.9, CEIL_Y - 0.6, 0, 0.04, 1.2, 0.04, skip=())
            vbox('rail', fr, 0.9, CEIL_Y - 0.6, 0, 0.04, 1.2, 0.04, skip=())
            vbox('signgreen' if z == 0.0 else 'signblue', fr, 0, 4.7, 0, 2.2, 0.55, 0.12, skip=())
            vbox('rail', fr, 0, 4.7 + 0.29, 0, 2.34, 0.05, 0.16, skip=())      # frame around the sign
            vbox('rail', fr, 0, 4.7 - 0.29, 0, 2.34, 0.05, 0.16, skip=())
            for sx in (-1.12, 1.12):
                vbox('rail', fr, sx, 4.7, 0, 0.05, 0.63, 0.16, skip=())
    # pipes, ducts and cables under the slab; they run through the ribs and show in the gaps
    for z in (-12.8, -6.5, 6.5, 12.8):
        pipe('rail', (-HX, CEIL_Y - 0.17, z), (HX, CEIL_Y - 0.17, z), 0.07, 12)
        for x in range(-28, 29, 4):                  # pipe clamps
            vbox('rail', Frame(), x, CEIL_Y - 0.1, z, 0.1, 0.1, 0.18, skip=())
    for z in (-19.5, 19.5):                          # square ventilation duct with flanges
        vbox('ceil', Frame(), 0, CEIL_Y - 0.36, z, 2 * HX, 0.5, 0.75, skip=())
        for x in range(-28, 29, 4):
            vbox('ceil', Frame(), x, CEIL_Y - 0.36, z, 0.1, 0.58, 0.83, skip=())
    for z in (-7.3, 7.3):                            # a cable run
        for dz in (-0.05, 0.0, 0.05):
            pipe('rail', (-HX, CEIL_Y - 0.1, z + dz), (HX, CEIL_Y - 0.1, z + dz), 0.018, 6)
    for z in (-11.5, 11.5):                          # round vents
        for x in (-20, -4, 12):
            lathe('ceil', Frame(), x, z, [(0.0, CEIL_Y - 0.14), (0.48, CEIL_Y - 0.14), (0.52, CEIL_Y - 0.1), (0.52, CEIL_Y)], 24)
            lathe('dark', Frame(), x, z, [(0.0, CEIL_Y - 0.15), (0.4, CEIL_Y - 0.15)], 24)
            for a in range(6):
                th = a * math.pi / 3
                pipe('rail', (x, CEIL_Y - 0.17, z), (x + 0.4 * math.cos(th), CEIL_Y - 0.17, z + 0.4 * math.sin(th)), 0.012, 4)


# ------------------------------------------------------------------ track and trains

def track(s):
    z = s * TRK
    for dz in (-0.72, 0.72):
        vbox('rail', Frame(), 0, 0.1, z + dz, 2 * HX, 0.2, 0.07, skip=())
        vbox('rail', Frame(), 0, 0.2, z + dz, 2 * HX, 0.03, 0.14, skip=())
    x = -HX + 0.5
    while x < HX - 0.3:
        vbox('rail', Frame(), s * x, 0.05, z, 0.24, 0.1, 2.5, skip=('-y',))
        x += 0.7
    vbox('rail', Frame(), 0, 0.1, z + 1.35 * s, 2 * HX, 0.2, 0.18, skip=())


def car(s, x0, x1, ends):
    L = x1 - x0
    fr = F(s, (x0 + x1) / 2, TRK)
    W = 3.2
    collider(fr, 0, 1.8, 0, L, 3.6, W)
    vbox('train', fr, 0, 2.0, 0, L, 2.9, W, SILVER, skip=('-y',))
    vbox('train', fr, 0, 3.525, 0, L - 0.8, 0.15, W - 0.8, SILVER2, skip=('-y',))
    vbox('dark', fr, 0, 0.3, 0, L - 1.2, 0.6, W - 0.5, skip=('-y',))
    for bx in (-L / 2 + 1.7, L / 2 - 1.7):
        vbox('rail', fr, bx, 0.45, 0, 2.2, 0.5, W - 0.3, skip=('-y',))
    for side in (-1, 1):
        zf = side * (W / 2 + 0.012)

        def quad(xa, xb, ya, yb, z, key, tint=WHITE):
            q = [(xa, ya, z), (xb, ya, z), (xb, yb, z), (xa, yb, z)]
            poly(key, fr, q if side > 0 else q[::-1], tint)
        quad(-L / 2 + 0.05, L / 2 - 0.05, 1.15, 1.45, zf, 'train', ORANGE)
        quad(-L / 2 + 0.05, L / 2 - 0.05, 3.15, 3.3, zf, 'train', GREY)
        for cx, w in ((-4.2, 0.9), (-1.7, 1.4), (1.7, 1.4), (4.2, 0.9)):
            if abs(cx) + w / 2 <= L / 2 - 0.2:
                quad(cx - w / 2, cx + w / 2, 1.75, 2.85, zf + side * 0.004, 'glow')
        for cx in (-3.1, 3.1):
            if abs(cx) + 0.65 <= L / 2 - 0.2:
                quad(cx - 0.65, cx + 0.65, 0.7, 3.15, zf + side * 0.004, 'glass')
                zr = zf + side * 0.007
                for xa, xb in ((cx - 0.72, cx - 0.65), (cx + 0.65, cx + 0.72), (cx - 0.02, cx + 0.02)):
                    quad(xa, xb, 0.62, 3.2, zr, 'rail')
                quad(cx - 0.72, cx + 0.72, 3.15, 3.2, zr, 'rail')
                quad(cx - 0.72, cx + 0.72, 0.62, 0.7, zr, 'rail')
                for hx in (cx - 0.12, cx + 0.12):
                    quad(hx - 0.015, hx + 0.015, 1.4, 1.9, zr + side * 0.003, 'steel')
        for cx, w in ((-4.2, 0.9), (-1.7, 1.4), (1.7, 1.4), (4.2, 0.9)):
            if abs(cx) + w / 2 <= L / 2 - 0.2:
                zr = zf + side * 0.008
                quad(cx - w / 2 - 0.05, cx + w / 2 + 0.05, 2.85, 2.9, zr, 'rail')
                quad(cx - w / 2 - 0.05, cx + w / 2 + 0.05, 1.7, 1.75, zr, 'rail')
                quad(cx - w / 2 - 0.05, cx - w / 2, 1.7, 2.9, zr, 'rail')
                quad(cx + w / 2, cx + w / 2 + 0.05, 1.7, 2.9, zr, 'rail')
        for ex in (-1.3, 1.2):                      # underfloor equipment boxes, proud of the skirt
            vbox('steel', fr, ex, 0.34, side * 1.42, 1.4 if ex < 0 else 1.1, 0.3, 0.2, skip=())
            vbox('rail', fr, ex, 0.2, side * 1.42, 1.5 if ex < 0 else 1.2, 0.04, 0.24, skip=())
    for ax in (-2.6, 2.6):                          # roof air conditioning units
        vbox('steel', fr, ax, 3.71, 0, 1.8, 0.22, 1.5, skip=())
        for gx in range(-3, 4):
            vbox('rail', fr, ax + gx * 0.22, 3.83, 0, 0.04, 0.02, 1.3, skip=())
    for rz in (-0.95, 0.95):                        # roof pipe runs
        pipe('steel', fr.world((-L / 2 + 0.6, 3.65, rz)), fr.world((L / 2 - 0.6, 3.65, rz)), 0.035, 8)
    for sx, e in ((-1, ends[0]), (1, ends[1])):
        if e:
            xf = sx * (L / 2 + 0.012)
            q = [(xf, 1.5, -1.2), (xf, 1.5, 1.2), (xf, 3.1, 1.0), (xf, 3.1, -1.0)]
            poly('glass', fr, q[::-1] if sx > 0 else q)
            q2 = [(xf, 0.9, -1.0), (xf, 0.9, 1.0), (xf, 1.15, 1.0), (xf, 1.15, -1.0)]
            poly('glow', fr, q2[::-1] if sx > 0 else q2)
            for hz in (-0.85, 0.85):                # round headlamps
                pipe('glow', fr.world((xf, 0.62, hz)), fr.world((xf + sx * 0.05, 0.62, hz)), 0.13, 16, caps=True)
                pipe('rail', fr.world((xf, 0.62, hz)), fr.world((xf + sx * 0.03, 0.62, hz)), 0.17, 16, caps=True)


def trains():
    cars = [(-24.0, -14.0, (1, 0)), (-11.4, -1.4, (0, 0)), (1.2, 11.2, (0, 1))]
    for s in (1, -1):
        for x0, x1, ends in cars:
            car(s, x0, x1, ends)
        track(s)


# ------------------------------------------------------------------ furniture

def column(s, x, z):
    fr = F(s, x, z)
    cyl('tile', fr, 0, 0, 0.5, CEIL_Y, tint=CREAM)
    # a moulded base and a flared capital, turned in 24 sides like the shaft
    lathe('tile', fr, 0, 0, [(0.66, 0.0), (0.66, 0.05), (0.58, 0.1), (0.58, 0.16), (0.52, 0.21), (0.5, 0.23)], 24, CREAM, y0=K)
    vcyl('steel', fr, 0, 0, 0.56, 1.0, 1.12, n=24, top=False)
    lathe('ceil', fr, 0, 0, [(0.5, CEIL_Y - 1.0), (0.54, CEIL_Y - 0.9), (0.6, CEIL_Y - 0.72), (0.74, CEIL_Y - 0.5),
                             (0.8, CEIL_Y - 0.42), (0.8, CEIL_Y - 0.3), (0.86, CEIL_Y - 0.3), (0.86, CEIL_Y)], 24, CREAM)
    for a in (0.0, math.pi):
        c, sn = math.cos(a), math.sin(a)
        vbox('signblue', Frame(fr.o[0] + c * 0.53, 0, fr.o[2] + sn * 0.53, -a + math.pi / 2),
             0, 2.55, 0, 0.5, 0.34, 0.04, skip=())


def bench(s, x, z, along_x=True):
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2, K)
    collider(fr, 0, 0.22, 0, 2.2, 0.45, 0.5)
    vbox('wood', fr, 0, 0.42, 0, 2.2, 0.06, 0.5, skip=('-y',))
    for k in range(5):                              # slats laid on the seat
        vbox('wood', fr, 0, 0.452, -0.2 + k * 0.1, 2.2, 0.012, 0.085, skip=('-y',))
    for k in range(3):
        vbox('rail', fr, 0, 0.5 + k * 0.14, -0.22, 2.2, 0.1, 0.04, skip=())
    for sx in (-1, 1):
        vbox('steel', fr, sx * 0.95, 0.2, 0, 0.08, 0.4, 0.46, skip=('-y',))
        vbox('rail', fr, sx * 0.95, 0.52, -0.23, 0.06, 0.34, 0.04, skip=())
    for sx in (-1.1, -0.37, 0.37, 1.1):
        pipe('rail', (fr.world((sx, 0.36, -0.22))), (fr.world((sx, 0.36, 0.22))), 0.02, 6)


def vending(s, x, z, yaw=0.0):
    fr = F(s, x, z, yaw)
    solid('steel', fr, 0, 0.95, 0, 1.0, 1.9, 0.8)
    vbox('signblue', fr, 0, 1.2, -0.405, 0.8, 1.2, 0.02, skip=())
    vbox('glow', fr, 0, 0.35, -0.405, 0.8, 0.28, 0.02, skip=())
    vbox('glass', fr, 0, 1.35, -0.42, 0.62, 0.8, 0.01, skip=())            # product window
    for r in range(4):
        for c in range(3):
            vbox(('signred', 'glow', 'signgreen')[(r + c) % 3], fr, -0.2 + c * 0.2, 1.1 + r * 0.19, -0.428, 0.14, 0.12, 0.012, skip=())
    vbox('rail', fr, 0.38, 1.2, -0.42, 0.14, 0.5, 0.02, skip=())          # keypad column
    vbox('rail', fr, 0, 0.12, -0.42, 0.9, 0.2, 0.04, skip=())             # kick plate
    vbox('rail', fr, 0, 1.78, -0.41, 0.8, 0.03, 0.02, skip=())
    for k in range(5):                                                     # top vent slits
        vbox('rail', fr, 0, 1.8 + k * 0.022, -0.405, 0.7, 0.008, 0.02, skip=())


def planter(s, x, z, w=2.4, d=1.0, yaw=0.0):
    fr = F(s, x, z, yaw)
    solid('concrete', fr, 0, 0.5, 0, w, 1.0, d)
    vbox('foliage', fr, 0, 1.12, 0, w - 0.2, 0.25, d - 0.2, skip=('-y',))
    vbox('steel', fr, 0, 0.97, 0, w, 0.06, d)                    # coping round the rim
    n = max(2, int(w / 0.8))
    for k in range(n):
        bx = (k - (n - 1) / 2) * (w - 0.5) / max(1, n - 1) if n > 1 else 0.0
        r = 0.3 + 0.08 * ((k * 7) % 3)
        lathe('foliage', fr, bx, 0.0, [(r * math.cos(a), 1.2 + r * 0.9 * math.sin(a)) for a in (0, 0.35, 0.7, 1.05, 1.3, 1.5707)], 10)


def barrier(s, x, z, along_x=True, length=2.4):
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2)
    solid('concrete', fr, 0, 0.5, 0, length, 1.0, 0.6)
    for side in (-1, 1):                            # hazard stripes, slanting, and a reflector
        zf = side * 0.304
        k = -length / 2 + 0.1
        while k + 0.5 < length / 2:
            q = [(k, 0.62, zf), (k + 0.2, 0.62, zf), (k + 0.4, 0.88, zf), (k + 0.2, 0.88, zf)]
            poly('lines', fr, q if side > 0 else q[::-1])
            k += 0.4
        pipe('signred', fr.world((0, 0.4, zf)), fr.world((0, 0.4, zf + side * 0.02)), 0.05, 10, caps=True)


def board(s, x, z, yaw=0.0, w=2.2, h=3.0):
    fr = F(s, x, z, yaw)
    solid('steel', fr, 0, h / 2, 0, w, h, 0.22)
    for side in (-1, 1):
        vbox('signblue', fr, 0, h - 0.65, side * 0.12, w - 0.3, 0.7, 0.02, skip=())
        vbox('glow', fr, 0, h * 0.4, side * 0.12, w - 0.3, 1.1, 0.02, skip=())
        for fy, fh, fw in ((h - 0.65 + 0.37, 0.05, w - 0.2), (h - 0.65 - 0.37, 0.05, w - 0.2),
                           (h * 0.4 + 0.58, 0.05, w - 0.2), (h * 0.4 - 0.58, 0.05, w - 0.2)):
            vbox('rail', fr, 0, fy, side * 0.125, fw, fh, 0.03, skip=())          # frames round the panels
        for sx in (-(w - 0.2) / 2, (w - 0.2) / 2):
            vbox('rail', fr, sx, h - 0.65, side * 0.125, 0.05, 0.79, 0.03, skip=())
            vbox('rail', fr, sx, h * 0.4, side * 0.125, 0.05, 1.21, 0.03, skip=())
        vbox('rail', fr, 0, 0.12, side * 0.115, w - 0.1, 0.24, 0.02, skip=())    # kick plate
    for sx in (-w / 2 + 0.05, w / 2 - 0.05):                   # rounded corner posts
        pipe('rail', fr.world((sx, 0.0, 0.0)), fr.world((sx, h - 0.02, 0.0)), 0.13, 12)


def kiosk(s, cx, w=6.4):
    """A shopfront against the wall: side walls, a counter across most of the front, shelves on the
    back wall, a flat roof and a lit sign. Open at the right-hand end of the counter."""
    d = 3.6
    z0, z1 = HZ - d, HZ
    xa, xb = cx - w / 2, cx + w / 2
    box_xz('concrete', *rect(s, xa, xa + 0.25, z0, z1), 0.0, 2.7)
    box_xz('concrete', *rect(s, xb - 0.25, xb, z0, z1), 0.0, 2.7)
    box_xz('steel', *rect(s, xa + 0.25, xb - 2.2, z0, z0 + 0.45), 0.0, 1.0, top_key='wood')
    box_xz('concrete', *rect(s, xa - 0.1, xb + 0.1, z0 - 0.1, z1), 2.7, 3.0, skip=(), block=0)
    box_xz('wood', *rect(s, xa + 0.3, xb - 0.3, z1 - 0.6, z1 - 0.1), 0.0, 1.8)
    fr = F(s, cx, z0 - 0.12)
    vbox('signblue', fr, 0, 3.35, 0, w - 0.4, 0.6, 0.06, skip=())
    vbox('glow', fr, 0, 2.55, 0.5, w - 1.0, 0.04, 1.2, skip=())
    for k in range(3):
        vbox('train', F(s, cx - 1.8 + k * 1.8, z1 - 0.62), 0, 1.4, 0, 1.2, 0.3, 0.04, STOCK[k], skip=())
    # striped awning over the counter, slanting down towards the hall
    nst = int((w - 0.4) / 0.4)
    x0 = -nst * 0.4 / 2
    for i in range(nst):
        xa, xb = x0 + i * 0.4, x0 + (i + 1) * 0.4
        col = STOCK[0] if i % 2 == 0 else CREAM
        ak = 'signred' if i % 2 == 0 else 'glow'
        poly(ak, fr, [(xa, 2.62, 0.2), (xb, 2.62, 0.2), (xb, 2.3, -0.75), (xa, 2.3, -0.75)][::-1], col)
        poly(ak, fr, [(xa, 2.6, 0.2), (xb, 2.6, 0.2), (xb, 2.28, -0.75), (xa, 2.28, -0.75)], col)
        poly(ak, fr, [(xa, 2.3, -0.75), (xb, 2.3, -0.75), (xb, 2.15, -0.75), (xa, 2.15, -0.75)], col)
    pipe('rail', fr.world((x0, 2.28, -0.75)), fr.world((-x0, 2.28, -0.75)), 0.03, 8)
    for lx in (-w / 2 + 0.8, w / 2 - 0.8):                       # lamps on the awning's edge
        lathe('glow', fr, lx, -0.75, [(0.0, 2.0), (0.08, 2.02), (0.12, 2.1), (0.0, 2.2)], 10)
    vbox('steel', fr, 0, 2.63, 0.1, w - 0.6, 0.12, 0.14, skip=())      # roll-up shutter case


def stairhead(s):
    """A walled alcove at the end of the island: the way up is gated off, so it is a dead end."""
    xs = HX
    wall(s * -xs, s * -2.6, s * (-xs + 5.0), s * -2.6, 3.0, 0.5, 'concrete', top_key='steel')
    wall(s * -xs, s * 2.6, s * (-xs + 5.0), s * 2.6, 3.0, 0.5, 'concrete', top_key='steel')
    wall(s * (-xs + 5.0), s * -2.6, s * (-xs + 5.0), s * -1.1, 3.0, 0.5, 'concrete', top_key='steel')
    wall(s * (-xs + 5.0), s * 1.1, s * (-xs + 5.0), s * 2.6, 3.0, 0.5, 'concrete', top_key='steel')
    side = 'W' if s > 0 else 'E'
    vrect('dark', side, HZ - 2.1, HZ + 2.1, 0.0, 3.4)
    for r in range(7):
        y = 0.4 + r * 0.45
        vrect('rail', side, HZ - 2.1, HZ + 2.1, y, y + 0.05, 0.02)
    vrect('signgreen', side, HZ - 1.2, HZ + 1.2, 3.65, 4.05)
    face, box, _ = SIDES[side]
    Pb = face_fn(face, *box, 0.05)[1]
    for k in range(15):                                   # bars of the gate, with a frame
        t = HZ - 2.1 + 0.3 * k
        pipe('rail', Pb(t, 0.0), Pb(t, 3.4), 0.02, 6)
    pipe('rail', Pb(HZ - 2.1, 3.4), Pb(HZ + 2.1, 3.4), 0.05, 8)
    pipe('rail', Pb(HZ - 2.1, 0.0), Pb(HZ - 2.1, 3.4), 0.06, 8)
    pipe('rail', Pb(HZ + 2.1, 0.0), Pb(HZ + 2.1, 3.4), 0.06, 8)
    for ys in (0.3, 1.6):
        pipe('rail', Pb(HZ - 2.1, ys), Pb(HZ + 2.1, ys), 0.03, 6)

def tunnel_mouths():
    for side in ('E', 'W'):
        for zt in (TRK, -TRK):
            u = (HZ + zt) if side == 'E' else (HZ - zt)
            pts = [(u - 2.0, 0.0), (u + 2.0, 0.0), (u + 2.0, 3.4)]
            for i in range(1, 8):
                a = math.pi * i / 8
                pts.append((u + 2.0 * math.cos(a), 3.4 + 1.1 * math.sin(a)))
            pts.append((u - 2.0, 3.4))
            vlist('dark', side, pts)
            # a moulded stone surround: two jambs and an arch of 16 voussoirs, a keystone on top
            ro = 2.4
            for i in range(16):
                a0, a1 = math.pi * i / 16, math.pi * (i + 1) / 16
                vlist('concrete', side, [(u + 2.0 * math.cos(a0), 3.4 + 1.1 * math.sin(a0)),
                                         (u + ro * math.cos(a0), 3.4 + (ro - 0.9) * math.sin(a0) + 0.0),
                                         (u + ro * math.cos(a1), 3.4 + (ro - 0.9) * math.sin(a1)),
                                         (u + 2.0 * math.cos(a1), 3.4 + 1.1 * math.sin(a1))][::1], 0.025)
            vlist('concrete', side, [(u + 2.0, 0.0), (u + ro, 0.0), (u + ro, 3.4), (u + 2.0, 3.4)], 0.025)
            vlist('concrete', side, [(u - ro, 0.0), (u - 2.0, 0.0), (u - 2.0, 3.4), (u - ro, 3.4)], 0.025)
            wbox('concrete', side, u - 0.28, u + 0.28, 4.35, 4.85, 0.07)
            for tz in (u - 2.2, u + 2.2):
                wbox('concrete', side, tz - 0.3, tz + 0.3, 0.0, 0.3, 0.06)
            vrect('rail', side, u - 2.2, u - 2.0, 0.0, 3.4, 0.02)
            vrect('signred', side, u + 2.5, u + 2.75, 3.0, 3.25, 0.02)
            vrect('signgreen', side, u + 2.5, u + 2.75, 2.6, 2.85, 0.02)


# ------------------------------------------------------------------ the information hall

def info_hall():
    R, G, h, t = 4.2, 1.2, 3.0, 0.5
    for sz in (-1, 1):
        for sx in (-1, 1):
            wall(sx * G, sz * R, sx * (R + t / 2), sz * R, h, t, 'concrete', top_key='steel')
            wall(sx * R, sz * G, sx * R, sz * (R - t / 2), h, t, 'concrete', top_key='steel')
    # no furniture inside: the people stand there. A painted cross on the floor and a hanging sign.
    flat('lines', -1.6, -0.06, 1.6, 0.06, K + 0.006)
    flat('lines', -0.06, -1.6, 0.06, 1.6, K + 0.006)
    vbox('rail', Frame(), 0, CEIL_Y - 0.7, 0, 0.05, 1.4, 0.05, skip=())
    vbox('signblue', Frame(), 0, 4.4, 0, 1.4, 0.45, 1.4, skip=())
    lathe('ceil', Frame(), 0, 0, [(0.0, CEIL_Y - 0.12), (1.5, CEIL_Y - 0.12), (1.58, CEIL_Y - 0.08), (1.58, CEIL_Y)], 32)
    lathe('glow', Frame(), 0, 0, [(0.0, CEIL_Y - 0.125), (1.4, CEIL_Y - 0.125)], 32)
    for k in range(4):                          # a conduit run down to each doorway's lintel
        a = k * math.pi / 2 + math.pi / 4
        pipe('rail', (0.2 * math.cos(a), CEIL_Y - 0.4, 0.2 * math.sin(a)), (1.4 * math.cos(a), CEIL_Y - 0.1, 1.4 * math.sin(a)), 0.03, 8)
    for k in range(4):
        a = k * math.pi / 2
        # green plates flush on the outer wall face either side of each doorway
        fr = Frame(0, 0, 0, -a + math.pi / 2)
        for tx in (-(G + 0.55), G + 0.55):
            vbox('signgreen', fr, tx, 2.3, R + 0.26, 0.7, 0.4, 0.02, skip=())

def island(s):
    column(s, 12.0, 0.0)
    column(s, 20.0, 0.0)
    bench(s, 9.5, 3.4, True)
    bench(s, 16.0, -3.4, True)
    vending(s, 11.0, 5.0, 0.0)
    vending(s, 14.0, -4.9, math.pi)
    barrier(s, 8.5, -2.4, False, 2.2)
    board(s, 17.0, 1.0, 0.0, 1.8, 2.8)
    planter(s, 21.0, -3.4, 2.0, 0.9, 0.0)


def outer(s):
    for x in (-24.0, -16.0, -8.0, 0.0, 8.0, 16.0, 24.0):
        column(s, x, 15.0)
    kiosk(s, -17.5)
    kiosk(s, 8.0)
    bench(s, -12.0, 12.4, True)
    bench(s, 4.0, 17.2, True)
    bench(s, 14.5, 12.8, True)
    planter(s, -3.5, 13.5, 2.6, 1.0)
    planter(s, 11.5, 15.8, 2.0, 1.0, math.pi / 2)
    planter(s, 24.5, 19.5, 2.4, 1.0)
    vending(s, -26.5, 21.8, math.pi)
    vending(s, 21.0, 21.8, math.pi)
    barrier(s, -9.5, 18.0, True, 2.4)
    barrier(s, 18.5, 14.0, False, 2.4)
    board(s, -4.5, 19.0, 0.0, 2.4, 2.9)
    crate(s, 25.5, 12.8, 1.2, 1.0)
    crate(s, 25.7, 14.1, 1.0, 1.0, yaw=0.4)
    crate(s, 25.5, 12.9, 1.0, 1.0, base=1.0, yaw=0.3)
    crate(s, -26.0, 17.6, 1.2, 1.0)


def build_layout():
    shell()
    floors()
    ceiling()
    trains()
    tunnel_mouths()
    info_hall()
    both(island)
    both(outer)
    both(stairhead)


result = run(build_layout)
