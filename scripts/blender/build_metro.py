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
            k += 8.0


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
    for sx, e in ((-1, ends[0]), (1, ends[1])):
        if e:
            xf = sx * (L / 2 + 0.012)
            q = [(xf, 1.5, -1.2), (xf, 1.5, 1.2), (xf, 3.1, 1.0), (xf, 3.1, -1.0)]
            poly('glass', fr, q[::-1] if sx > 0 else q)
            q2 = [(xf, 0.9, -1.0), (xf, 0.9, 1.0), (xf, 1.15, 1.0), (xf, 1.15, -1.0)]
            poly('glow', fr, q2[::-1] if sx > 0 else q2)


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
    vcyl('steel', fr, 0, 0, 0.56, 0.0, 0.3, n=12)
    vcyl('steel', fr, 0, 0, 0.56, 1.0, 1.12, n=12, top=False)
    vcyl('ceil', fr, 0, 0, 0.62, CEIL_Y - 0.5, CEIL_Y, n=12, r1=0.5, top=False)
    for a in (0.0, math.pi):
        c, sn = math.cos(a), math.sin(a)
        vbox('signblue', Frame(fr.o[0] + c * 0.53, 0, fr.o[2] + sn * 0.53, -a + math.pi / 2),
             0, 2.55, 0, 0.5, 0.34, 0.04, skip=())


def bench(s, x, z, along_x=True):
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2, K)
    collider(fr, 0, 0.22, 0, 2.2, 0.45, 0.5)
    vbox('wood', fr, 0, 0.42, 0, 2.2, 0.06, 0.5, skip=('-y',))
    vbox('rail', fr, 0, 0.64, -0.22, 2.2, 0.4, 0.05, skip=('-y',))
    for sx in (-1, 1):
        vbox('steel', fr, sx * 0.95, 0.2, 0, 0.08, 0.4, 0.46, skip=('-y',))


def vending(s, x, z, yaw=0.0):
    fr = F(s, x, z, yaw)
    solid('steel', fr, 0, 0.95, 0, 1.0, 1.9, 0.8)
    vbox('signblue', fr, 0, 1.2, -0.405, 0.8, 1.2, 0.02, skip=())
    vbox('glow', fr, 0, 0.35, -0.405, 0.8, 0.28, 0.02, skip=())


def planter(s, x, z, w=2.4, d=1.0, yaw=0.0):
    fr = F(s, x, z, yaw)
    solid('concrete', fr, 0, 0.5, 0, w, 1.0, d)
    vbox('foliage', fr, 0, 1.12, 0, w - 0.2, 0.25, d - 0.2, skip=('-y',))


def barrier(s, x, z, along_x=True, length=2.4):
    solid('concrete', F(s, x, z, 0.0 if along_x else math.pi / 2), 0, 0.5, 0, length, 1.0, 0.6)


def board(s, x, z, yaw=0.0, w=2.2, h=3.0):
    fr = F(s, x, z, yaw)
    solid('steel', fr, 0, h / 2, 0, w, h, 0.22)
    for side in (-1, 1):
        vbox('signblue', fr, 0, h - 0.65, side * 0.12, w - 0.3, 0.7, 0.02, skip=())
        vbox('glow', fr, 0, h * 0.4, side * 0.12, w - 0.3, 1.1, 0.02, skip=())


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
