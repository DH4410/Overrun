"""
METRO detail pass: station signage, line maps, clocks, train livery and interiors, tactile paving,
track fittings, and the small hardware on the walls, columns and furniture.

Exec'd by build_metro.py after its own helpers, so it shares that namespace (poly, vbox, pipe,
lathe, F, K, HX, HZ, ...). Nothing here emits a collider, so metro.json and the map hash do not change.

Three keys carry all of it, and the ghost probes look at none of them:

    fit     small hardware: brackets, cameras, clips, cabinets (tinted per piece, slightly metallic)
    mark    matte decals: plates, paint, stains, tactile studs (Lambert, polygon offset, tinted)
    glyph   lit decals: sign text, LED boards, clock faces (unlit, polygon offset, tinted)

Text is the 5x7 face of markkit.py merged into runs of quads. Decals that overlap are layered at
least 4 mm apart, since each key shares one polygon offset.
"""
import re as _re

# urbankit.py owns the name `rect` (the kiosk uses it); the decal kit's rect becomes `mrect`.
exec(_re.sub(r'\brect\(', 'mrect(',
             open(os.path.join(globals()['OVERRUN_REPO'], 'scripts', 'blender', 'markkit.py')).read()))

M_WHT = srgb(0xe9e7dc)
M_BLK = srgb(0x15171a)
M_PLATE = srgb(0x0e1013)
M_BLUE = srgb(0x15335f)
M_RED = srgb(0xb8342a)
M_YEL = srgb(0xd8b422)
M_GRN = srgb(0x2f7a55)
M_DGRN = srgb(0x1f4a3a)
M_CREAM = srgb(0xe8e3d2)
M_GREY = srgb(0x70757a)
M_STEEL = srgb(0x474d54)
M_LIGHT = srgb(0xa8aeb4)
M_AMBER = srgb(0xffb02e)
M_LEDGRN = srgb(0x40e070)
M_STUD = srgb(0x7a5c10)
M_STAIN = srgb(0x585650)
M_GLASSD = srgb(0x121a26)
M_FACE = srgb(0xf4f1e6)
LINE_RED, LINE_BLUE, LINE_GREEN = srgb(0xd8402a), srgb(0x2a7ad8), srgb(0x2f9a5a)
JACKETS = [srgb(h) for h in (0x2a2d33, 0x5a3a2a, 0x2a3f5a, 0x4a4f55, 0x6a2f2f, 0x3a4a3a)]

_rs = [8675309]


def rnd():
    """A deterministic 0..1 stream, so a rebuild is byte for byte the same."""
    _rs[0] = (_rs[0] * 1103515245 + 12345) & 0x7FFFFFFF
    return _rs[0] / 0x7FFFFFFF


def pbox(key, fr, cx, cy, cz, w, h, d, tint=WHITE, skip=()):
    """A visual box, all six faces unless skipped: the parts here are small and loose."""
    vbox(key, fr, cx, cy, cz, w, h, d, tint, skip)


def sub(fr, x, y, z, d=0.0):
    """A frame at local (x, y, z) of fr, turned d about the vertical."""
    wx, wy, wz = fr.world((x, y, z))
    return Frame(wx, wy, wz, fr.yaw + d)


def label(fr, u, y, z, text, ph, tint):
    """Painted text, centred on u (the atlas face; markkit's pixel runs are not used here)."""
    type_label(fr, u, y, z, text, ph, tint, 'tmark')


def floor_label(fr, text, ph, tint):
    type_floor(fr, text, ph, tint, 'tmark')


def glabel(fr, u, y, z, text, ph, tint):
    """Lit text, centred on u."""
    type_label(fr, u, y, z, text, ph, tint, 'tglyph')


def glabel_l(fr, u, y, z, text, ph, tint):
    """Lit text, left edge at u."""
    glabel(fr, u + text_w(text, ph) / 2, y, z, text, ph, tint)


def glabel_r(fr, u, y, z, text, ph, tint):
    glabel(fr, u - text_w(text, ph) / 2, y, z, text, ph, tint)


def fw(text, maxw, ph):
    """The letter height that makes text fit maxw, capped at ph."""
    return min(ph, maxw * 7.0 / (len(text) * 6 - 1))


def circle(fr, u, y, z, r, tint, key='mark', n=16):
    poly(key, fr, [(u + r * math.cos(2 * math.pi * i / n), y + r * math.sin(2 * math.pi * i / n), z) for i in range(n)], tint)


def quadp(fr, pts, z, tint, key='mark'):
    """A polygon from 2-D points in the frame's x-y, wound to face +z."""
    p3 = [(x, y, z) for x, y in pts]
    if newell(p3)[2] < 0:
        p3.reverse()
    poly(key, fr, p3, tint)


def seg(fr, a, b, th, z, tint, key='mark'):
    dx, dy = b[0] - a[0], b[1] - a[1]
    ln = math.hypot(dx, dy)
    if ln < 1e-6:
        return
    nx, ny = -dy / ln * th / 2, dx / ln * th / 2
    quadp(fr, [(a[0] + nx, a[1] + ny), (b[0] + nx, b[1] + ny), (b[0] - nx, b[1] - ny), (a[0] - nx, a[1] - ny)], z, tint, key)


def tube_world(key, fr, a, b, r, tint, n=6, caps=False):
    pipe(key, fr.world(a), fr.world(b), r, n, tint, caps)


def floor_quad(x0, z0, x1, z1, y, tint):
    upoly(Frame(), [(x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1)], tint)


# ------------------------------------------------------------------ wall pieces

def frieze(fr, u, w):
    """The station name plate over the cream band: blue, a rule either side, arrows at the ends."""
    hw = w / 2
    mrect(fr, u - hw, 3.72, u + hw, 4.22, 0.006, M_BLUE)
    mrect(fr, u - hw, 4.22, u + hw, 4.245, 0.006, M_YEL)
    mrect(fr, u - hw, 3.695, u + hw, 3.72, 0.006, M_YEL)
    ph = fw('CENTRAL', max(1.0, w - 1.6), 0.3)
    glabel(fr, u, 3.97 - ph / 2, 0.012, 'CENTRAL', ph, M_WHT)
    if w > 3.8:
        for sx, ch in ((-1, '<'), (1, '>')):
            glabel(fr, u + sx * (hw - 0.45), 3.97 - 0.15, 0.012, ch, 0.3, M_AMBER)


POSTER_WORDS = (('CONCERT', 'NOW'), ('CIRCUS', 'LIVE'), ('FERRIES', 'NEW'), ('MUSEUM', 'OPEN'), ('MARKET', 'SALE'))


