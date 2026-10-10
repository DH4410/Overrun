"""
snowdetail: the second pass over SNOW. Exec'd by build_snow.py after the layout's own functions
(so it can wrap cabin, window, container, crate, tank, snowcat, lamp_post and woodpile) and before
`result = ...`. build_layout() calls snow_detail() just before rk_finalize().

Everything here is scenery, in the keys fit / mark / glyph / tmark / tglyph (see detailkit.py):
    - cabins: a name and a number, downspouts, conduit and junction boxes, vent grilles, extinguishers,
      notice boards, cage lamps, blinds and warm light on the snow under the lit windows, frost on the
      dark ones, snow on the sills, icicles under the cornice, a boot-print trail from the door, a solar
      panel, a flue, a hatch and an aerial on the roof
    - the fence: panel joints, a kick rail, signs, post numbers, floodlights, razor ribbon, gate bracing,
      a lock and a name; the watchtowers: mullions, numbers, a searchlight, a ladder
    - the station: cladding joints, names, entrance signs, downspouts, meters, vents, sills, icicles,
      roof plant; inside, wainscot, posters, clock, exit signs, ceiling fixtures and ducts, desk and
      bench equipment, floor markings
    - the tank farm: names, level gauges, hazard diamonds, rails, anchor bolts, transfer lines, the bund's
      stencils and stripes
    - the motor pool: name boards, tool wall, bay markings, oil stains, tyre tracks, a work bench,
      hazard posts; the snowcat's numbers, plough stripes and lamps
    - containers, crates, lamp posts and the woodpile; tracks on the road, ice cracks on the pond,
      thin-ice signs, wind ripples

Nothing here emits a collider and nothing moves one: snow.json stays as it was. Decals that share a
key share one polygon offset, so they are layered at least 5 mm apart.
"""
exec(open(os.path.join(REPO, 'scripts', 'blender', 'detailkit.py')).read())
seed(20261010)

M_ICE = srgb(0xcfe3f0)
M_PRINT = srgb(0xb4bec7)
M_SLUSH = srgb(0x969ea6)
M_WARM = srgb(0xfff0c8)
M_TAN = srgb(0xb59a68)
M_TAN_D = srgb(0x7e6a45)
M_SPILL = srgb(0xf3e0b6)
M_CORK = srgb(0x9d7a4d)
M_FRAME = srgb(0x4b3a2c)
M_PAPER = srgb(0xe8e4d6)
M_SAGE = srgb(0x5f7a6e)
M_RAIL = srgb(0x3a2f27)
M_SKIRT = srgb(0x2d3033)
M_SCREEN = srgb(0x3f8fd8)
M_SCREEN2 = srgb(0x72d8a0)
M_EXIT = srgb(0x0f7a45)
M_ORG = srgb(0xe07a1f)
M_FROST = srgb(0xc9d6df)
M_SHEEN = srgb(0x23333f)
M_PANEL = srgb(0x142a52)
M_CELL = srgb(0x5d7ea8)
M_GLASS = srgb(0xbfd7ea)
M_OIL = srgb(0x2c2b29)
M_CONC = srgb(0x7b7c7a)
M_TARP = srgb(0x2d5f8b)
M_WOODD = srgb(0x6b5640)
M_FLOOR_L = srgb(0xd6c25a)
M_PLATE = srgb(0x9aa1a6)


def floor_rect(s, x0, z0, x1, z1, y, tint):
    """A flat decal on the floor or the snow, in the half's own coordinates."""
    fquad(F(s, 0.0, 0.0), x0, z0, x1, z1, y, tint)


# ------------------------------------------------------------------ small shared pieces

def hull(key, fr, faces, tint=WHITE):
    """Faces of a small convex solid, each wound outward from the solid's centre."""
    pts = [p for f in faces for p in f]
    c = [sum(p[i] for p in pts) / len(pts) for i in range(3)]
    for f in faces:
        n = newell(f)
        fc = [sum(p[i] for p in f) / len(f) for i in range(3)]
        if n[0] * (fc[0] - c[0]) + n[1] * (fc[1] - c[1]) + n[2] * (fc[2] - c[2]) < 0:
            f = f[::-1]
        poly(key, fr, f, tint)


def facing(key, fr, pts, tint, toward):
    """One polygon wound so that it faces `toward`."""
    n = newell(pts)
    if n[0] * toward[0] + n[1] * toward[1] + n[2] * toward[2] < 0:
        pts = pts[::-1]
    poly(key, fr, pts, tint)


def _clip2(pts, a, b):
    """Clip a convex 2-D polygon [(u, y)] to a <= u <= b."""
    def cut(poly_, inside, hit):
        out = []
        for i, p in enumerate(poly_):
            q = poly_[(i + 1) % len(poly_)]
            if inside(p):
                out.append(p)
            if inside(p) != inside(q):
                out.append(hit(p, q))
        return out
    pts = cut(pts, lambda p: p[0] >= a, lambda p, q: (a, p[1] + (q[1] - p[1]) * (a - p[0]) / (q[0] - p[0])))
    if len(pts) >= 3:
        pts = cut(pts, lambda p: p[0] <= b, lambda p, q: (b, p[1] + (q[1] - p[1]) * (b - p[0]) / (q[0] - p[0])))
    return pts


def hazard(fr, u0, u1, y0, y1, z, yel=M_YEL, blk=M_BLK, pitch=None):
    """A band of diagonal black and yellow stripes on a vertical face."""
    mrect(fr, u0, y0, u1, y1, z, blk)
    h = y1 - y0
    p = pitch or h * 1.6
    u = u0 - h
    while u < u1:
        pts = _clip2([(u, y0), (u + p / 2, y0), (u + p / 2 + h, y1), (u + h, y1)], u0, u1)
        if len(pts) >= 3:
            quadp(fr, pts, z + 0.005, yel)
        u += p


def plate(fr, u, y, w, h, bg, fg, text, ph=None, border=M_WHT, z=0.006, key='tmark'):
    """A sign plate with a border and one line of text."""
    mrect(fr, u - w / 2, y, u + w / 2, y + h, z, border)
    mrect(fr, u - w / 2 + 0.022, y + 0.022, u + w / 2 - 0.022, y + h - 0.022, z + 0.006, bg)
    if text:
        ph = ph or fw(text, w - 0.1, h * 0.55)
        type_label(fr, u, y + (h - ph) / 2, z + 0.008, text, ph, fg, key)


def icicle(fr, u, y, z, r, ln):
    b = [(u - r, y, z - r), (u + r, y, z - r), (u + r, y, z + r), (u - r, y, z + r)]
    ap = (u, y - ln, z)
    hull('fit', fr, [[b[i], b[(i + 1) % 4], ap] for i in range(4)], M_ICE)


def icicles(fr, u0, u1, y, z=0.08, step=0.3, lo=0.08, hi=0.45, skip=()):
    u = u0
    while u < u1:
        if not any(a <= u <= b for a, b in skip):
            icicle(fr, u + (rnd() - 0.5) * 0.08, y, z, 0.022 + 0.016 * rnd(), lo + (hi - lo) * rnd() ** 1.6)
        u += step * (0.6 + 0.8 * rnd())


class Run:
    """A wall face to dress. u runs along it left to right as seen from outside, y up, z out of the
    wall; (x, z) is the u = 0 end of the face in the half's own coordinates, s the half (1, or -1 for
    the turned copy), yaw the face's own (FACE_YAW)."""

    def __init__(self, s, x, z, yaw, L=0.0):
        self.s, self.x, self.z, self.yaw, self.L = s, x, z, yaw, L
        self.dx, self.dz = math.cos(yaw), -math.sin(yaw)

    def fr(self, u=0.0, y=0.0, yaw=0.0):
        return F(self.s, self.x + u * self.dx, self.z + u * self.dz, self.yaw + yaw, y)

    def u_of(self, x, z):
        return (x - self.x) * self.dx + (z - self.z) * self.dz


def seams(run, pitch, y0, y1, blocks, tint, z=0.006, first=None):
    """Thin vertical panel joints every `pitch`, broken where they would run through a block
    (u0, u1, y0, y1)."""
    fr = run.fr()
    u = first if first is not None else pitch
    while u < run.L - 0.2:
        ivs = [(y0, y1)]
        for (b0, b1, c0, c1) in blocks:
            if b0 - 0.03 <= u <= b1 + 0.03:
                new = []
                for (a, b) in ivs:
                    if c0 > a:
                        new.append((a, min(b, c0)))
                    if c1 < b:
                        new.append((max(a, c1), b))
                ivs = [(a, b) for (a, b) in new if b - a > 0.15]
        for (a, b) in ivs:
            mrect(fr, u - 0.012, a, u + 0.012, b, z, tint)
        u += pitch


# ------------------------------------------------------------------ wall furniture (frame: z out of the wall)

def extinguisher(fr, u, y0=0.95, z=0.1):
    prof = [(0.0, y0), (0.05, y0), (0.075, y0 + 0.02), (0.075, y0 + 0.34), (0.05, y0 + 0.42), (0.022, y0 + 0.46), (0.0, y0 + 0.46)]
    lathe('fit', fr, u, z, prof, n=10, tint=M_RED)
    pbox('fit', fr, u, y0 + 0.3, 0.035, 0.13, 0.05, 0.07, M_STEEL)
    pbox('fit', fr, u, y0 + 0.12, 0.035, 0.13, 0.05, 0.07, M_STEEL)
    tube('fit', fr, [(u + 0.03, y0 + 0.42, z), (u + 0.1, y0 + 0.34, z + 0.04), (u + 0.1, y0 + 0.14, z + 0.03)], 0.01, n=4, tint=M_BLK)
    mrect(fr, u - 0.15, y0 + 0.62, u + 0.15, y0 + 0.92, 0.006, M_WHT)
    mrect(fr, u - 0.13, y0 + 0.64, u + 0.13, y0 + 0.9, 0.012, M_RED)
    label(fr, u, y0 + 0.69, 0.016, 'FIRE', 0.075, M_WHT)
    mrect(fr, u - 0.012, y0 + 0.78, u + 0.012, y0 + 0.88, 0.018, M_WHT)


def vent_grille(fr, u, y, w=0.55, h=0.38):
    pbox('fit', fr, u, y + h / 2, 0.015, w + 0.06, h + 0.06, 0.03, M_STEEL)
    mrect(fr, u - w / 2, y, u + w / 2, y + h, 0.032, M_BLK)
    k = 0
    while 0.04 + k * 0.065 < h - 0.03:
        pbox('fit', fr, u, y + 0.05 + k * 0.065, 0.045, w - 0.04, 0.02, 0.05, M_DARK)
        k += 1


def junction(fr, u, y):
    tube('fit', fr, [(u, y - 0.55, 0.045), (u, y, 0.045), (u, y + 0.95, 0.045)], 0.02, n=6, tint=M_STEEL)
    pbox('fit', fr, u, y, 0.06, 0.24, 0.3, 0.12, M_DARK)
    pbox('fit', fr, u, y + 0.5, 0.045, 0.06, 0.03, 0.05, M_STEEL)
    pbox('fit', fr, u, y - 0.3, 0.045, 0.06, 0.03, 0.05, M_STEEL)
    quadp(fr, [(u - 0.08, y + 0.17), (u + 0.08, y + 0.17), (u, y + 0.3)], 0.006, M_YEL)
    mrect(fr, u - 0.09, y - 0.02, u + 0.09, y + 0.06, 0.006, M_RED)
    label(fr, u, y - 0.01, 0.012, 'HV', 0.06, M_WHT)