def poster_detail(fr, u, idx):
    """Type and a sun on the lit poster frames the shell already put up (tile quads at z 0.075)."""
    word, top = POSTER_WORDS[idx % len(POSTER_WORDS)]
    label(fr, u, 2.8, 0.083, top, fw(top, 0.7, 0.16), M_WHT)
    circle(fr, u, 2.27, 0.083, 0.17, M_WHT, n=14)
    circle(fr, u, 2.27, 0.088, 0.11, srgb(0xe8c040), n=14)
    label(fr, u, 1.86, 0.083, word, fw(word, 0.8, 0.22), M_WHT)
    glabel(fr, u, 1.55, 0.077, 'CITY LIFE', fw('CITY LIFE', 0.9, 0.1), M_BLK)


def clock(fr, u, y, r=0.35):
    pipe('fit', fr.world((u, y, 0.0)), fr.world((u, y, 0.07)), r + 0.04, 20, M_STEEL, True)
    circle(fr, u, y, 0.074, r, M_FACE, 'glyph', 20)
    for i in range(12):
        a = math.radians(i * 30)
        r0 = r * (0.78 if i % 3 == 0 else 0.86)
        seg(fr, (u + r0 * math.sin(a), y + r0 * math.cos(a)), (u + r * 0.94 * math.sin(a), y + r * 0.94 * math.cos(a)),
            0.05 if i % 3 == 0 else 0.028, 0.079, M_BLK, 'glyph')
    for deg, ln, th in ((305.0, 0.5, 0.05), (60.0, 0.78, 0.034)):       # ten past ten
        a = math.radians(deg)
        seg(fr, (u, y), (u + r * ln * math.sin(a), y + r * ln * math.cos(a)), th, 0.084, M_BLK, 'glyph')
    circle(fr, u, y, 0.088, 0.035, M_RED, 'glyph', 8)


def linemap(fr, u, y, w, h, name_here='CENTRAL'):
    """A framed route diagram: cream field, three coloured lines crossing, nodes and names."""
    pbox('fit', fr, u, y + h / 2, 0.03, w + 0.12, h + 0.12, 0.06, M_STEEL)
    mrect(fr, u - w / 2, y, u + w / 2, y + h, 0.068, M_CREAM)
    mrect(fr, u - w / 2, y + h - 0.2, u + w / 2, y + h, 0.073, M_BLUE)
    label(fr, u, y + h - 0.15, 0.078, 'LINE MAP', fw('LINE MAP', w - 0.4, 0.12), M_WHT)
    by0, by1 = y + 0.18, y + h - 0.3
    yc, hh = (by0 + by1) / 2, by1 - by0
    sx, sy = w / 2 - 0.3, hh / 2 - 0.05

    def P(nx, ny):
        return (u + nx * sx, yc + ny * sy)
    lines = ((LINE_RED, [(-1, 0), (1, 0)]),
             (LINE_BLUE, [(-0.6, 0.9), (-0.6, 0.35), (-0.3, 0.0), (0.0, -0.45), (0.0, -0.9)]),
             (LINE_GREEN, [(0.45, 0.9), (0.45, -0.55), (0.75, -0.85), (1.0, -0.85)]))
    for i, (col, pts) in enumerate(lines):
        for a, b in zip(pts, pts[1:]):
            seg(fr, P(*a), P(*b), 0.05, 0.080 + i * 0.004, col)
    hx, hy = P(-0.3, 0.0)                                       # you are here: a ring round the node
    circle(fr, hx, hy, 0.090, 0.1, M_RED, n=14)
    nodes = (((-1, 0), 'DOCKS', 1), ((-0.3, 0), name_here, 1), ((0.45, 0), 'PARK', 1), ((1, 0), 'AIRPORT', 1),
             ((-0.6, 0.9), 'NORTH', -1), ((0.0, -0.9), 'OLD TOWN', 1), ((0.45, 0.9), 'HARBOUR', -1))
    for (nx, ny), nm, side in nodes:
        px, py = P(nx, ny)
        mrect(fr, px - 0.055, py - 0.055, px + 0.055, py + 0.055, 0.094, M_BLK)
        mrect(fr, px - 0.04, py - 0.04, px + 0.04, py + 0.04, 0.098, M_WHT)
        ph = fw(nm, 0.7, 0.07)
        px2 = min(max(px, u - w / 2 + text_w(nm, ph) / 2 + 0.05), u + w / 2 - text_w(nm, ph) / 2 - 0.05)
        label(fr, px2, py + (0.09 if side > 0 else -0.09 - ph), 0.094, nm, ph, M_BLK)


def timetable(fr, u, y, w=1.7, h=1.0):
    pbox('fit', fr, u, y + h / 2, 0.04, w + 0.1, h + 0.1, 0.08, M_BLK)
    mrect(fr, u - w / 2, y, u + w / 2, y + h, 0.084, M_PLATE)
    glabel(fr, u, y + h - 0.2, 0.09, 'NEXT TRAINS', fw('NEXT TRAINS', w - 0.2, 0.11), M_WHT)
    rows = (('1 HARBOUR', '2'), ('2 AIRPORT', '5'), ('1 NORTH', '9'), ('2 DOCKS', '12'))
    for i, (nm, mn) in enumerate(rows):
        yy = y + h - 0.42 - i * 0.2
        glabel_l(fr, u - w / 2 + 0.1, yy, 0.09, nm, 0.09, M_AMBER)
        glabel_r(fr, u + w / 2 - 0.1, yy, 0.09, mn + ' MIN', 0.09, M_AMBER)


def firepoint(fr, u):
    pbox('fit', fr, u, 1.35, 0.14, 0.62, 0.9, 0.28, M_RED)
    mrect(fr, u - 0.24, 1.2, u + 0.24, 1.7, 0.286, M_GLASSD)
    mrect(fr, u - 0.22, 0.96, u + 0.22, 1.12, 0.29, M_WHT)
    label(fr, u, 0.99, 0.295, 'FIRE', 0.1, M_RED)
    ex = u + 0.62
    lathe('fit', fr, ex, 0.1, [(0.1, 0.0), (0.11, 0.04), (0.11, 0.5), (0.07, 0.6), (0.04, 0.66), (0.0, 0.66)], 10, M_RED, 0.75)
    pbox('fit', fr, ex, 1.1, 0.04, 0.05, 0.4, 0.08, M_STEEL)
    mrect(fr, u - 0.25, 1.9, u + 0.25, 2.4, 0.03, M_RED)
    label(fr, u, 2.04, 0.036, 'FIRE', 0.14, M_WHT)
    label(fr, u, 2.24, 0.036, 'POINT', 0.08, M_WHT)


def firstaid(fr, u):
    mrect(fr, u - 0.3, 1.5, u + 0.3, 2.1, 0.03, M_GRN)
    mrect(fr, u - 0.07, 1.68, u + 0.07, 2.02, 0.036, M_WHT)
    mrect(fr, u - 0.17, 1.78, u + 0.17, 1.92, 0.036, M_WHT)
    label(fr, u, 1.55, 0.036, 'FIRST AID', fw('FIRST AID', 0.5, 0.07), M_WHT)
    pbox('fit', fr, u, 1.05, 0.1, 0.5, 0.36, 0.2, M_WHT)
    mrect(fr, u - 0.06, 1.0, u + 0.06, 1.1, 0.205, M_GRN)
    mrect(fr, u - 0.02, 0.96, u + 0.02, 1.14, 0.21, M_WHT)


def phone(fr, u):
    pbox('fit', fr, u, 1.5, 0.07, 0.32, 0.52, 0.14, M_YEL)
    mrect(fr, u - 0.12, 1.5, u + 0.12, 1.66, 0.145, M_BLK)
    label(fr, u, 1.7, 0.145, 'HELP', 0.07, M_BLK)
    for r in range(2):
        for c in range(3):
            mrect(fr, u - 0.1 + c * 0.075, 1.32 + r * 0.07, u - 0.05 + c * 0.075, 1.37 + r * 0.07, 0.15, M_PLATE)
    pbox('fit', fr, u - 0.2, 1.5, 0.1, 0.06, 0.34, 0.08, M_BLK)
    pbox('signred', fr, u, 1.84, 0.07, 0.07, 0.07, 0.07, WHITE)


def louvre(fr, u, y, w=0.9, h=0.5):
    pbox('fit', fr, u, y, 0.03, w + 0.1, h + 0.1, 0.06, M_STEEL)
    mrect(fr, u - w / 2, y - h / 2, u + w / 2, y + h / 2, 0.066, M_BLK)
    for i in range(int(h / 0.07)):
        mrect(fr, u - w / 2, y - h / 2 + 0.05 + i * 0.07, u + w / 2, y - h / 2 + 0.065 + i * 0.07, 0.07, M_GREY)


def speaker(fr, u, y, z):
    pbox('fit', fr, u, y, z, 0.22, 0.22, 0.26, M_LIGHT)
    pbox('fit', fr, u, y, z + 0.14, 0.16, 0.16, 0.04, M_BLK)


def camera(fr, u, y, z0, aim):
    """A dome-and-arm camera on a bracket, aimed along aim (about the wall's vertical)."""
    mt = sub(fr, u, y, z0, aim)
    pbox('fit', mt, 0, 0, 0.1, 0.07, 0.07, 0.2, M_STEEL)
    pbox('fit', mt, 0, -0.03, 0.3, 0.13, 0.12, 0.3, M_GREY)
    pipe('fit', mt.world((0, -0.03, 0.44)), mt.world((0, -0.03, 0.5)), 0.055, 8, M_BLK, True)
    pbox('signred', mt, 0.06, 0.01, 0.2, 0.02, 0.02, 0.02, WHITE)


def cable_tray(fr, u0, u1, y=5.3, z=0.75):
    """A cable tray on brackets along the wall, in front of the pilasters and under the capitals."""
    ln, uc = u1 - u0, (u0 + u1) / 2
    pbox('fit', fr, uc, y, z, ln, 0.04, 0.34, M_STEEL)
    for sz in (-1, 1):
        pbox('fit', fr, uc, y + 0.06, z + sz * 0.17, ln, 0.1, 0.03, M_STEEL)
    for dz, col in ((-0.1, M_BLK), (0.0, M_RED), (0.1, M_GREY)):
        tube_world('fit', fr, (u0, y + 0.06, z + dz), (u1, y + 0.06, z + dz), 0.026, col, 6)
    k = u0 + 1.0
    while k < u1:
        pbox('fit', fr, k, y - 0.06, z / 2, 0.05, 0.05, z, M_STEEL)
        pbox('fit', fr, k, y - 0.025, z, 0.05, 0.05, 0.38, M_STEEL)
        k += 2.4


# ------------------------------------------------------------------ the four walls

_WALLS = {'S': (0.0, HZ, math.pi), 'N': (0.0, -HZ, 0.0), 'E': (HX, 0.0, -math.pi / 2), 'W': (-HX, 0.0, math.pi / 2)}


def WF(side):
    """The frame on a wall's inner face: local +z into the hall, +x to the right of someone facing it."""
    x, z, yaw = _WALLS[side]
    return Frame(x, 0.0, z, yaw)


def bays(half, pil):
    edges = [-half] + pil + [half]
    out = []
    for i, (a, b) in enumerate(zip(edges, edges[1:])):
        out.append((a + (0.05 if i == 0 else 0.45), b - (0.05 if i == len(edges) - 2 else 0.45)))
    return out


def mouths_of(side):
    """(local u of the arch's centre, track number) for the two tunnel mouths on an end wall."""
    if side == 'E':
        return ((TRK, 1), (-TRK, 2))
    return ((-TRK, 1), (TRK, 2))


def tunnel_rings(fr, um):
    """Three smaller arches inside the dark mouth, so the bore reads as going away."""
    col = srgb(0x2a2e34)
    base = [(2.0, 0.0), (2.0, 3.4)] + [(2.0 * math.cos(math.pi * i / 8), 3.4 + 1.1 * math.sin(math.pi * i / 8)) for i in range(1, 8)] \
        + [(-2.0, 3.4), (-2.0, 0.0)]
    cy = 0.0
    for k, sc in enumerate((0.8, 0.6, 0.42)):
        pts = [(um + x * sc, cy + (y - cy) * sc) for x, y in base]
        for a, b in zip(pts, pts[1:]):
            seg(fr, a, b, 0.07 * sc, 0.016 + k * 0.004, col)
        crown = cy + (4.5 - cy) * sc
        pbox('glow', fr, um, crown - 0.12, 0.02 + k * 0.004, 0.14 * sc + 0.06, 0.05, 0.01, WHITE)