def cage_lamp(fr, u, y):
    pbox('fit', fr, u, y, 0.05, 0.14, 0.2, 0.1, M_STEEL)
    pbox('fit', fr, u, y, 0.12, 0.17, 0.15, 0.1, M_DARK)
    mrect(fr, u - 0.06, y - 0.05, u + 0.06, y + 0.05, 0.172, M_WARM, 'glyph')
    for dy in (-0.04, 0.0, 0.04):
        pbox('fit', fr, u, y + dy, 0.176, 0.15, 0.012, 0.012, M_BLK)


def downspout(fr, u, top, z=0.06):
    tube('fit', fr, [(u, top, z), (u, 0.62, z), (u, 0.42, z + 0.07), (u, 0.3, z + 0.2)], 0.035, n=8, tint=M_STEEL)
    for yy in (top - 0.35, top * 0.55, 0.9):
        pbox('fit', fr, u, yy, z - 0.02, 0.1, 0.04, 0.05, M_STEEL)


def noticeboard(fr, u, y, w=0.7, h=0.5):
    mrect(fr, u - w / 2 - 0.03, y - 0.03, u + w / 2 + 0.03, y + h + 0.03, 0.006, M_FRAME)
    mrect(fr, u - w / 2, y, u + w / 2, y + h, 0.012, M_CORK)
    for _ in range(4):
        pw, ph_ = 0.1 + 0.08 * rnd(), 0.12 + 0.1 * rnd()
        px = u - w / 2 + 0.05 + rnd() * (w - 0.2)
        py = y + 0.04 + rnd() * (h - 0.2)
        mrect(fr, px, py, px + pw, py + ph_, 0.018, M_PAPER)
        mrect(fr, px + pw / 2 - 0.008, py + ph_ - 0.02, px + pw / 2 + 0.008, py + ph_ - 0.004, 0.024, M_RED)


def poster(run, u, y, kind, w=0.62, h=0.86):
    fr = run.fr()
    mrect(fr, u - w / 2 - 0.02, y - 0.02, u + w / 2 + 0.02, y + h + 0.02, 0.006, M_FRAME)
    mrect(fr, u - w / 2, y, u + w / 2, y + h, 0.012, M_PAPER)
    if kind == 'chart':
        for i in range(6):
            bh = 0.1 + 0.4 * rnd()
            mrect(fr, u - w / 2 + 0.06 + i * 0.085, y + 0.1, u - w / 2 + 0.12 + i * 0.085, y + 0.1 + bh, 0.018, M_BLUE)
        mrect(fr, u - w / 2 + 0.05, y + 0.095, u + w / 2 - 0.05, y + 0.105, 0.018, M_BLK)
        label(fr, u, y + h - 0.14, 0.02, 'SNOW DEPTH', fw('SNOW DEPTH', w - 0.1, 0.07), M_BLK)
    elif kind == 'plan':
        mrect(fr, u - w / 2, y + h - 0.16, u + w / 2, y + h, 0.018, M_EXIT)
        label(fr, u, y + h - 0.12, 0.024, 'EXIT PLAN', fw('EXIT PLAN', w - 0.1, 0.07), M_WHT)
        mrect(fr, u - 0.24, y + 0.1, u - 0.02, y + 0.5, 0.018, srgb(0xb9b4a4))
        mrect(fr, u + 0.02, y + 0.1, u + 0.24, y + 0.5, 0.018, srgb(0xb9b4a4))
        mrect(fr, u - 0.02, y + 0.1, u + 0.02, y + 0.5, 0.018, M_PAPER)
        quadp(fr, [(u - 0.04, y + 0.2), (u + 0.04, y + 0.2), (u + 0.04, y + 0.3), (u + 0.09, y + 0.3), (u, y + 0.42), (u - 0.09, y + 0.3), (u - 0.04, y + 0.3)], 0.024, M_GRN)
    elif kind == 'safety':
        mrect(fr, u - w / 2, y + h - 0.16, u + w / 2, y + h, 0.018, M_YEL)
        label(fr, u, y + h - 0.12, 0.024, 'SAFETY', fw('SAFETY', w - 0.1, 0.075), M_BLK)
        quadp(fr, [(u - 0.2, y + 0.12), (u + 0.2, y + 0.12), (u, y + 0.5)], 0.018, M_YEL)
        quadp(fr, [(u - 0.15, y + 0.16), (u + 0.15, y + 0.16), (u, y + 0.43)], 0.024, M_PAPER)
        mrect(fr, u - 0.015, y + 0.22, u + 0.015, y + 0.34, 0.03, M_BLK)
        mrect(fr, u - 0.015, y + 0.18, u + 0.015, y + 0.2, 0.03, M_BLK)
    elif kind == 'map':
        mrect(fr, u - w / 2 + 0.04, y + 0.1, u + w / 2 - 0.04, y + h - 0.2, 0.018, srgb(0xcfd9e0))
        circle(fr, u, y + 0.35, 0.024, 0.1, srgb(0x8fb0c6))
        for (dx, dy, ww, hh) in ((-0.18, 0.12, 0.1, 0.07), (0.1, 0.12, 0.12, 0.07), (0.12, 0.45, 0.1, 0.08), (-0.2, 0.46, 0.09, 0.07)):
            mrect(fr, u + dx, y + dy + 0.1, u + dx + ww, y + dy + 0.1 + hh, 0.024, M_RED)
        label(fr, u, y + h - 0.12, 0.024, 'SITE MAP', fw('SITE MAP', w - 0.1, 0.07), M_BLK)
    else:
        label(fr, u, y + h - 0.12, 0.024, 'RULES', 0.07, M_RED)
        for i in range(6):
            mrect(fr, u - w / 2 + 0.06, y + h - 0.26 - i * 0.1, u + w / 2 - 0.06 - 0.1 * rnd(), y + h - 0.23 - i * 0.1, 0.018, M_INK)


def clock(fr, u, y, r=0.17):
    circle(fr, u, y, 0.006, r + 0.03, M_BLK)
    circle(fr, u, y, 0.012, r, M_WHT)
    for k in range(12):
        a = k * math.pi / 6
        mrect(fr, u + (r - 0.03) * math.sin(a) - 0.006, y + (r - 0.03) * math.cos(a) - 0.006,
              u + (r - 0.03) * math.sin(a) + 0.006, y + (r - 0.03) * math.cos(a) + 0.006, 0.018, M_BLK)
    quadp(fr, [(u - 0.008, y), (u + 0.008, y), (u + 0.008, y + r * 0.8), (u - 0.008, y + r * 0.8)], 0.024, M_BLK)
    quadp(fr, [(u, y - 0.008), (u + r * 0.55, y + 0.05), (u + r * 0.55, y + 0.065), (u, y + 0.008)], 0.03, M_BLK)


def tmark_text(fr, u, y, z, text, ph, tint):
    type_label(fr, u, y, z, text, ph, tint, 'tmark')


# ------------------------------------------------------------------ cabins

CAB_NAMES = {'red': 'BARRACKS', 'ochre': 'STORES'}
_win_log = []
_window_layout = window


def window(face, P, t, y, w=1.1, hgt=0.9, lit=False):
    _window_layout(face, P, t, y, w, hgt, lit)
    _win_log.append((face, P, t, y, w, hgt, lit))


def solar_panel(rf, cx, cz, W=1.6, D=1.0, tilt=25.0):
    a = math.radians(tilt)
    y0 = 0.32
    y1 = y0 + D * math.sin(a)
    zl, zh = cx * 0 + D * math.cos(a) / 2, -D * math.cos(a) / 2
    x0, x1 = cx - W / 2, cx + W / 2
    pts = [(x0, y0, zl + cz), (x1, y0, zl + cz), (x1, y1, zh + cz), (x0, y1, zh + cz)]
    n = (0.0, math.cos(a), math.sin(a))
    facing('fit', rf, pts, M_PANEL, n)
    facing('fit', rf, pts, M_STEEL, (0.0, -n[1], -n[2]))
    off = 0.004
    for i in range(1, 4):
        x = x0 + i * W / 4
        facing('fit', rf, [(x - 0.007, y0 + off * n[1], zl + cz + off * n[2]), (x + 0.007, y0 + off * n[1], zl + cz + off * n[2]),
                           (x + 0.007, y1 + off * n[1], zh + cz + off * n[2]), (x - 0.007, y1 + off * n[1], zh + cz + off * n[2])], M_CELL, n)
    for j in range(1, 3):
        f = j / 3.0
        yy = y0 + (y1 - y0) * f + off * n[1]
        zz = zl + (zh - zl) * f + cz + off * n[2]
        facing('fit', rf, [(x0, yy - 0.007, zz), (x1, yy - 0.007, zz), (x1, yy + 0.007, zz), (x0, yy + 0.007, zz)], M_CELL, n)
    for x in (x0, x1):
        tube('fit', rf, [(x, 0.0, zh + cz), (x, y1, zh + cz)], 0.018, n=5, tint=M_STEEL)
        tube('fit', rf, [(x, 0.0, zl + cz), (x, y0, zl + cz)], 0.018, n=5, tint=M_STEEL)