def wall_detail(side):
    fr = WF(side)
    ns = side in ('N', 'S')
    pil = [-24.6 + 8 * i for i in range(7)] if ns else [-19 + 8 * i for i in range(6)]
    bl = bays(28.6 if ns else 23.0, pil)
    for a, b in bl:                                 # a darker green accent under the wainscot's cap
        if b - a > 1.5:
            mrect(fr, a, 0.92, b, 1.16, 0.026, M_DGRN)
    for a, b in bl:                                 # the name plate in every bay the arch and gate leave
        c, w = (a + b) / 2, b - a
        if w < 3.0:
            continue
        if not ns and (abs(c + 7.0) < 0.3 or abs(c - 9.0) < 0.3 or abs(c - 1.0) < 0.3):
            continue
        frieze(fr, c, min(5.6, w - 0.5))
    lim = 26.0 if ns else 20.8
    cable_tray(fr, -lim, lim)
    for i, p in enumerate(pil):                     # a camera on every other pilaster, a speaker on each
        if i % 2 == 0:
            camera(fr, p, 3.3, 0.4, 0.55 if p < 0 else -0.55)
        speaker(fr, p, 4.5, 0.52)
    if ns:
        for i, u in enumerate((-20.6, 3.4)):
            poster_detail(fr, u, i + (0 if side == 'S' else 2))
            clock(fr, u, 4.75)
        linemap(fr, -13.6, 1.45, 2.4, 1.4)
        phone(fr, -2.9)
        firepoint(fr, -2.0)
        timetable(fr, 10.8, 1.6)
        clock(fr, 11.0, 4.75)
        firstaid(fr, 21.9)
        phone(fr, 25.7)
        firstaid(fr, -26.8)
        for u in (-26.8, 26.2, -4.6):
            louvre(fr, u, 4.55, 1.8, 0.4)
    else:
        firstaid(fr, -21.2)
        louvre(fr, -21.2, 4.55, 1.6, 0.4)
        linemap(fr, -15.0, 1.35, 3.2, 1.6)
        clock(fr, -15.0, 4.75)
        timetable(fr, 17.0, 1.55)
        phone(fr, 19.4)
        firepoint(fr, 14.6)
        clock(fr, 17.0, 4.75)
        for um, tn in mouths_of(side):              # a track plate over each arch, a backing behind its lamps
            mrect(fr, um - 0.9, 5.0, um + 0.9, 5.45, 0.012, M_BLUE)
            glabel(fr, um, 5.225 - 0.1, 0.018, 'TRACK %d' % tn, 0.2, M_WHT)
            label(fr, um, 4.43, 0.08, 'T%d' % tn, 0.28, M_WHT)
            pbox('fit', fr, um + 2.625, 2.9, 0.008, 0.42, 1.02, 0.016, M_BLK)
            tunnel_rings(fr, um)
        # the stair gate: the sign says exit, the notice says otherwise
        glabel(fr, 0.0, 3.76, 0.018, 'EXIT', 0.26, M_WHT)
        mrect(fr, -0.95, 1.75, 0.95, 2.25, 0.078, M_RED)
        circle(fr, -0.62, 2.0, 0.082, 0.17, M_WHT)
        mrect(fr, -0.76, 1.97, -0.48, 2.03, 0.086, M_RED)
        label(fr, 0.2, 1.93, 0.082, 'CLOSED', fw('CLOSED', 1.0, 0.15), M_WHT)


# ------------------------------------------------------------------ floor, platform edges, track

def arrow_floor(x, z, d, tint):
    """A boarding arrow painted on the platform at world (x, z), pointing along z by d (+-1)."""
    pts = [(x - 0.07, 0.0), (x + 0.07, 0.0), (x + 0.07, 0.34), (x + 0.26, 0.34), (x, 0.66), (x - 0.26, 0.34), (x - 0.07, 0.34)]
    upoly(Frame(), [(px, K + 0.012, z + d * py) for px, py in pts], tint)


def floor_detail():
    Y = K + 0.012
    for z0, z1 in ((ISL - 0.55, ISL), (-ISL, -ISL + 0.55), (OUT0, OUT0 + 0.55), (-OUT0 - 0.55, -OUT0)):
        zc = (z0 + z1) / 2                          # tactile studs on the edge strips, three rows
        x = -HX + 0.35
        while x < HX - 0.2:
            for dz in (-0.15, 0.0, 0.15):
                floor_quad(x - 0.04, zc + dz - 0.04, x + 0.04, zc + dz + 0.04, Y, M_STUD)
            x += 0.2
    for z, nz in ((ISL, 1), (-ISL, -1), (OUT0, -1), (-OUT0, 1)):
        zz = z + nz * 0.004                         # the edges' faces: a yellow rule and a joint every 3 m
        q = [(-HX, K - 0.07, zz), (HX, K - 0.07, zz), (HX, K - 0.03, zz), (-HX, K - 0.03, zz)]
        poly('mark', Frame(), q if nz > 0 else q[::-1], M_YEL)
        for x in range(-27, 28, 3):
            q = [(x - 0.01, 0.0, zz), (x + 0.01, 0.0, zz), (x + 0.01, K - 0.08, zz), (x - 0.01, K - 0.08, zz)]
            poly('mark', Frame(), q if nz > 0 else q[::-1], M_BLK)
    for x0 in (-22.5, -1.5, 19.5):                  # MIND THE GAP, read from the platform with the track ahead
        for z, yaw in ((ISL - 1.25, math.pi), (-ISL + 1.25, 0.0), (OUT0 + 1.25, 0.0), (-OUT0 - 1.25, math.pi)):
            floor_label(Frame(x0, Y, z, yaw), 'MIND THE GAP', 0.26, M_WHT)
    for x0, edge_z in ((-6.0, ISL - 2.6), (6.0, ISL - 2.6), (-6.0, -ISL + 2.6), (6.0, -ISL + 2.6)):
        nm = 'TRACK 1' if edge_z > 0 else 'TRACK 2'
        floor_label(Frame(x0, Y, edge_z, math.pi if edge_z > 0 else 0.0), nm, 0.4, M_WHT)
    for x0 in (-10.0, 12.0):
        floor_label(Frame(x0, Y, OUT0 + 2.6, 0.0), 'TRACK 1', 0.4, M_WHT)
        floor_label(Frame(x0, Y, -OUT0 - 2.6, math.pi), 'TRACK 2', 0.4, M_WHT)
    for s in (1, -1):                               # boarding arrows where the doors stop
        for x0, x1 in ((-24.0, -14.0), (-11.4, -1.4), (1.2, 11.2)):
            xc = s * (x0 + x1) / 2
            for dx in (-3.1, 3.1):
                arrow_floor(xc + dx, s * (ISL - 2.05), s, M_WHT)
                arrow_floor(xc + dx, s * (OUT0 + 2.05), -s, M_WHT)
    for i in range(22):                             # stains
        cx = -26.0 + rnd() * 52.0
        cz = (rnd() * 2 - 1) * 4.5 if rnd() < 0.35 else (12.0 + rnd() * 10.0) * (1 if rnd() < 0.5 else -1)
        r = 0.25 + rnd() * 0.5
        n = 9
        pts = []
        for k in range(n):
            a = 2 * math.pi * k / n
            rr = r * (0.7 + rnd() * 0.5)
            pts.append((cx + rr * math.cos(a) * 1.4, K + 0.009, cz + rr * math.sin(a)))
        upoly(Frame(), pts, M_STAIN)
    for mx, mz in ((0.0, 20.5), (6.0, 12.8), (-2.0, -20.5), (-6.0, -12.8), (-14.0, 0.0), (15.0, -1.0)):   # manholes
        lathe('fit', Frame(), mx, mz, [(0.42, 0.0), (0.42, 0.012), (0.0, 0.012)], 18, M_STEEL, K)
        for a in range(3):
            th = a * math.pi / 3
            c, sn = math.cos(th), math.sin(th)
            upoly(Frame(), [(mx - 0.38 * c - 0.012 * sn, K + 0.0165, mz - 0.38 * sn + 0.012 * c),
                            (mx + 0.38 * c - 0.012 * sn, K + 0.0165, mz + 0.38 * sn + 0.012 * c),
                            (mx + 0.38 * c + 0.012 * sn, K + 0.0165, mz + 0.38 * sn - 0.012 * c),
                            (mx - 0.38 * c + 0.012 * sn, K + 0.0165, mz - 0.38 * sn - 0.012 * c)], M_BLK)


def track_detail(s):
    z = s * TRK
    x = -HX + 0.5
    while x < HX - 0.3:                             # a baseplate and clip at every rail seat
        sx = s * x
        for dz in (-0.72, 0.72):
            pbox('fit', Frame(), sx, 0.115, z + dz, 0.14, 0.03, 0.28, M_STEEL, ('-y',))
            pbox('fit', Frame(), sx, 0.145, z + dz + (0.075 if dz > 0 else -0.075), 0.05, 0.03, 0.06, M_LIGHT, ('-y',))
        x += 0.7
    x = -HX + 1.4                                   # insulators and a cover on the third rail
    while x < HX - 0.5:
        pbox('fit', Frame(), s * x, 0.06, z + 1.35 * s, 0.2, 0.12, 0.3, M_WHT, ('-y',))
        x += 2.8
    pbox('fit', Frame(), 0, 0.235, z + 1.35 * s, 2 * HX - 0.4, 0.03, 0.26, srgb(0x8a4a22), ('-y',))
    sf = F(s, -26.2, 10.45, math.pi / 2)            # a signal at the tunnel end
    pipe('fit', sf.world((0, 0.0, 0)), sf.world((0, 3.0, 0)), 0.045, 8, M_STEEL, True)
    pbox('fit', sf, 0, 3.35, 0.0, 0.32, 0.86, 0.22, M_BLK)
    for i, col in enumerate((LINE_RED, srgb(0x5a3a08), srgb(0x0a3a18))):
        circle(sf, 0.0, 3.62 - i * 0.26, 0.114, 0.085, col, 'glyph', 12)
    for zz in (s * (ISL + 0.28), s * (OUT0 - 0.28)):    # a cable along each platform edge on hangers
        pipe('fit', (-HX + 0.4, 0.1, zz), (HX - 0.4, 0.1, zz), 0.04, 6, M_BLK)
        k = -26.0
        while k < 26.0:
            pbox('fit', Frame(), k, 0.07, zz, 0.06, 0.1, 0.06, M_STEEL)
            k += 1.4


# ------------------------------------------------------------------ the trains

def side_seats(sf, side, cx, w, car):
    """Seat backs, a pole and a few passengers in one window: dark shapes on the lit pane."""
    u0, u1 = side * cx - w / 2 + 0.05, side * cx + w / 2 - 0.05
    z = 1.626
    seat = (srgb(0x2c4a82), srgb(0x6a3030), srgb(0x2a5a42))[car % 3]
    n = max(1, int((u1 - u0) / 0.44))
    sw = (u1 - u0) / n
    for i in range(n):
        a, b = u0 + i * sw + 0.02, u0 + (i + 1) * sw - 0.02
        mrect(sf, a, 1.75, b, 2.1, z, seat)
        mrect(sf, a + 0.03, 2.1, b - 0.03, 2.2, z, seat)
        if rnd() < 0.55:
            c = (a + b) / 2
            jc = JACKETS[int(rnd() * len(JACKETS)) % len(JACKETS)]
            circle(sf, c, 2.46, z + 0.004, 0.085, srgb(0x3a2e28), n=10)
            quadp(sf, [(c - 0.17, 2.2), (c + 0.17, 2.2), (c + 0.13, 2.36), (c - 0.13, 2.36)], z + 0.004, jc)
            mrect(sf, c - 0.04, 2.36, c + 0.04, 2.4, z + 0.004, srgb(0x3a2e28))
    c = (u0 + u1) / 2
    mrect(sf, c - 0.015, 1.75, c + 0.015, 2.85, z + 0.008, M_LIGHT)
    mrect(sf, u0, 2.62, u1, 2.66, z + 0.008, M_LIGHT)
    for k in (0.3, 0.7):                            # straps
        uu = u0 + (u1 - u0) * k
        mrect(sf, uu - 0.012, 2.3, uu + 0.012, 2.62, z + 0.008, M_BLK)
        mrect(sf, uu - 0.035, 2.24, uu + 0.035, 2.3, z + 0.008, M_BLK)