def cabin_detail(xa, xb, za, zb, h, key, seed_, door, aircon, wins):
    name = '%s %d' % (CAB_NAMES.get(key, 'CABIN'), 1 if za + zb > 0 else 2)
    ink = M_WHT if key == 'red' else M_BLK
    grime = srgb(0x6a1f17) if key == 'red' else srgb(0x80591c)
    for fi, face in enumerate(('+x', '-x', '+z', '-z')):
        L, P = face_fn(face, xa, xb, za, zb, e=0.0)
        x0, _, z0 = P(0.0, 0.0)
        run = Run(1, x0, z0, FACE_YAW[face], L)
        fr = run.fr()
        dt = door[1] if door and door[0] == face else None
        at = aircon[1] if aircon and aircon[0] == face else None
        n = int(L // 2.6)
        # name, high on the wall, and a stripe under the cornice
        if at is None:
            label(fr, L / 2, 3.5, 0.006, name, 0.3, ink)
        mrect(fr, 0.3, h - 0.66, L - 0.3, h - 0.58, 0.006, grime)
        # fixtures between the windows
        for i in range(1, n):
            t = i * L / n
            if dt is not None and abs(t - dt) < 1.5:
                continue
            if at is not None and abs(t - at) < 1.1:
                continue
            kind = (i + fi) % 4
            if kind == 0:
                junction(fr, t, 1.6)
            elif kind == 1:
                vent_grille(fr, t, 1.15)
            elif kind == 2:
                extinguisher(fr, t)
            else:
                cage_lamp(fr, t, 2.65)
                noticeboard(fr, t, 1.0, 0.5, 0.4)
        downspout(fr, L - 0.28, h - 0.35)
        icicles(fr, 0.4, L - 0.4, h - 0.35, 0.08, 0.3, 0.08, 0.5, skip=((dt - 1.0, dt + 1.0),) if dt else ())
        # a grimy line where the snow bank meets the footing
        mrect(fr, 0.15, 0.45, L - 0.15, 0.68, 0.006, grime)
    for (face, P, t, y, w, hgt, lit) in wins:
        fr = onface(face, P, t)
        rb('mound', fr, 0, y + 0.01, 0.1, w + 0.24, 0.06, 0.16, 0.025)
        if lit:
            mrect(fr, -w / 2 + 0.02, y + hgt * 0.52, w / 2 - 0.02, y + hgt - 0.02, 0.006, M_TAN)
            for k in range(3):
                mrect(fr, -w / 2 + 0.02, y + hgt * 0.56 + k * 0.1, w / 2 - 0.02, y + hgt * 0.56 + k * 0.1 + 0.012, 0.012, M_TAN_D)
            upoly(fr, [(-w / 2, 0.012, 0.16), (w / 2, 0.012, 0.16), (w * 0.8, 0.012, 2.4), (-w * 0.8, 0.012, 2.4)], M_SPILL)
        else:
            quadp(fr, [(-w / 2 + 0.05, y + 0.04), (-w / 2 + 0.22, y + 0.04), (w / 2 - 0.05, y + hgt - 0.04), (w / 2 - 0.22, y + hgt - 0.04)], 0.006, M_SHEEN)
            quadp(fr, [(-w / 2, y), (-w / 2 + 0.28, y), (-w / 2, y + 0.24)], 0.012, M_FROST)
            quadp(fr, [(w / 2, y), (w / 2 - 0.28, y), (w / 2, y + 0.24)], 0.012, M_FROST)
    if door:
        face, t = door
        L, P = face_fn(face, xa, xb, za, zb)
        fr = onface(face, P, t)
        mrect(fr, -0.2, 1.5, 0.2, 2.1, 0.006, M_PLATE)
        quadp(fr, [(-0.18, 1.52), (-0.08, 1.52), (0.1, 2.08), (0.0, 2.08)], 0.012, srgb(0xc9d0d6))
        mrect(fr, -0.55, 0.14, 0.55, 0.42, 0.006, srgb(0x8d949a))
        mrect(fr, -0.55, 0.76, 0.55, 0.8, 0.006, srgb(0x8d949a))
        plate(fr, -1.12, 1.55, 0.3, 0.2, M_BLUE, M_WHT, '1', 0.14)
        fquad(fr, -0.55, 0.08, 0.55, 0.52, 0.186, M_PLATE)
        for k in range(9):
            fquad(fr, (-0.16 if k % 2 else 0.05), 0.95 + k * 0.62, (-0.05 if k % 2 else 0.16), 1.25 + k * 0.62, 0.012, M_PRINT)
        # a shovel against the wall beside the door
        tube('fit', fr, [(1.2, 0.05, 0.3), (1.2, 1.55, 0.06)], 0.015, n=5, tint=M_WOODD)
        pbox('fit', fr, 1.2, 0.17, 0.3, 0.26, 0.03, 0.3, M_STEEL)
    # on the roof: a solar panel on the barracks, a hatch, a flue with a hat, an aerial
    rf = Frame(0.0, h, 0.0)
    cx = xa + (xb - xa) * 0.45
    cz = za + (zb - za) * 0.5
    if key == 'red':
        solar_panel(rf, cx, cz)
    pbox('fit', rf, xb - 1.0, 0.12, za + 1.0, 0.9, 0.24, 0.9, M_STEEL)
    pbox('fit', rf, xb - 1.0, 0.26, za + 1.0, 0.7, 0.03, 0.7, M_DARK)
    pbox('fit', rf, xb - 1.36, 0.26, za + 1.0, 0.05, 0.05, 0.2, M_BLK)
    tube('fit', rf, [(xa + 0.45, 0.0, zb - 0.45), (xa + 0.45, 3.3, zb - 0.45)], 0.014, n=5, tint=M_STEEL)
    for yy, ww in ((2.4, 0.9), (3.0, 0.6)):
        tube('fit', rf, [(xa + 0.45 - ww / 2, yy, zb - 0.45), (xa + 0.45 + ww / 2, yy, zb - 0.45)], 0.01, n=4, tint=M_STEEL)
    pbox('glyph', rf, xa + 0.45, 3.34, zb - 0.45, 0.07, 0.07, 0.07, M_RED)
    fx, fz = xa + (xb - xa) * 0.3, za + (zb - za) * 0.7
    tube('fit', rf, [(fx, 0.0, fz), (fx, 0.9, fz), (fx + 0.12, 1.05, fz)], 0.07, n=8, tint=M_STEEL)
    lathe('fit', rf, fx + 0.12, fz, [(0.14, 1.12), (0.0, 1.0)], n=8, tint=M_DARK)


_cabin_layout = cabin


def cabin(x0, z0, x1, z1, h, key='red', faces='+x-x+z-z', seed=1, door=None, aircon=None):
    del _win_log[:]
    _cabin_layout(x0, z0, x1, z1, h, key, faces, seed, door, aircon)
    xa, xb = sorted((x0, x1))
    za, zb = sorted((z0, z1))
    cabin_detail(xa, xb, za, zb, h, key, seed, door, aircon, list(_win_log))


# ------------------------------------------------------------------ the fence and its towers

def fence_detail():
    t = 0.3
    for face, (xa, xb, za, zb) in (('+x', (-HX - t, -HX, -HZ, HZ)), ('-x', (HX, HX + t, -HZ, HZ)),
                                   ('+z', (-HX, HX, -HZ - t, -HZ)), ('-z', (-HX, HX, HZ, HZ + t))):
        L, P = face_fn(face, xa, xb, za, zb, e=0.0)
        x0, _, z0 = P(0.0, 0.0)
        run = Run(1, x0, z0, FACE_YAW[face], L)
        fr = run.fr()
        gate = face in ('+z', '-z')
        mid = L / 2
        in_gate = lambda u, m=3.5: gate and abs(u - mid) < m
        k = 1.0
        while k < L - 0.5:
            if abs(k % 3.0) > 0.01 and abs(k % 3.0 - 3.0) > 0.01 and not in_gate(k):
                mrect(fr, k - 0.012, 0.5, k + 0.012, FENCE_H - 0.05, 0.006, srgb(0x3d444a))
            k += 1.0
        for a, b in ((0.0, mid - 3.5), (mid + 3.5, L)) if gate else ((0.0, L),):
            mrect(fr, a, 2.15, b, 2.23, 0.006, srgb(0x353b40))
        signs = (('KEEP OUT', M_RED, M_WHT), ('CAUTION', M_YEL, M_BLK), ('SECTOR', M_BLUE, M_WHT), ('NO ENTRY', M_RED, M_WHT))
        j = 1
        sn = 0
        while 3 * j + 1.5 < L:
            c = 3 * j + 1.5
            if not in_gate(c, 5.0):
                if j % 6 == 2:
                    txt, bg, fg = signs[(j // 6 + (1 if gate else 0)) % 4]
                    if txt == 'SECTOR':
                        txt = 'SECTOR %d' % (1 + (sn + (3 if face in ('+z', '-z') else 0)) % 9)
                    sn += 1
                    plate(fr, c, 2.55, 1.9, 0.62, bg, fg, txt, 0.2)
                    pbox('fit', fr, c - 0.8, 2.86, 0.02, 0.05, 0.05, 0.03, M_STEEL)
                    pbox('fit', fr, c + 0.8, 2.86, 0.02, 0.05, 0.05, 0.03, M_STEEL)
                elif j % 3 == 0:
                    label(fr, c, 0.14, 0.012, '%02d' % ((j + int(L)) % 100), 0.2, srgb(0x2a2d30))
            j += 1
        # floodlights on every fourth post, and a razor ribbon along the top
        j = 2
        while 3 * j < L - 1:
            u = 3.0 * j
            if not in_gate(u, 3.4):
                pbox('fit', fr, u, FENCE_H + 0.7, 0.3, 0.1, 0.2, 0.1, M_STEEL)
                rb('fit', fr, u, FENCE_H + 0.86, 0.34, 0.46, 0.2, 0.26, 0.03, M_STEEL)
                pbox('fit', fr, u, FENCE_H + 0.99, 0.4, 0.5, 0.025, 0.4, M_DARK)
                mrect(fr, u - 0.19, FENCE_H + 0.8, u + 0.19, FENCE_H + 0.92, 0.472, M_WARM, 'glyph')
            j += 4
        # an insulator where each bracket carries the three strands
        j = 0
        while 3 * j <= L + 0.01:
            u = min(3.0 * j, L)
            if not in_gate(u, 3.4):
                for d_, y_ in ((0.12, FENCE_H + 0.62), (0.22, FENCE_H + 0.74), (0.32, FENCE_H + 0.88)):
                    pbox('fit', fr, u, y_, d_, 0.05, 0.05, 0.05, M_WHT)
            j += 1
    for s in (1, -1):
        face = '-z' if s > 0 else '+z'
        za, zb = (HZ, HZ + t) if s > 0 else (-HZ - t, -HZ)
        L, P = face_fn(face, -HX, HX, za, zb, e=2 * TRIM)
        x0, _, z0 = P(0.0, 0.0)
        run = Run(1, x0, z0, FACE_YAW[face], L)
        fr = run.fr()
        mid = L / 2
        for sg in (-1, 1):
            a, b = mid + sg * 0.1, mid + sg * 3.0
            ua, ub = min(a, b), max(a, b)
            for yy in (0.65, 3.35):
                mrect(fr, ua, yy, ub, yy + 0.1, 0.012, srgb(0x353b40))
            quadp(fr, [(ua + 0.05, 0.75), (ua + 0.2, 0.75), (ub - 0.05, 3.35), (ub - 0.2, 3.35)], 0.012, srgb(0x353b40))
            quadp(fr, [(ub - 0.05, 0.75), (ub - 0.2, 0.75), (ua + 0.05, 3.35), (ua + 0.2, 3.35)], 0.012, srgb(0x353b40))
        mrect(fr, mid - 0.05, 0.12, mid + 0.05, FENCE_H, 0.012, srgb(0x22272b))
        pbox('fit', fr, mid, 1.15, 0.05, 0.16, 0.22, 0.08, M_STEEL)
        tube('fit', fr, [(mid - 0.5, 1.28, 0.06), (mid - 0.2, 1.15, 0.08), (mid, 1.15, 0.08), (mid + 0.25, 1.2, 0.08), (mid + 0.5, 1.28, 0.06)], 0.012, n=4, tint=M_STEEL)
        plate(fr, mid, 3.55, 3.4, 0.62, srgb(0x1a1d20), M_WHT, 'STATION 7', 0.36, border=M_YEL, z=0.016)
        label(fr, mid, 2.47, 0.016, 'ALL VISITORS REPORT TO OFFICE', 0.12, M_WHT)
        for u in (mid - 3.0, mid + 3.0):
            lathe('fit', fr, u, 0.14, [(0.0, 4.9), (0.1, 4.9), (0.1, 5.0), (0.075, 5.14), (0.0, 5.2)], n=8, tint=M_ORG)
            circle(fr, u, 5.02, 0.245, 0.0, M_WARM, 'glyph', 3)
        pbox('glyph', fr, mid - 3.0, 5.02, 0.22, 0.12, 0.05, 0.05, M_WARM)
        pbox('glyph', fr, mid + 3.0, 5.02, 0.22, 0.12, 0.05, 0.05, M_WARM)
    # the corner watchtowers
    for ti, (sx, sz) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
        cx, cz = sx * (HX + 4.5), sz * (HZ + 4.5)
        for k in range(4):
            sf = Frame(cx, 6.0, cz, k * math.pi / 2)
            for xm in (-1.05, -0.35, 0.35, 1.05):
                pbox('fit', sf, xm, 1.4, 1.52, 0.05, 0.8, 0.05, M_STEEL)
            rb('fit', sf, 0, 0.95, 1.58, 3.1, 0.06, 0.18, 0.025, M_STEEL)
            label(sf, 0, 0.25, 1.506, 'T%d' % (ti + 1), 0.4, M_WHT)
            hazard(sf, -1.4, 1.4, 2.12, 2.28, 1.506, pitch=0.3)
        # a searchlight on the roof, looking in over the yard, and two aerials
        look = math.atan2(-cx, -cz)
        sl = Frame(cx, 6.0 + 2.74, cz, look)
        pbox('fit', sl, 0, 0.2, 0, 0.3, 0.4, 0.3, M_STEEL)
        lathe('fit', sl, 0.0, 0.62, [(0.0, -0.18), (0.21, -0.18), (0.24, -0.02), (0.24, 0.42), (0.0, 0.42)], n=12, tint=M_STEEL, ax='z')
        circle(sl, 0.0, 0.62, 0.425, 0.2, M_WARM, 'glyph', 14)
        for ax_, az_ in ((-1.2, -1.2), (1.2, 1.2)):
            tube('fit', Frame(cx, 6.0 + 2.74, cz), [(ax_, 0.0, az_), (ax_, 2.6, az_)], 0.012, n=5, tint=M_STEEL)
        # a ladder up the field side, between the legs: two rails and a rung every 0.36 m
        for dz in (-0.2, 0.2):
            tube('fit', Frame(), [(cx - sx * 1.69, 0.0, cz + dz), (cx - sx * 1.3, 6.0, cz + dz)], 0.02, n=5, tint=M_STEEL)
        for k in range(1, 17):
            yy = k * 0.36
            pbox('fit', Frame(), cx - sx * (1.69 - 0.39 * yy / 6.0), yy, cz, 0.03, 0.03, 0.44, M_STEEL)


# ------------------------------------------------------------------ the radio mast

def mast_detail():
    # plinth: stripes round the top edge, a plate, a cabinet, and a cable up one leg
    for k in range(4):
        sf = Frame(0.0, 0.0, 0.0, k * math.pi / 2)
        hazard(sf, -1.5, 1.5, 0.72, 0.92, 1.604, pitch=0.35)
        plate(sf, 0.0, 0.3, 1.2, 0.3, srgb(0x1a1d20), M_WHT, 'RADIO MAST 1', 0.12, z=1.604)
    rb('fit', Frame(), -1.43, 1.46, 0.0, 0.3, 0.9, 0.8, 0.03, srgb(0x6b7076))
    pbox('glyph', Frame(), -1.28, 1.7, 0.0, 0.01, 0.1, 0.2, M_SCREEN2)
    h = 24.0
    half = lambda y: 1.2 - (1.2 - 0.35) * (y - 1.0) / (h - 1.0)
    n = int((h - 1.0) // 2.0)
    top = 1.0 + n * 2.0
    tube('fit', Frame(), [(half(1.0) + 0.07, 1.0, half(1.0) + 0.07), (half(top) + 0.07, top, half(top) + 0.07)], 0.02, n=5, tint=M_BLK)
    tube('fit', Frame(), [(-half(1.0) - 0.07, 1.0, half(1.0) + 0.07), (-half(top) - 0.07, top, half(top) + 0.07)], 0.014, n=5, tint=M_STEEL)
    for yy in (12.0,):
        a = half(yy)
        for sx in (-1, 1):
            for sz in (-1, 1):
                pbox('glyph', Frame(), sx * (a + 0.12), yy, sz * (a + 0.12), 0.14, 0.14, 0.14, M_RED)
    # guy wires from the top section to anchors beyond the pond's island
    ytop = 17.0
    a = half(ytop)
    for sx in (-1, 1):
        for sz in (-1, 1):
            tube('fit', Frame(), [(sx * a, ytop, sz * a), (sx * 9.5, 0.35, sz * 9.5)], 0.011, n=3, tint=M_STEEL)
            fquad(Frame(), sx * 9.5 - 0.3, sz * 9.5 - 0.3, sx * 9.5 + 0.3, sz * 9.5 + 0.3, 0.014, M_CONC)
            pbox('fit', Frame(), sx * 9.5, 0.2, sz * 9.5, 0.12, 0.3, 0.12, M_STEEL)


# ------------------------------------------------------------------ station

STX0, STX1, STZ0, STZ1, STT = 18.0, 38.0, 9.0, 16.0, 0.35


def _station_runs(s):
    h = STT / 2
    R = {
        'N': Run(s, STX1 + h, STZ0 - h, math.pi, (STX1 - STX0) + STT),
        'S': Run(s, STX0 - h, STZ1 + h, 0.0, (STX1 - STX0) + STT),
        'W': Run(s, STX0 - h, STZ0 - h, -math.pi / 2, (STZ1 - STZ0) + STT),
        'E': Run(s, STX1 + h, STZ1 + h, math.pi / 2, (STZ1 - STZ0) + STT),
        'Ni': Run(s, STX0 + h, STZ0 + h, 0.0, (STX1 - STX0) - STT),
        'Si': Run(s, STX1 - h, STZ1 - h, math.pi, (STX1 - STX0) - STT),
        'Wi': Run(s, STX0 + h, STZ1 - h, math.pi / 2, (STZ1 - STZ0) - STT),
        'Ei': Run(s, STX1 - h, STZ0 + h, -math.pi / 2, (STZ1 - STZ0) - STT),
    }
    return R


def _uh(run, name, v):
    """Position along a run of the world coordinate v (x for the long walls, z for the short)."""
    return run.u_of(v, run.z) if name in ('N', 'S', 'Ni', 'Si') else run.u_of(run.x, v)


def station_exterior(s):
    R = _station_runs(s)
    H = CEIL_Y
    wins = (21.0, 24.0, 32.0, 35.0)
    # fixtures on the long walls, in one table so the panel joints know to stop short of them
    fix = {'N': [(22.9, 'vent'), (25.9, 'meter'), (30.1, 'junction'), (33.5, 'ext'), (36.6, 'lamp')],
           'S': [(19.8, 'lamp'), (22.5, 'ext'), (25.9, 'vent'), (30.1, 'junction')]}
    for name in ('N', 'S', 'W', 'E'):
        run = R[name]
        fr = run.fr()
        long_ = name in ('N', 'S')
        holes = [(_uh(run, name, x), 0.7, 1.1, 2.1) for x in wins] if long_ else []
        doors = [_uh(run, name, 28.0 if long_ else 12.475)]
        blocks = [(u - 0.95, u + 0.95, 0.9, 2.45) for (u, _w, _y0, _y1) in holes]
        blocks += [(u - 1.05, u + 1.05, 0.0, 3.4) for u in doors]
        for (x, _kind) in fix.get(name, []):
            u = _uh(run, name, x)
            blocks.append((u - 0.45, u + 0.45, 0.4, 3.0))
        txt = []
        if name == 'N':
            txt = [(_uh(run, name, 22.9), 'SNOW RESEARCH STATION', 0.38), (_uh(run, name, 33.5), 'BLOCK A', 0.38)]
        elif name == 'S':
            txt = [(_uh(run, name, 20.5), 'STATION 7', 0.4), (_uh(run, name, 35.8), 'MAIN BUILDING', 0.34)]
        for (u, text, ph) in txt:
            wdt = text_w(text, ph)
            blocks.append((u - wdt / 2 - 0.1, u + wdt / 2 + 0.1, 2.55, 3.3))
        seams(run, 1.25, 0.45, H - 0.05, blocks, srgb(0x3a1410), z=0.002)
        for (u, text, ph) in txt:
            label(fr, u, 2.7, 0.006, text, ph, M_WHT)
        for (x, kind) in fix.get(name, []):
            u = _uh(run, name, x)
            if kind == 'vent':
                vent_grille(fr, u, 1.25, 0.5)
            elif kind == 'junction':
                junction(fr, u, 1.7)
            elif kind == 'ext':
                extinguisher(fr, u)
            elif kind == 'lamp':
                cage_lamp(fr, u, 2.6)
            else:
                pbox('fit', fr, u, 1.55, 0.05, 0.22, 0.3, 0.1, srgb(0xbfc5ca))
                circle(fr, u, 1.58, 0.106, 0.09, M_WHT, 'mark', 12)
                mrect(fr, u - 0.006, 1.58, u + 0.006, 1.66, 0.112, M_RED)
        # an entrance sign over each door, a mat, a boot trail and a shovel
        for u in doors:
            fr_d = run.fr(u)
            word = 'MAIN ENTRANCE' if long_ else ('ENTRANCE' if name == 'W' else 'STAFF ONLY')
            label(fr_d, 0.0, 3.1, 0.006, word, 0.22, M_WHT)
            fquad(fr_d, -0.65, 0.08, 0.65, 0.5, 0.186, M_PLATE)
            for k in range(11):
                fquad(fr_d, (-0.2 if k % 2 else 0.08), 0.95 + k * 0.66, (-0.08 if k % 2 else 0.2), 1.28 + k * 0.66, 0.012, M_PRINT)
            plate(fr_d, 1.25, 1.55, 0.3, 0.2, M_BLUE, M_WHT, 'D%d' % (1 + 'NSWE'.index(name)), 0.14)
            tube('fit', fr_d, [(-1.25, 0.05, 0.28), (-1.25, 1.5, 0.06)], 0.015, n=5, tint=M_WOODD)
            pbox('fit', fr_d, -1.25, 0.17, 0.28, 0.26, 0.03, 0.3, M_STEEL)
        # snow on the sills, and icicles under the fascia
        for (u, w, y0, y1) in holes:
            rb('mound', run.fr(u), 0, y0 + 0.02, 0.1, 2 * w + 0.32, 0.06, 0.16, 0.025)
        sk = tuple((u - 1.1, u + 1.1) for u in doors)
        icicles(fr, 0.3, run.L - 0.3, H, 0.01, 0.34, 0.1, 0.5, skip=sk)
        if long_:
            downspout(fr, 0.28, H - 0.05)
            downspout(fr, run.L - 0.28, H - 0.05)
    # the roof: a hat on each vent stack, a skylight frame, a duct between stacks, an anemometer
    yr = CEIL_Y + 0.35
    for vx, vz in ((22.0, 12.0), (34.0, 11.0), (30.5, 14.0)):
        fv = F(s, vx, vz, 0.0, yr)
        lathe('fit', fv, 0.0, 0.0, [(0.0, 0.8), (0.27, 0.8), (0.0, 0.98)], n=10, tint=M_STEEL)
        for ang in (0.0, 2.1, 4.2):
            tube('fit', fv, [(0.12 * math.cos(ang), 0.72, 0.12 * math.sin(ang)), (0.12 * math.cos(ang), 0.82, 0.12 * math.sin(ang))], 0.012, n=4, tint=M_STEEL)
    fs_ = F(s, 25.0, 13.5, 0.0, yr)
    upoly(fs_, [(-0.75, 0.364, -0.4), (0.75, 0.364, -0.4), (0.75, 0.364, 0.4), (-0.75, 0.364, 0.4)], M_GLASS, 'glyph')
    for sg in (-1, 1):
        pbox('fit', fs_, sg * 0.4, 0.37, 0.0, 0.025, 0.014, 0.82, M_STEEL)
    tube('fit', F(s, 0, 0, 0.0, yr), [(22.0, 0.1, 12.0), (22.0, 0.1, 12.6), (34.0, 0.1, 12.6), (34.0, 0.1, 11.0)], 0.05, n=6, tint=M_STEEL)
    fa = F(s, 37.0, 10.0, 0.0, yr)
    tube('fit', fa, [(0, 0, 0), (0, 2.8, 0)], 0.025, n=6, tint=M_STEEL)
    for k in range(3):
        a = k * 2 * math.pi / 3
        tube('fit', fa, [(0, 2.8, 0), (0.28 * math.cos(a), 2.8, 0.28 * math.sin(a))], 0.01, n=4, tint=M_STEEL)
        lathe('fit', fa, 0.3 * math.cos(a), 0.3 * math.sin(a), [(0.0, 2.74), (0.06, 2.78), (0.06, 2.84), (0.0, 2.84)], n=8, tint=M_WHT)
    pbox('fit', fa, 0, 2.5, 0, 0.1, 0.1, 0.1, M_STEEL)


def _ceiling(fr, pts, tint, key='mark'):
    """A decal on a ceiling: faces down."""
    if newell(pts)[1] > 0:
        pts = pts[::-1]
    poly(key, fr, pts, tint)


def station_interior(s):
    R = _station_runs(s)
    H = CEIL_Y
    Ni, Si, Wi, Ei = R['Ni'], R['Si'], R['Wi'], R['Ei']
    # wainscot up to a chair rail, broken at the doorways, each with a surround and an exit sign
    door_u = {'Ni': _uh(Ni, 'Ni', 28.0), 'Si': _uh(Si, 'Si', 28.0), 'Wi': _uh(Wi, 'Wi', 12.475), 'Ei': _uh(Ei, 'Ei', 12.475)}
    for name in ('Ni', 'Si', 'Wi', 'Ei'):
        run = R[name]
        fr = run.fr()
        u = door_u[name]
        for a, b in ((0.0, u - 0.7), (u + 0.7, run.L)):
            mrect(fr, a, 0.1, b, 1.0, 0.006, M_SAGE)
            mrect(fr, a, 0.0, b, 0.1, 0.006, M_SKIRT)
            mrect(fr, a, 1.0, b, 1.06, 0.006, M_RAIL)
        mrect(fr, u - 0.76, 0.0, u - 0.7, 2.46, 0.006, M_RAIL)
        mrect(fr, u + 0.7, 0.0, u + 0.76, 2.46, 0.006, M_RAIL)
        mrect(fr, u - 0.76, 2.4, u + 0.76, 2.46, 0.006, M_RAIL)
        plate(fr, u, 2.55, 0.62, 0.22, M_EXIT, M_WHT, 'EXIT', 0.11, z=0.01, key='tglyph')
    # the hall's partitions, both faces, with a name over each doorway
    parts = {'WestPartW': (Run(s, 25.9, STZ0 + STT / 2, -math.pi / 2, 6.65), 12.475 - 9.175, 'HALL'),
             'HallPartW': (Run(s, 26.1, STZ1 - STT / 2, math.pi / 2, 6.65), 15.825 - 12.475, 'OFFICE'),
             'HallPartE': (Run(s, 29.9, STZ0 + STT / 2, -math.pi / 2, 6.65), 12.475 - 9.175, 'LAB'),
             'EastPartE': (Run(s, 30.1, STZ1 - STT / 2, math.pi / 2, 6.65), 15.825 - 12.475, 'HALL')}
    for nm, (run, uc, word) in parts.items():
        fr = run.fr()
        for a, b in ((0.0, uc - 0.7), (uc + 0.7, run.L)):
            mrect(fr, a, 0.1, b, 1.0, 0.006, M_SAGE)
            mrect(fr, a, 0.0, b, 0.1, 0.006, M_SKIRT)
            mrect(fr, a, 1.0, b, 1.06, 0.006, M_RAIL)
        plate(fr, uc, 2.5, 1.0, 0.26, srgb(0x1a1d20), M_WHT, word, 0.14, z=0.01)
    # posters, a clock and notices in the clear spans between window holes and furniture
    poster(Ni, _uh(Ni, 'Ni', 19.3), 1.3, 'chart')
    poster(Ni, _uh(Ni, 'Ni', 30.7), 1.3, 'safety', 0.5, 0.7)
    poster(Ni, _uh(Ni, 'Ni', 33.5), 1.3, 'plan')
    poster(Ni, _uh(Ni, 'Ni', 36.8), 1.3, 'chart')
    poster(Si, _uh(Si, 'Si', 19.3), 1.3, 'rules', 0.55, 0.8)
    poster(Si, _uh(Si, 'Si', 33.5), 1.3, 'map')
    clock(Si.fr(), _uh(Si, 'Si', 22.5), 2.6)
    poster(Wi, _uh(Wi, 'Wi', 10.4), 1.3, 'plan')
    poster(Wi, _uh(Wi, 'Wi', 14.7), 1.3, 'map')
    poster(Ei, _uh(Ei, 'Ei', 14.5), 1.3, 'chart')
    noticeboard(Ni.fr(), _uh(Ni, 'Ni', 26.7), 1.25, 0.8, 0.6)
    noticeboard(Si.fr(), _uh(Si, 'Si', 26.7), 1.25, 0.8, 0.6)
    extinguisher(Ni.fr(), _uh(Ni, 'Ni', 29.3))
    fr = Si.fr()
    u = _uh(Si, 'Si', 29.3)
    mrect(fr, u - 0.2, 1.3, u + 0.2, 1.7, 0.006, M_WHT)
    mrect(fr, u - 0.18, 1.32, u + 0.18, 1.68, 0.012, M_EXIT)
    mrect(fr, u - 0.03, 1.4, u + 0.03, 1.6, 0.018, M_WHT)
    mrect(fr, u - 0.1, 1.47, u + 0.1, 1.53, 0.018, M_WHT)
    for run, name, x in ((Ni, 'Ni', 29.65), (Si, 'Si', 29.7)):
        u = _uh(run, name, x)
        mrect(run.fr(), u - 0.04, 1.2, u + 0.04, 1.32, 0.006, M_WHT)
        mrect(run.fr(), u - 0.05, 0.35, u + 0.05, 0.45, 0.006, M_WHT)
    # the ceiling: strip fixtures where the lamps are, duct runs between the partitions, grilles
    for lx in (22.0, 28.0, 34.0):
        fx = F(s, lx, 12.5, 0.0, H - 0.05)
        rb('fit', fx, 0, 0, 0, 1.3, 0.08, 0.26, 0.025, M_STEEL)
        _ceiling(fx, [(-0.55, -0.045, -0.09), (0.55, -0.045, -0.09), (0.55, -0.045, 0.09), (-0.55, -0.045, 0.09)], M_WARM, 'glyph')
    for (xa, xb) in ((18.4, 25.7), (26.3, 29.7), (30.3, 37.6)):
        fd = F(s, (xa + xb) / 2, 10.0, 0.0, H - 0.3)
        rb('fit', fd, 0, 0, 0, xb - xa, 0.26, 0.38, 0.03, M_STEEL)
        for k in range(1, int((xb - xa) // 1.4)):
            pbox('fit', fd, -(xb - xa) / 2 + k * 1.4, 0, 0, 0.04, 0.28, 0.4, M_DARK)
        tube('fit', F(s, 0, 0, 0.0, H - 0.45), [(xa + 0.1, 0, 15.2), (xb - 0.1, 0, 15.2)], 0.035, n=6, tint=M_STEEL)
    for gx in (21.0, 34.0):
        fg = F(s, gx, 14.0, 0.0, H - 0.01)
        _ceiling(fg, [(-0.3, 0, -0.3), (0.3, 0, -0.3), (0.3, 0, 0.3), (-0.3, 0, 0.3)], M_BLK)
        for k in range(-2, 3):
            _ceiling(fg, [(-0.3, -0.006, k * 0.1 - 0.012), (0.3, -0.006, k * 0.1 - 0.012), (0.3, -0.006, k * 0.1 + 0.012), (-0.3, -0.006, k * 0.1 + 0.012)], M_STEEL)
    # the floor: safety lines down the hall with a gap at the doorways, an exit legend at each end,
    # a rug in the office, a taped box round the cold store
    for lx in (26.75, 29.25):
        for (za, zb) in ((9.4, 11.5), (13.4, 15.6)):
            floor_rect(s, lx - 0.05, za, lx + 0.05, zb, 0.008, M_FLOOR_L)
    type_floor(F(s, 28.0, 10.6, 0.0, 0.01), 'EXIT', 0.4, M_WHT)
    type_floor(F(s, 28.0, 15.2, math.pi, 0.01), 'EXIT', 0.4, M_WHT)
    floor_rect(s, 21.4, 10.2, 24.4, 12.4, 0.01, srgb(0x7a2e2a))
    floor_rect(s, 21.55, 10.35, 24.25, 12.25, 0.016, srgb(0xa84a42))
    floor_rect(s, 35.4, 9.6, 37.4, 12.2, 0.01, M_FLOOR_L)
    floor_rect(s, 35.5, 9.7, 37.3, 12.1, 0.016, srgb(0x6a6e72))
    # the research office: a monitor, a keyboard and a mouse at each end of the desk, a mug and papers
    for zc in (11.7, 13.3):
        fm = F(s, 20.05, zc, math.pi / 2, 1.0)
        pbox('fit', fm, 0, 0.01, 0, 0.18, 0.02, 0.14, M_DARK)
        pbox('fit', fm, 0, 0.09, 0, 0.04, 0.14, 0.04, M_DARK)
        pbox('fit', fm, 0, 0.33, 0, 0.5, 0.32, 0.035, M_DARK)
        mrect(fm, -0.22, 0.19, 0.22, 0.47, 0.0185, M_SCREEN, 'glyph')
        for k in range(5):
            mrect(fm, -0.19, 0.24 + k * 0.045, -0.19 + 0.12 + 0.2 * rnd(), 0.255 + k * 0.045, 0.0195, M_WHT, 'glyph')
        pbox('fit', fm, 0, 0.01, 0.3, 0.38, 0.02, 0.14, M_DARK)
        pbox('fit', fm, 0.3, 0.008, 0.3, 0.06, 0.016, 0.1, M_DARK)
    fm = F(s, 20.3, 12.5, 0.0, 1.0)
    lathe('fit', fm, 0.0, 0.0, [(0.0, 0.0), (0.04, 0.0), (0.04, 0.09), (0.0, 0.09)], n=8, tint=M_WHT)
    pbox('fit', fm, 0.1, 0.005, 0.0, 0.3, 0.01, 0.2, M_PAPER)
    # the lab counter: a pot, three beakers, a rack of test tubes and a microscope
    for i, bx in enumerate((33.0, 34.2, 34.5, 34.9)):
        w_, h_ = (0.18, 0.11, 0.1, 0.09)[i], (0.16, 0.2, 0.2, 0.2)[i]
        lathe('fit', F(s, bx, 15.3, 0.0, 1.0), 0, 0, [(0.0, 0.0), (w_, 0.0), (w_, h_), (w_ * 0.7, h_ + 0.04), (0.0, h_ + 0.04)], n=10,
              tint=M_GLASS if i else M_STEEL)
    pbox('fit', F(s, 32.7, 15.5, 0.0, 1.0), 0, 0.015, 0, 0.5, 0.03, 0.1, M_STEEL)
    for k in range(5):
        lathe('fit', F(s, 32.5 + k * 0.1, 15.5, 0.0, 1.0), 0, 0, [(0.012, 0.03), (0.012, 0.19), (0.0, 0.19)], n=6, tint=M_GLASS)
    fmic = F(s, 35.3, 15.4, 0.0, 1.0)
    pbox('fit', fmic, 0, 0.015, 0, 0.16, 0.03, 0.22, M_DARK)
    tube('fit', fmic, [(0, 0.03, 0.08), (0, 0.3, 0.08), (0, 0.4, 0.0)], 0.022, n=6, tint=M_STEEL)
    tube('fit', fmic, [(0, 0.12, -0.02), (0, 0.4, -0.02)], 0.028, n=6, tint=M_DARK)
    # the cold store
    cs = F(s, 36.3, 11.0, -math.pi / 2, 0.0)
    plate(cs, 0.0, 1.45, 0.62, 0.24, srgb(0x1a1d20), M_WHT, 'COLD STORE', 0.08, z=0.006)
    plate(cs, 0.0, 1.15, 0.3, 0.16, srgb(0x0a0d0f), M_SCREEN2, '-20', 0.1, border=srgb(0x30363b), z=0.006, key='tglyph')
    pbox('fit', cs, 0.22, 1.0, 0.04, 0.03, 0.4, 0.05, M_STEEL)


def station_detail(s):
    station_exterior(s)
    station_interior(s)


# ------------------------------------------------------------------ tank farm

def tank_detail(fr, r, h, idx):
    a = r * math.cos(math.pi / 12) + 0.004
    names = ('FUEL', 'DIESEL', 'HEATING')
    fw_ = 0.5176 * r                # width of one flat of the 12-sided shell
    for k, kind in ((5, 'name'), (6, 'id'), (3, 'gauge'), (8, 'plate')):
        tc = (k + 0.5) * math.pi / 6
        nx, nz = -math.sin(tc), math.cos(tc)
        c = fr.world((nx * a, 0.0, nz * a))
        fp = Frame(c[0], 0.0, c[2], fr.yaw - tc)
        if kind == 'name':
            nm = names[idx % 3]
            label(fp, 0.0, 2.3, 0.0, nm, fw(nm, fw_ * 0.85, 0.22), M_BLK)
            mrect(fp, -fw_ * 0.4, 2.0, fw_ * 0.4, 2.1, 0.0, M_RED)
            mrect(fp, -fw_ * 0.4, h - 0.5, fw_ * 0.4, h - 0.44, 0.0, M_RED)
        elif kind == 'id':
            label(fp, 0.0, 1.7, 0.0, 'T-%d' % (idx + 1), 0.22, M_BLK)
            e = 0.1                 # four diamonds of half-diagonal 0.095 round one point
            for (dx, dy, tint) in ((0, e, M_RED), (-e, 0, M_BLUE), (e, 0, M_YEL), (0, -e, M_WHT)):
                quadp(fp, [(dx - 0.095, 2.9 + dy), (dx, 2.9 + dy - 0.095), (dx + 0.095, 2.9 + dy), (dx, 2.9 + dy + 0.095)], 0.0, tint)
            hazard(fp, -fw_ * 0.35, fw_ * 0.35, 0.9, 1.2, 0.0, pitch=0.2)
        elif kind == 'gauge':
            tube('fit', fp, [(0.0, 0.5, 0.03), (0.0, h - 0.7, 0.03)], 0.022, n=6, tint=M_GLASS)
            for kk in range(10):
                mrect(fp, 0.04, 0.6 + kk * (h - 1.4) / 9, 0.16, 0.615 + kk * (h - 1.4) / 9, 0.0, M_WHT)
            pbox('fit', fp, 0.0, 0.45, 0.03, 0.1, 0.1, 0.07, M_STEEL)
            pbox('fit', fp, 0.0, h - 0.65, 0.03, 0.1, 0.1, 0.07, M_STEEL)
        else:
            plate(fp, 0.0, 1.8, min(0.6, fw_ * 0.8), 0.34, srgb(0x1a1d20), M_WHT, 'CAP 40 KL', 0.07, z=0.0)
    # handrail on the lid, anchor bolts at the foot
    for k in range(6):
        ang = k * math.pi / 3 + 0.3
        x, z = 0.78 * r * math.cos(ang), 0.78 * r * math.sin(ang)
        tube('fit', fr, [(x, h + 0.22, z), (x, h + 0.95, z)], 0.02, n=5, tint=M_STEEL)
    torus('fit', fr, 0, h + 0.92, 0, 0.78 * r, 0.018, n=14, m=4, tint=M_STEEL)
    torus('fit', fr, 0, h + 0.55, 0, 0.78 * r, 0.014, n=14, m=4, tint=M_STEEL)
    for k in range(8):
        ang = k * math.pi / 4 + 0.2
        pbox('fit', fr, (r + 0.18) * math.cos(ang), 0.27, (r + 0.18) * math.sin(ang), 0.05, 0.04, 0.05, M_STEEL)
        pbox('fit', fr, (r + 0.18) * math.cos(ang), 0.31, (r + 0.18) * math.sin(ang), 0.03, 0.07, 0.03, M_STEEL)


_tank_layout = tank
_tank_n = [0]


def tank(s, x, z, r=1.6, h=4.8, seed=1):
    _tank_layout(s, x, z, r, h, seed)
    tank_detail(F(s, x, z), r, h, _tank_n[0])
    _tank_n[0] += 1


def bund_detail(s):
    # the outer faces of the 1 m bund walls: a hazard band at the foot and a stencil above it
    for (xa, xb, txt) in ((26.0, 31.0, 'FUEL STORE'), (34.0, 41.25, 'NO NAKED FLAME')):
        run = Run(s, xb, 21.25, math.pi, xb - xa)
        fr = run.fr()
        hazard(fr, 0.0, xb - xa, 0.08, 0.26, 0.006)
        label(fr, (xb - xa) / 2, 0.5, 0.006, txt, fw(txt, xb - xa - 0.6, 0.3), M_BLK)
    run = Run(s, 41.25, 32.25, math.pi / 2, 10.5)
    hazard(run.fr(), 0.0, 10.5, 0.08, 0.26, 0.006)
    label(run.fr(), 5.25, 0.5, 0.006, 'TANK FARM', 0.3, M_BLK)
    run = Run(s, 26.0, 32.75, 0.0, 15.25)
    hazard(run.fr(), 0.0, 15.25, 0.08, 0.26, 0.006)
    label(run.fr(), 7.6, 0.5, 0.006, 'FLAMMABLE LIQUID', 0.3, M_BLK)
    for (z0, z1) in ((21.75, 25.0), (28.0, 32.25)):
        run = Run(s, 25.75, z0, -math.pi / 2, z1 - z0)
        hazard(run.fr(), 0.0, z1 - z0, 0.08, 0.26, 0.006)
    label(F(s, 25.75, 23.4, -math.pi / 2), 0.0, 0.5, 0.006, 'NO SMOKING', 0.22, M_BLK)
    # transfer lines between the tanks, above head height, with a flange at each end and the middle
    a, b, c = (30.5, 27.0, 1.7), (37.0, 25.5, 1.6), (37.2, 30.0, 1.3)

    def pt(p, q, y):
        dx, dz = q[0] - p[0], q[1] - p[1]
        d = math.hypot(dx, dz)
        return (p[0] + dx / d * p[2], y, p[1] + dz / d * p[2])
    for (p, q) in ((a, b), (b, c)):
        p0, q0 = pt(p, q, 3.4), pt(q, p, 3.4)
        w0 = F(s, p0[0], p0[2]).o
        w1 = F(s, q0[0], q0[2]).o
        tube('fit', Frame(), [(w0[0], 3.4, w0[2]), (w1[0], 3.4, w1[2])], 0.07, n=8, tint=M_STEEL)
        for fr_ in (0.1, 0.5, 0.9):
            m = (w0[0] + (w1[0] - w0[0]) * fr_, 3.4, w0[2] + (w1[2] - w0[2]) * fr_)
            ang = math.atan2(w1[0] - w0[0], w1[2] - w0[2])
            torus('fit', Frame(m[0], m[1], m[2], ang), 0, 0, 0, 0.09, 0.025, ax='z', n=10, m=4, tint=M_STEEL)


# ------------------------------------------------------------------ motor pool

MPX0, MPX1, MPZ0, MPZ1, MPT = -36.0, -22.0, 14.0, 24.0, 0.35


def _bu(run, x):
    """u along a run of the half's own world x."""
    return run.u_of(x, run.z)


def motor_pool_detail(s):
    h = MPT / 2
    H = CEIL_Y
    Bi = Run(s, MPX1 + h, MPZ1 - h, math.pi, (MPX1 - MPX0) + MPT)
    Wi = Run(s, MPX0 + h, MPZ1 - h, math.pi / 2, MPZ1 - MPZ0 - h)
    Ei = Run(s, MPX1 - h, MPZ0, -math.pi / 2, MPZ1 - MPZ0 - h)
    Bo = Run(s, MPX0 - h, MPZ1 + h, 0.0, (MPX1 - MPX0) + MPT)
    Wo = Run(s, MPX0 - h, MPZ0, -math.pi / 2, MPZ1 - MPZ0 + h)
    Eo = Run(s, MPX1 + h, MPZ1 + h, math.pi / 2, MPZ1 - MPZ0 + h)
    Fa = Run(s, MPX1 + h, MPZ0, math.pi, (MPX1 - MPX0) + MPT)
    # the garage's name along the front fascia (the roof slab is 0.35 thick, 4.0 to 4.35)
    label(Fa.fr(), Fa.L / 2, 4.07, 0.006, 'MOTOR POOL   SNOWCAT SERVICE', 0.24, M_WHT)
    # the back wall inside: a painted dado under a hazard band, the name, a tool board and notices
    fr = Bi.fr()
    mrect(fr, 0.0, 0.1, Bi.L, 1.0, 0.006, srgb(0x4a4f52))
    mrect(fr, 0.0, 0.0, Bi.L, 0.1, 0.006, M_SKIRT)
    hazard(fr, 0.0, Bi.L, 1.0, 1.1, 0.006, pitch=0.3)
    label(fr, _bu(Bi, -29.0), 2.62, 0.006, 'MOTOR POOL', 0.38, M_YEL)
    u0 = _bu(Bi, -31.0)
    mrect(fr, u0 - 0.1, 1.15, u0 + 3.1, 2.55, 0.006, M_WOODD)
    for k in range(8):
        for j in range(5):
            circle(fr, u0 + 0.2 + k * 0.38, 1.35 + j * 0.24, 0.012, 0.014, M_BLK, 'mark', 5)
    for nm, off in (('hammer', 0.3), ('spanner', 0.9), ('saw', 1.6), ('pliers', 2.3), ('spanner', 2.8)):
        ux = u0 + off
        if nm == 'hammer':
            mrect(fr, ux - 0.012, 1.4, ux + 0.012, 1.95, 0.018, M_STEEL)
            mrect(fr, ux - 0.07, 1.95, ux + 0.07, 2.04, 0.018, M_DARK)
        elif nm == 'spanner':
            mrect(fr, ux - 0.014, 1.4, ux + 0.014, 2.1, 0.018, M_STEEL)
            circle(fr, ux, 2.14, 0.018, 0.05, M_STEEL, 'mark', 8)
            circle(fr, ux, 2.14, 0.024, 0.025, srgb(0x4a4f52), 'mark', 8)
        elif nm == 'saw':
            quadp(fr, [(ux - 0.03, 1.5), (ux + 0.12, 1.5), (ux + 0.12, 2.15), (ux - 0.03, 1.9)], 0.018, M_STEEL)
            mrect(fr, ux - 0.06, 1.4, ux + 0.02, 1.52, 0.018, M_RED)
        else:
            mrect(fr, ux - 0.03, 1.4, ux + 0.03, 1.7, 0.018, M_RED)
            quadp(fr, [(ux - 0.05, 1.7), (ux + 0.05, 1.7), (ux + 0.01, 2.0), (ux - 0.01, 2.0)], 0.018, M_STEEL)
    noticeboard(fr, _bu(Bi, -34.7), 1.45, 0.6, 0.5)
    extinguisher(fr, _bu(Bi, -23.3))
    clock(fr, _bu(Bi, -25.0), 2.7)
    # the side walls inside, and a sign over the east doorway
    for run in (Wi, Ei):
        fr = run.fr()
        mrect(fr, 0.0, 0.1, run.L, 1.0, 0.006, srgb(0x4a4f52))
        mrect(fr, 0.0, 0.0, run.L, 0.1, 0.006, M_SKIRT)
        hazard(fr, 0.0, run.L, 1.0, 1.1, 0.006, pitch=0.3)
    poster(Wi, 4.0, 1.5, 'safety')
    poster(Wi, 7.0, 1.5, 'plan')
    plate(Ei.fr(), Ei.u_of(Ei.x, 19.65), 2.45, 1.3, 0.26, M_EXIT, M_WHT, 'EXIT', 0.14, z=0.01, key='tglyph')
    # outside: icicles and a downspout on three walls, the back wall's name, vents and a junction box
    for run in (Bo, Wo, Eo):
        icicles(run.fr(), 0.3, run.L - 0.3, H, 0.01, 0.36, 0.1, 0.5)
        downspout(run.fr(), 0.28, H - 0.05)
    label(Bo.fr(), Bo.L / 2, 2.6, 0.006, 'VEHICLE STORE', 0.4, M_BLK)
    vent_grille(Bo.fr(), _bu(Bo, -33.0), 1.3, 0.7, 0.5)
    vent_grille(Bo.fr(), _bu(Bo, -25.0), 1.3, 0.7, 0.5)
    junction(Bo.fr(), _bu(Bo, -29.5), 1.5)
    label(Wo.fr(), Wo.L / 2, 2.6, 0.006, 'KEEP CLEAR', 0.3, M_BLK)
    plate(Eo.fr(), Eo.u_of(Eo.x, 19.65), 3.0, 1.4, 0.3, M_BLUE, M_WHT, 'STAFF', 0.16)
    # the two front posts: hazard stripes on every face, and a band under the roof
    for px in (-31.3, -26.7):
        for k in range(4):
            pf = F(s, px, MPZ0 + 0.15, k * math.pi / 2)
            hazard(pf, -0.15, 0.15, 0.0, 1.2, 0.156, pitch=0.2)
            hazard(pf, -0.15, 0.15, 1.8, 1.9, 0.156, pitch=0.2)
    # the floor: bay lines and names, oil, and the snowcat's tracks out over the snow
    for (x0, x1, z0, z1) in ((-34.7, -30.5, 15.6, 22.4), (-26.7, -23.9, 16.6, 22.4)):
        floor_rect(s, x0, z0, x1, z0 + 0.1, 0.01, M_FLOOR_L)
        floor_rect(s, x0, z1 - 0.1, x1, z1, 0.01, M_FLOOR_L)
        floor_rect(s, x0, z0, x0 + 0.1, z1, 0.01, M_FLOOR_L)
        floor_rect(s, x1 - 0.1, z0, x1, z1, 0.01, M_FLOOR_L)
    type_floor(F(s, -32.6, 15.0, math.pi, 0.012), 'BAY 1', 0.45, M_WHT)
    type_floor(F(s, -25.3, 16.15, math.pi, 0.012), 'BAY 2', 0.3, M_WHT)
    for (cx, cz, rr) in ((-32.8, 19.5, 0.5), (-30.2, 17.5, 0.35), (-33.0, 22.9, 0.4), (-28.4, 21.0, 0.3)):
        blob(F(s, cx, cz), 0, 0, rr, M_OIL, 0.012, 9)
    # tread marks in the snow out of the open front: two thin lines for each track, a little wavy
    for tx in (-33.8, -31.4):
        for dx in (-0.24, 0.24):
            xa, z = tx + dx, 14.0
            while z > 6.0:
                xb = xa + (rnd() - 0.5) * 0.12
                upoly(F(s, 0.0, 0.0), [(xa - 0.035, 0.009, z), (xb - 0.035, 0.009, z - 1.2), (xb + 0.035, 0.009, z - 1.2), (xa + 0.035, 0.009, z)],
                      srgb(0xaab5c0))
                xa, z = xb, z - 1.2
        floor_rect(s, tx - 0.3, 14.0, tx + 0.3, 15.7, 0.016, srgb(0x6a7076))
    # the work bench: a vice, a pencil-sharpened bolt tin, papers, a can and a clamp
    fb = F(s, -35.3, 20.0, math.pi / 2, 1.0)
    pbox('fit', fb, -0.9, 0.12, 0.1, 0.22, 0.24, 0.3, M_STEEL)
    pbox('fit', fb, -0.9, 0.28, 0.1, 0.1, 0.1, 0.12, M_DARK)
    tube('fit', fb, [(-0.9, 0.3, 0.16), (-0.9, 0.3, 0.3)], 0.012, n=5, tint=M_STEEL)
    pbox('fit', fb, 0.2, 0.006, 0.0, 0.5, 0.012, 0.3, M_PAPER)
    lathe('fit', fb, 0.9, -0.1, [(0.0, 0.0), (0.06, 0.0), (0.06, 0.16), (0.03, 0.2), (0.0, 0.2)], n=8, tint=M_RED)
    pbox('fit', fb, 0.5, 0.02, 0.2, 0.3, 0.04, 0.08, M_STEEL)


# the snowcat: a number on the hull, stripes on the blade, lamps, mirrors and a roof bar
_snowcat_layout = snowcat


def snowcat(s, x, z, yaw=0.0):
    _snowcat_layout(s, x, z, yaw)
    fr = F(s, x, z, yaw)
    ink = srgb(0x1b1b1b)
    # the flat of the hull's side (the box is rounded 0.2, so only y 1.1 to 1.3 is flat)
    for sg, yo in ((1, math.pi / 2), (-1, -math.pi / 2)):
        c = fr.world((sg * 0.85, 0.0, 0.35))
        sf = Frame(c[0], 0.0, c[2], fr.yaw + yo)
        label(sf, 0.0, 1.1, 0.004, 'SNOWCAT 2', 0.18, ink)
        # a mirror on an arm out of the cab's front corner
        m = fr.world((sg * 1.2, 2.15, -1.1))
        a = fr.world((sg * 1.0, 2.15, -1.1))
        tube('fit', Frame(), [a, m], 0.012, n=4, tint=M_STEEL)
        pbox('fit', Frame(m[0], m[1], m[2], fr.yaw), 0.0, 0.0, 0.0, 0.05, 0.2, 0.12, M_DARK)
    # hazard stripes on the face of the plough blade (its front face is at z = -2.43)
    c = fr.world((0.0, 0.0, -2.43))
    hazard(Frame(c[0], 0.0, c[2], fr.yaw + math.pi), -1.4, 1.4, 0.2, 0.9, 0.004, pitch=0.5)
    # headlights on the hull front (flat to x 0.65 and y 1.1 to 1.3)
    for sx in (-0.5, 0.5):
        c = fr.world((sx, 1.2, -1.5))
        lf = Frame(c[0], c[1], c[2], fr.yaw + math.pi)
        rb('fit', lf, 0, 0, 0, 0.28, 0.16, 0.1, 0.03, M_DARK)
        circle(lf, 0, 0, 0.052, 0.06, M_WARM, 'glyph', 10)
    # rear lamps and a number plate
    for sx in (-0.5, 0.5):
        c = fr.world((sx, 1.2, 2.2))
        pbox('glyph', Frame(c[0], c[1], c[2], fr.yaw), 0, 0, 0, 0.16, 0.1, 0.03, M_RED)
    cr = fr.world((0.0, 0.0, 2.205))
    plate(Frame(cr[0], 0.0, cr[2], fr.yaw), 0.0, 1.1, 0.5, 0.18, M_WHT, M_BLK, 'SC-02', 0.1, border=M_BLK)
    # a lamp bar across the front of the cab roof
    c = fr.world((0.0, 2.6, -1.04))
    pbox('fit', Frame(c[0], c[1], c[2], fr.yaw), 0, 0, 0, 1.8, 0.12, 0.1, M_DARK)
    for sx in (-0.7, -0.23, 0.23, 0.7):
        c = fr.world((sx, 2.6, -1.095))
        pbox('glyph', Frame(c[0], c[1], c[2], fr.yaw), 0, 0, 0, 0.18, 0.08, 0.02, M_WARM)


# ------------------------------------------------------------------ containers, crates, lamp posts, woodpile

_NAMES = ('NORDLINE', 'HALCYON', 'KESTREL', 'BOREAL', 'TIDEWAY')
_cn = [0]


def container_name(fr, tint):
    n = _cn[0]
    _cn[0] += 1
    L, W, H = 6.06, 2.44, 2.59
    lum = 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2]
    ink = srgb(0x14161a) if lum > 0.2 else srgb(0xeae6da)
    stripe = srgb(0xe2dccb) if lum < 0.2 else srgb(0x232629)
    name = _NAMES[(n * 2 + 1) % len(_NAMES)]
    ph = min(0.4, 3.0 * 7.0 / (len(name) * 6 - 1))
    grime = tuple(c * 0.5 for c in tint)
    for side, yaw in ((0, 0.0), (1, math.pi)):
        sf = turn(fr, yaw)
        z = W / 2 + 0.05
        mrect(sf, -L / 2 + 0.3, 2.0, L / 2 - 0.3, 2.07, z, stripe)
        label(sf, -0.4, 1.4, z + 0.004, name, ph, ink)
        label(sf, L / 2 - 1.0, 2.24, z + 0.004, 'NLXU %06d' % ((n * 7919 + 1234 + side * 100) % 1000000), 0.09, ink)
        mrect(sf, -L / 2 + 0.3, 0.13, L / 2 - 0.3, 0.4, z, grime)
        for _ in range(3):
            ux = (rnd() - 0.5) * (L - 1.2)
            ln = 0.3 + rnd() * 0.7
            mrect(sf, ux - 0.04, H - 0.18 - ln, ux + 0.04, H - 0.18, z + 0.005, srgb(0x6a3a1e))
    # the closed end: a name plate; the door end: a data plate and lock labels
    ef = turn(fr, -math.pi / 2)
    mrect(ef, -0.95, 1.0, 0.95, 1.7, L / 2 + 0.005, srgb(0xd8d3c4))
    label(ef, 0.0, 1.16, L / 2 + 0.01, name, fw(name, 1.7, 0.36), srgb(0x1b1d20))
    # the door end: a data plate on the left leaf, between two lock bars (the bars stand 6 cm proud)
    df = turn(fr, math.pi / 2)
    mrect(df, 0.44, 1.2, 0.68, 1.42, L / 2 + 0.012, srgb(0xcfcab8))
    for k in range(4):
        mrect(df, 0.47, 1.24 + k * 0.045, 0.65 - 0.07 * (k % 2), 1.262 + k * 0.045, L / 2 + 0.018, M_BLK)


_container_layout = container


def container(s, x, z, along_x, tint, h=2.59):
    _container_layout(s, x, z, along_x, tint, h)
    container_name(F(s, x, z, 0.0 if along_x else math.pi / 2), tint)


_CRATE_TXT = ('SUPPLIES', 'SAMPLES', 'RATIONS', 'SPARES')
_ct = [0]


def crate_detail(fr, size, h):
    hs = size / 2
    strap = srgb(0x2c2f33)
    txt = _CRATE_TXT[_ct[0] % 4]
    _ct[0] += 1
    for side in range(4):
        sf = turn(fr, side * math.pi / 2)
        z = hs + 0.004
        mrect(sf, -hs, h * 0.45, hs, h * 0.45 + 0.05, z, strap)
        mrect(sf, -hs, h * 0.12, hs, h * 0.12 + 0.04, z, strap)
        if side % 2:
            continue
        label(sf, 0.0, h * 0.62, z + 0.003, txt, fw(txt, size * 0.7, 0.12), M_BLK)
        mrect(sf, -size * 0.3, h * 0.78, -size * 0.15, h * 0.9, z + 0.003, M_WHT)
        mrect(sf, size * 0.15, h * 0.2, size * 0.18, h * 0.38, z + 0.003, M_BLK)
        quadp(sf, [(size * 0.12, h * 0.38), (size * 0.21, h * 0.38), (size * 0.165, h * 0.46)], z + 0.003, M_BLK)
    top = Frame(fr.o[0], fr.o[1] + h + 0.004, fr.o[2], fr.yaw)
    for _ in range(2):
        blob(top, (rnd() - 0.5) * size * 0.5, (rnd() - 0.5) * size * 0.5, 0.08 + 0.08 * rnd(), srgb(0x6a6c6e), 0.0, 7, 0.3)


_crate_layout = crate


def crate(s, x, z, size=1.2, h=1.0, base=0.0, yaw=0.0):
    _crate_layout(s, x, z, size, h, base, yaw)
    crate_detail(F(s, x, z, yaw, base), size, h)


_lamp_layout = lamp_post
_lp = [0]


def lamp_post(s, x, z, yaw=0.0, h=4.4):
    _lamp_layout(s, x, z, yaw, h)
    fr = F(s, x, z, yaw)
    _lp[0] += 1
    for k in range(4):
        sf = turn(fr, k * math.pi / 2)
        hazard(sf, -0.07, 0.07, 0.55, 1.15, 0.074, pitch=0.12)
        if k % 2 == 0:
            label(sf, 0.0, 1.6, 0.074, 'L%d' % _lp[0], 0.075, M_BLK)
    # a junction box on the pole's back (the 0.14 pole's face is at z 0.07)
    pbox('fit', fr, 0.0, 2.2, 0.11, 0.16, 0.26, 0.08, M_STEEL, skip=('-z',))
    pbox('fit', fr, 0.0, 2.2, 0.155, 0.12, 0.2, 0.01, M_DARK, skip=('-z',))


_woodpile_layout = woodpile


def woodpile(s, x, z, along_x=True, length=2.6):
    _woodpile_layout(s, x, z, along_x, length)
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2)
    # a blue tarp over half of the pile, draped over the front, tied down
    poly('paint', fr, [(-length / 2 + 0.05, 1.02, 0.5), (0.2, 1.02, 0.5), (0.2, 1.02, -0.5), (-length / 2 + 0.05, 1.02, -0.5)], M_TARP)
    poly('paint', fr, [(-length / 2 + 0.05, 1.02, 0.5), (-length / 2 + 0.05, 0.7, 0.58), (0.2, 0.7, 0.58), (0.2, 1.02, 0.5)], M_TARP)
    for ux in (-length / 2 + 0.2, -0.3):
        tube('fit', fr, [(ux, 1.02, 0.5), (ux, 0.72, 0.58)], 0.01, n=4, tint=M_BLK)


# ------------------------------------------------------------------ the ground

# the footprints (south half; mirrored through the origin for the north) that wind ripples must not hide under
_BLOCK = ((17.0, 39.0, 8.0, 17.0), (25.0, 42.0, 20.5, 33.5), (-37.0, -21.0, 13.0, 25.0), (-14.0, 14.0, 27.0, 35.0),
          (-4.5, 4.5, 15.5, 20.0), (38.5, 42.0, 1.5, 8.5), (-42.5, -39.0, 15.5, 22.5), (32.0, 37.0, 1.0, 6.0),
          (17.5, 22.5, 27.0, 32.0), (-13.0, 13.0, 8.0, 24.0))


def _blocked(x, z):
    for sg in (1, -1):
        for (a, b, c, d) in _BLOCK:
            if a <= sg * x <= b and c <= sg * z <= d:
                return True
    return False


def ground_detail():
    for s in (1, -1):
        # ruts down the road from the yard to the container, and the stop line and road text
        for tx in (-0.9, 0.9):
            for z0 in (30.5, 27.5, 24.5, 21.5):
                floor_rect(s, tx - 0.1, z0 - 2.0, tx + 0.1, z0, 0.007, srgb(0x777e84))
            for z0 in (15.6, 12.6, 9.6):
                floor_rect(s, tx - 0.1, z0 - 2.0, tx + 0.1, z0, 0.007, srgb(0x777e84))
        floor_rect(s, -2.4, 21.75, 2.4, 22.05, 0.008, M_WHT)
        type_floor(F(s, -1.2, 21.2, 0.0, 0.009), 'STOP', 0.7, M_WHT)
        type_floor(F(s, -1.2, 30.2, 0.0, 0.009), 'SLOW', 0.7, M_WHT)
    # the pond (an ellipse 12.5 by 8.5 round a plinth of 3.2): cracks that run out from the plinth, and glints
    for k in range(7):
        a = (k + rnd() * 0.5) * 2 * math.pi / 7
        px, pz = 2.4 * math.cos(a), -2.4 * math.sin(a)
        ang = a + (rnd() - 0.5) * 0.6
        for j in range(5):
            ln = 0.7 + rnd() * 1.1
            ang += (rnd() - 0.5) * 0.9
            nx, nz = px + ln * math.cos(ang), pz - ln * math.sin(ang)
            if (nx / 12.0) ** 2 + (nz / 8.0) ** 2 >= 1.0:
                break
            dx, dz = nx - px, nz - pz
            d = math.hypot(dx, dz)
            ox, oz = -dz / d * 0.012, dx / d * 0.012
            upoly(Frame(), [(px - ox, 0.013, pz - oz), (nx - ox, 0.013, nz - oz), (nx + ox, 0.013, nz + oz), (px + ox, 0.013, pz + oz)], srgb(0xe4eef4))
            px, pz = nx, nz
    for k in range(6):
        a = k * math.pi / 3 + 0.5
        blob(Frame(), 7.0 * math.cos(a), -4.5 * math.sin(a), 0.6 + 0.4 * rnd(), srgb(0xb7cfdd), 0.008, 8, 0.4)
    # THIN ICE on a post at each corner of the pond, read from both sides
    for (sx, sz) in ((-9.0, -6.8), (9.0, -6.8), (-9.0, 6.8), (9.0, 6.8)):
        yaw = math.atan2(sx, sz)
        base = Frame(sx, 0.0, sz, yaw)
        tube('fit', base, [(0, 0, 0), (0, 1.5, 0)], 0.03, n=6, tint=M_STEEL)
        for side in (0.0, math.pi):
            fr = Frame(sx, 0.0, sz, yaw + side)
            plate(fr, 0.0, 1.0, 0.7, 0.55, M_YEL, M_BLK, None, border=M_BLK, z=0.034)
            label(fr, 0.0, 1.32, 0.04, 'THIN', 0.14, M_BLK)
            label(fr, 0.0, 1.12, 0.04, 'ICE', 0.14, M_RED)
    # wind ripples on open snow
    n = 0
    while n < 40:
        x = (rnd() * 2 - 1) * (HX - 4)
        z = (rnd() * 2 - 1) * (HZ - 4)
        ang = 0.5 + (rnd() - 0.5) * 0.4
        ln, wd = 0.7 + rnd() * 1.0, 0.05 + rnd() * 0.04
        if (x / 14.0) ** 2 + (z / 10.0) ** 2 < 1.0 or _blocked(x, z):
            continue
        n += 1
        c, s_ = math.cos(ang), math.sin(ang)
        pts = [(x - c * ln / 2, 0.009, z - s_ * ln / 2), (x - s_ * wd, 0.009, z + c * wd), (x + c * ln / 2, 0.009, z + s_ * ln / 2),
               (x + s_ * wd, 0.009, z - c * wd)]
        upoly(Frame(), pts, srgb(0xc2cdd9))

# ------------------------------------------------------------------ entry

def per_side_detail(s):
    station_detail(s)
    bund_detail(s)
    motor_pool_detail(s)


def snow_detail():
    fence_detail()
    mast_detail()
    ground_detail()
    both(per_side_detail)