def car_detail(s, x0, x1, ends, idx):
    L = x1 - x0
    fr = F(s, (x0 + x1) / 2, TRK)
    hz = 1.6
    num = '%d' % (4000 + idx * 7 + (11 if s > 0 else 23))
    dest = 'HARBOUR VIA CENTRAL' if s > 0 else 'AIRPORT VIA CENTRAL'
    for side in (-1, 1):
        sf = fr if side > 0 else turn(fr, math.pi)
        zp = hz + 0.02
        for cx, w in ((-4.2, 0.9), (-1.7, 1.4), (1.7, 1.4), (4.2, 0.9)):
            if abs(cx) + w / 2 <= L / 2 - 0.2:
                side_seats(sf, side, cx, w, idx + (0 if side > 0 else 1))
        mrect(sf, -0.62, 0.7, 0.62, 1.02, zp, srgb(0x1c1f23))          # number plate, name on the stripe
        label(sf, 0.0, 0.76, zp + 0.005, num, 0.2, M_WHT)
        label(sf, 0.0, 1.2, zp + 0.005, 'OVERRUN METRO', 0.2, M_WHT)
        circle(sf, 0.0, 2.3, zp, 0.3, srgb(0xe0701c), n=20)             # the roundel
        circle(sf, 0.0, 2.3, zp + 0.004, 0.22, srgb(0xc3c9ce), n=20)
        mrect(sf, -0.42, 2.22, 0.42, 2.38, zp + 0.008, M_BLUE)
        label(sf, 0.0, 2.255, zp + 0.012, 'METRO', 0.1, M_WHT)
        mrect(sf, -1.7, 2.93, 1.7, 3.13, zp, M_PLATE)                   # route strip
        glabel(sf, 0.0, 2.955, zp + 0.006, dest, fw(dest, 3.2, 0.13), M_AMBER)
        for cx in (-3.1, 3.1):
            if abs(cx) + 0.65 > L / 2 - 0.2:
                continue
            u = side * cx
            mrect(sf, u - 0.09, 3.19, u + 0.09, 3.25, zp + 0.004, M_PLATE)
            mrect(sf, u - 0.06, 3.205, u + 0.06, 3.235, zp + 0.008, M_LEDGRN, 'glyph')
            for bx in (-0.88, 0.88):
                circle(sf, u + bx, 1.5, zp + 0.01, 0.045, M_LEDGRN, 'glyph', 10)
            mrect(sf, u - 0.62, 0.7, u + 0.62, 0.78, zp + 0.01, M_BLK)
            label(sf, u, 0.79, zp + 0.012, 'MIND THE GAP', 0.05, M_WHT)
        for ex, ew in ((-1.3, 1.4), (1.2, 1.1)):                        # vents and a rating plate on the equipment
            u = side * ex
            for k in range(4):
                mrect(sf, u - ew * 0.42, 0.22 + k * 0.05, u + ew * 0.42, 0.245 + k * 0.05, 1.527, M_BLK)
            mrect(sf, u + ew * 0.3, 0.38, u + ew * 0.46, 0.46, 1.531, M_YEL)
        for bx in (-L / 2 + 1.7, L / 2 - 1.7):                          # axle boxes on the bogie
            for ax in (-0.55, 0.55):
                pbox('fit', fr, bx + ax, 0.3, side * 1.5, 0.3, 0.26, 0.1, M_STEEL)
        tube_world('fit', fr, (-L / 2 + 1.0, 0.5, side * 1.38), (L / 2 - 1.0, 0.5, side * 1.38), 0.02, M_BLK, 6)
    for sx, e in ((-1, ends[0]), (1, ends[1])):                         # the ends
        ef = turn(fr, sx * math.pi / 2)
        zp = L / 2 + 0.02
        if e:
            mrect(ef, -0.9, 3.17, 0.9, 3.42, zp, M_PLATE)
            glabel(ef, 0.0, 3.215, zp + 0.006, 'CENTRAL' if s > 0 else 'AIRPORT', 0.15, M_AMBER)
            mrect(ef, -0.35, 1.18, 0.35, 1.44, zp + 0.01, M_PLATE)
            label(ef, 0.0, 1.22, zp + 0.016, num, 0.14, M_WHT)
            for wx in (-1, 1):
                seg(ef, (wx * 0.65, 1.58), (wx * 0.2, 2.35), 0.03, zp + 0.004, M_LIGHT)
        else:                                                           # a gangway door
            mrect(ef, -0.5, 0.75, 0.5, 2.75, zp, M_STEEL)
            mrect(ef, -0.36, 1.6, 0.36, 2.55, zp + 0.005, M_GLASSD)
            for hx in (-0.62, 0.62):
                tube_world('fit', ef, (hx, 0.8, zp + 0.05), (hx, 2.7, zp + 0.05), 0.022, M_YEL, 6)
            mrect(ef, -0.12, 1.25, 0.12, 1.4, zp + 0.005, M_BLK)
        n = 14                                                          # hazard chevrons at the foot
        for i in range(0, n, 2):
            a = -1.55 + i * 3.1 / n
            quadp(ef, [(a, 0.56), (a + 0.221, 0.56), (a + 0.321, 0.72), (a + 0.1, 0.72)], zp + 0.004, M_YEL)
        pbox('fit', ef, 0, 0.5, zp + 0.1, 0.9, 0.28, 0.22, M_STEEL)
        pbox('fit', ef, 0, 0.5, zp + 0.22, 0.22, 0.22, 0.04, M_GREY)
    for ax in (-2.6, 2.6):                                              # an aerial on each roof unit
        pipe('fit', fr.world((ax + 0.5, 3.82, 0.4)), fr.world((ax + 0.5, 4.0, 0.4)), 0.015, 6, M_BLK, True)


def trains_detail():
    cars = [(-24.0, -14.0, (1, 0)), (-11.4, -1.4, (0, 0)), (1.2, 11.2, (0, 1))]
    for s in (1, -1):
        for i, (x0, x1, ends) in enumerate(cars):
            car_detail(s, x0, x1, ends, i)
        track_detail(s)


# ------------------------------------------------------------------ ceiling

def ceiling_detail():
    ph = 0.26
    for x in (-18.0, 0.0, 18.0):                    # type on the hanging platform signs, both faces
        for z, t_p, t_m in ((0.0, 'TRACK 1', 'TRACK 2'), (16.5, 'WAY OUT', 'TRACK 1'), (-16.5, 'TRACK 2', 'WAY OUT')):
            fr = Frame(x, 0, z)
            for f2, txt in ((fr, t_p), (turn(fr, math.pi), t_m)):
                glabel(f2, 0.0, 4.7 - ph / 2, 0.066, txt, ph, M_WHT)
                for sx, ch in ((-0.95, '<'), (0.95, '>')):
                    glabel(f2, sx, 4.7 - ph / 2, 0.066, ch, ph, M_WHT)
    for z in (-12.8, -6.5, 6.5, 12.8):              # sprinkler heads on the pipes
        for x in range(-26, 27, 4):
            pbox('fit', Frame(), x, CEIL_Y - 0.3, z, 0.025, 0.12, 0.025, M_STEEL)
            pbox('fit', Frame(), x, CEIL_Y - 0.37, z, 0.08, 0.012, 0.08, M_RED)
    for x in (-12.0, 4.0, 20.0):                    # smoke detectors
        for z in (-11.5, 11.5, 1.4, -1.4):
            lathe('fit', Frame(), x, z, [(0.0, 0.0), (0.11, 0.0), (0.11, 0.035), (0.08, 0.06), (0.0, 0.06)], 10, M_WHT, CEIL_Y - 0.06)
    for x, z in ((-20.0, 13.7), (12.0, 13.7), (-20.0, -13.7), (12.0, -13.7), (-4.0, 2.0), (-4.0, -2.0)):   # camera domes
        lathe('fit', Frame(), x, z, [(0.0, 0.0), (0.05, 0.01), (0.1, 0.05), (0.12, 0.11), (0.12, 0.14), (0.0, 0.14)], 10, M_BLK, CEIL_Y - 0.14)
    for x in (-24.0, 24.0):                         # an exit sign over each stair head, both faces
        fr = Frame(x, 0, 0.0, math.pi / 2)          # faces along the hall, toward the island
        for rz in (-0.28, 0.28):
            pipe('rail', (x, CEIL_Y - 0.1, rz), (x, 3.7, rz), 0.012, 6)
        pbox('signgreen', fr, 0, 3.55, 0, 0.7, 0.28, 0.1, WHITE)
        for f2 in (fr, turn(fr, math.pi)):
            glabel(f2, 0.0, 3.55 - 0.08, 0.056, 'EXIT', 0.16, M_WHT)
    for z in (0.0, TRK, -TRK, 16.5, -16.5):         # end caps on each light trough
        for x in range(-20, 21, 8):
            for sx in (-1.7, 1.7):
                pbox('fit', Frame(), x + sx, CEIL_Y - 0.17, z, 0.05, 0.1, 0.56, M_STEEL)


# ------------------------------------------------------------------ furniture

def col_detail(s, x, z, name):
    fr = F(s, x, z)
    rg = ring(0.504, 24)
    for i in range(24):                             # a hazard wrap at the foot
        j = (i + 1) % 24
        col = M_YEL if i % 2 == 0 else M_BLK
        poly('mark', fr, [(rg[j][0], 0.5, rg[j][1]), (rg[i][0], 0.5, rg[i][1]), (rg[i][0], 0.98, rg[i][1]), (rg[j][0], 0.98, rg[j][1])], col)
    for a in (0.0, math.pi):                        # the column's number on its two blue plates
        pf = Frame(fr.o[0] + math.cos(a) * 0.53, 0, fr.o[2] + math.sin(a) * 0.53, -a + math.pi / 2)
        glabel(pf, 0.0, 2.55 - 0.075, 0.026, name, fw(name, 0.4, 0.15), M_WHT)
    for a, r1, r2 in ((math.pi / 2, 'HARBOUR 2', 'AIRPORT 5'), (3 * math.pi / 2, 'NORTH 6', 'DOCKS 9')):
        pf = Frame(fr.o[0] + math.cos(a) * 0.62, 0, fr.o[2] + math.sin(a) * 0.62, -a + math.pi / 2)
        pbox('fit', pf, 0, 3.4, 0, 0.78, 0.34, 0.07, M_BLK)
        for rx in (-0.28, 0.28):
            for ay in (3.32, 3.48):
                pbox('fit', pf, rx, ay, -0.07, 0.03, 0.03, 0.14, M_STEEL)
        mrect(pf, -0.36, 3.26, 0.36, 3.54, 0.039, M_PLATE)
        glabel_l(pf, -0.33, 3.4, 0.045, r1, 0.075, M_AMBER)
        glabel_l(pf, -0.33, 3.29, 0.045, r2, 0.075, M_AMBER)
    pbox('fit', fr, 0, 4.3, 0.55, 0.1, 0.1, 0.2, M_STEEL)              # a camera on a bracket
    pbox('fit', fr, 0, 4.25, 0.72, 0.13, 0.12, 0.3, M_GREY)
    pbox('signred', fr, 0.05, 4.31, 0.84, 0.02, 0.02, 0.02, WHITE)


def bench_detail(s, x, z, along_x):
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2, K)
    for dx in (-0.55, 0.55):                        # dividers between the seats
        pbox('fit', fr, dx, 0.52, 0.0, 0.04, 0.14, 0.46, M_STEEL)


def vending_detail(s, x, z, yaw, idx):
    fr = F(s, x, z, yaw)
    vf = turn(fr, math.pi)                          # +z toward the front
    pbox('glow', fr, 0, 2.0, -0.35, 0.8, 0.2, 0.12, WHITE)
    glabel(vf, 0.0, 1.94, 0.416, ('DRINKS', 'SNACKS', 'TICKETS')[idx % 3], 0.12, M_PLATE)
    for r in range(4):                              # a price tag under each product
        for c in range(3):
            u = -(-0.2 + c * 0.2)
            mrect(vf, u - 0.07, 1.1 + r * 0.19 - 0.095, u + 0.07, 1.1 + r * 0.19 - 0.065, 0.44, M_WHT)
    for r in range(4):                              # the keypad
        for c in range(2):
            u = -(0.35 + c * 0.06)
            mrect(vf, u - 0.02, 1.08 + r * 0.07, u + 0.02, 1.12 + r * 0.07, 0.44, M_LIGHT)
    mrect(vf, -0.45, 1.5, -0.31, 1.58, 0.44, M_PLATE)
    mrect(vf, -0.43, 1.52, -0.33, 1.56, 0.446, M_LEDGRN, 'glyph')
    mrect(vf, -0.42, 0.97, -0.34, 1.0, 0.444, M_BLK)                    # coin slot
    mrect(vf, -0.25, 0.27, 0.25, 0.43, 0.422, M_PLATE)                  # the dispense flap
    glabel(vf, 0.0, 0.3, 0.428, 'TAKE', 0.07, M_AMBER)


def planter_detail(s, x, z, w, d, yaw):
    fr = F(s, x, z, yaw)
    for i in range(int(w * 5)):                     # flowers on the foliage
        px = (rnd() * 2 - 1) * (w / 2 - 0.25)
        pz = (rnd() * 2 - 1) * (d / 2 - 0.2)
        c = (srgb(0xe84a4a), srgb(0xf0d040), srgb(0xf4f0e8), srgb(0xd070e0))[int(rnd() * 4) % 4]
        pbox('fit', fr, px, 1.27 + rnd() * 0.12, pz, 0.07, 0.07, 0.07, c)
    for sz in (-1, 1):                              # a plaque on each long side
        sf = fr if sz > 0 else turn(fr, math.pi)
        mrect(sf, -0.35, 0.55, 0.35, 0.75, d / 2 + 0.004, M_BLK)
        label(sf, 0.0, 0.6, d / 2 + 0.009, 'PARKS DEPT', fw('PARKS DEPT', 0.62, 0.1), M_WHT)


def barrier_detail(s, x, z, along_x, length):
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2)
    for sz in (-1, 1):
        sf = fr if sz > 0 else turn(fr, math.pi)
        label(sf, 0.0, 0.14, 0.306, 'DANGER', 0.14, M_WHT)
        for u in (-length / 2 + 0.21, length / 2 - 0.21):
            mrect(sf, u - 0.09, 0.1, u + 0.09, 0.36, 0.306, M_RED)


def board_detail(s, x, z, yaw, w, h, idx):
    fr = F(s, x, z, yaw)
    rows = (('1', 'HARBOUR', LINE_RED), ('2', 'AIRPORT', LINE_BLUE), ('3', 'OLD TOWN', LINE_GREEN))
    for sd in (-1, 1):
        sf = fr if sd > 0 else turn(fr, math.pi)
        head = ('CENTRAL', 'INFORMATION')[(idx + (0 if sd > 0 else 1)) % 2]
        ph = fw(head, w - 0.5, 0.2)
        glabel(sf, 0.0, h - 0.65 - ph / 2, 0.146, head, ph, M_WHT)
        y0 = h * 0.4
        for i, (n, nm, col) in enumerate(rows):
            yy = y0 + 0.3 - i * 0.28
            circle(sf, -(w - 0.3) / 2 + 0.2, yy + 0.05, 0.146, 0.09, col, 'glyph', 10)
            glabel(sf, -(w - 0.3) / 2 + 0.2, yy, 0.152, n, 0.1, M_WHT)
            glabel_l(sf, -(w - 0.3) / 2 + 0.4, yy, 0.146, nm, 0.12, M_BLK)
        glabel(sf, 0.0, y0 - 0.5, 0.146, 'EXIT >', 0.12, srgb(0x1f6a42))


KIOSK_NAMES = ('COFFEE', 'NEWS', 'SNACKS', 'TICKETS')


def kiosk_detail(s, cx, w, idx):
    z0, z1 = HZ - 3.6, HZ
    vf = turn(F(s, cx, z0 - 0.12), math.pi)         # +z toward the hall
    glabel(vf, 0.0, 3.35 - 0.19, 0.036, KIOSK_NAMES[idx % 4], 0.38, M_WHT)
    sf = turn(F(s, cx, z1 - 0.6), math.pi)          # the face of the shelf block
    for r in range(3):
        y = 0.45 + r * 0.45
        mrect(sf, -w / 2 + 0.4, y - 0.02, w / 2 - 0.4, y, 0.006, M_STEEL)
        u = -w / 2 + 0.5
        while u < w / 2 - 0.55:
            ww = 0.1 + rnd() * 0.1
            hh = 0.15 + rnd() * 0.2
            c = (srgb(0xd8402a), srgb(0xe0b020), srgb(0x2a7ad8), srgb(0xf0f0e8), srgb(0x2f9a5a), srgb(0xe0701c))[int(rnd() * 6) % 6]
            mrect(sf, u, y, u + ww, y + hh, 0.01, c)
            u += ww + 0.04
    mf = turn(F(s, cx, z1 - 0.01), math.pi)         # a menu on the wall over the shelves
    mrect(mf, -w / 2 + 0.6, 1.95, -w / 2 + 2.4, 2.55, 0.004, M_PLATE)
    glabel_l(mf, -w / 2 + 0.7, 2.4, 0.01, 'MENU', 0.1, M_AMBER)
    for i, (it, pr) in enumerate((('COFFEE', '2'), ('TEA', '2'), ('ROLL', '3'), ('WATER', '1'))):
        glabel_l(mf, -w / 2 + 0.7, 2.22 - i * 0.14, 0.01, it, 0.08, M_WHT)
        glabel_r(mf, -w / 2 + 2.3, 2.22 - i * 0.14, 0.01, pr, 0.08, M_AMBER)
    cf = F(s, cx - 1.0, z0 + 0.22)                  # a till on the counter
    pbox('fit', cf, 0, 1.12, 0, 0.36, 0.24, 0.3, M_STEEL)
    pbox('glow', cf, 0, 1.2, -0.151, 0.2, 0.1, 0.01, WHITE)


def crate_detail(s, x, z, size, h, base, yaw):
    fr = F(s, x, z, yaw, base)
    hs = size / 2
    for side in (0, 2):
        sf = Frame(fr.o[0], fr.o[1], fr.o[2], fr.yaw + side * math.pi / 2)
        mrect(sf, -0.34, h * 0.5 - 0.11, 0.34, h * 0.5 + 0.11, hs + 0.004, M_WHT)
        label(sf, 0.0, h * 0.5 - 0.06, hs + 0.009, 'FRAGILE', fw('FRAGILE', 0.6, 0.13), M_BLK)


def furniture_detail(s):
    col_detail(s, 12.0, 0.0, 'I1')
    col_detail(s, 20.0, 0.0, 'I2')
    bench_detail(s, 9.5, 3.4, True)
    bench_detail(s, 16.0, -3.4, True)
    vending_detail(s, 11.0, 5.0, 0.0, 0)
    vending_detail(s, 14.0, -4.9, math.pi, 1)
    barrier_detail(s, 8.5, -2.4, False, 2.2)
    board_detail(s, 17.0, 1.0, 0.0, 1.8, 2.8, 0)
    planter_detail(s, 21.0, -3.4, 2.0, 0.9, 0.0)
    floor_label(F(s, 21.5, 1.9, 0.0, K + 0.012), 'EXIT >', 0.34, M_WHT)
    for i, x in enumerate((-24.0, -16.0, -8.0, 0.0, 8.0, 16.0, 24.0)):
        col_detail(s, x, 15.0, '%s%d' % ('S' if s > 0 else 'N', i + 1))
    kiosk_detail(s, -17.5, 6.4, 0 if s > 0 else 2)
    kiosk_detail(s, 8.0, 6.4, 1 if s > 0 else 3)
    bench_detail(s, -12.0, 12.4, True)
    bench_detail(s, 4.0, 17.2, True)
    bench_detail(s, 14.5, 12.8, True)
    planter_detail(s, -3.5, 13.5, 2.6, 1.0, 0.0)
    planter_detail(s, 11.5, 15.8, 2.0, 1.0, math.pi / 2)
    planter_detail(s, 24.5, 19.5, 2.4, 1.0, 0.0)
    vending_detail(s, -26.5, 21.8, math.pi, 2)
    vending_detail(s, 21.0, 21.8, math.pi, 0)
    barrier_detail(s, -9.5, 18.0, True, 2.4)
    barrier_detail(s, 18.5, 14.0, False, 2.4)
    board_detail(s, -4.5, 19.0, 0.0, 2.4, 2.9, 1)
    crate_detail(s, 25.5, 12.8, 1.2, 1.0, 0.0, 0.0)
    crate_detail(s, 25.7, 14.1, 1.0, 1.0, 0.0, 0.4)
    crate_detail(s, 25.5, 12.9, 1.0, 1.0, 1.0, 0.3)
    crate_detail(s, -26.0, 17.6, 1.2, 1.0, 0.0, 0.0)


# ------------------------------------------------------------------ the information hall

def info_detail():
    R, G = 4.2, 1.2
    for k in range(4):
        a = k * math.pi / 2
        outer = sub(Frame(0, 0, 0, a), 0, 0, R + 0.25)                   # the outer face, +z outward
        inner = sub(Frame(0, 0, 0, a + math.pi), 0, 0, -(R - 0.25))     # the inner face, +z toward the middle
        for u in (-2.85, 2.85):
            linemap(outer, u, 0.45, 2.2, 1.4)
            mrect(outer, u - 1.1, 2.55, u + 1.1, 2.9, 0.01, M_BLUE)
            glabel(outer, u, 2.62, 0.016, 'INFORMATION', 0.2, M_WHT)
        pf = Frame(0, 0, 0, -a + math.pi / 2)
        for tx, txt in ((-(G + 0.55), 'INFO'), (G + 0.55, 'HELP')):
            glabel(pf, tx, 2.3 - 0.075, R + 0.276, txt, 0.15, M_WHT)
        mrect(inner, -3.15, 1.5, -1.95, 2.3, 0.006, M_DGRN)             # a notice, first aid on the other half
        for y, txt, ph, col in ((2.12, 'PLEASE', 0.1, M_WHT), (1.97, 'KEEP CLEAR', 0.1, M_WHT),
                                (1.82, 'OF DOORS', 0.1, M_WHT), (1.62, 'HELP IS NEAR', 0.08, M_YEL)):
            label(inner, -2.55, y, 0.012, txt, ph, col)
        firstaid(inner, 2.55)
    for k in range(4):                              # INFO on each face of the hanging sign
        glabel(Frame(0, 0, 0, k * math.pi / 2), 0.0, 4.4 - 0.12, 0.706, 'INFO', 0.24, M_WHT)
    for x, z in ((0.0, 2.9), (0.0, -2.9), (2.9, 0.0), (-2.9, 0.0)):    # floor text read from the middle
        floor_label(Frame(x, K + 0.012, z, math.atan2(-x, -z)), 'INFO', 0.4, M_WHT)


def metro_detail():
    for side in ('N', 'S', 'E', 'W'):
        wall_detail(side)
    floor_detail()
    ceiling_detail()
    trains_detail()
    info_detail()
    both(furniture_detail)
