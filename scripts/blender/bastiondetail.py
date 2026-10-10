"""
bastiondetail: the second pass over BASTION. Exec'd by build_bastion.py after the layout's own
functions (so it can wrap slit, window, torch, hang_banner, crate, well, stone, pine and tower_viz)
and before `result = ...`. build_layout() calls bastion_detail() just before rk_finalize().

Everything here is scenery:
    - the gate: a shield and the keep's name on the lintel, studs, ring and plank seams on the folded
      doors, spiked portcullis bars, a door in each gate tower; the curtain: copings, rain streaks,
      repair patches, moss at the foot, POSTERN plates; torch soot, window boxes, banner borders and
      charges (a tower for blue, a saltire for red)
    - the flag hall: a panelled dado, the keep's shield and name, wall trophies and a weapon rack,
      a team ring and a name inlaid round the plinth, a bunting line, lanterns, roof courses
    - the barracks: a door with a name plate, window boxes and glazing, roof courses, gutters and
      downpipes, gable windows, chimney pots; crates with stencils, nails and plank seams, a well
      with a sign, a damp ring and a course of stone
    - the flank walls and back wall: rain streaks, repairs, slits, vines, banners and copings; the
      towers: courses, roof ribs and rings; the ruins: windows, lichen, fallen capstones, ivy
    - the ground: a processional way, cart ruts and puddles, straw, moss, wild flowers and tufts of
      grass; pine needle beds, roots and branch stubs; carved notches on the standing stones
    - far off: doors and windows on the hamlet, a gallery and lattice on the mills

Nothing here emits a collider and nothing moves one: bastion.json stays as it was. Below 4.2 m the
only touch keys the ghost probe looks at are grass, paving, castle, rock, wood, slates and trunk;
this file adds only to fit, mark, glyph, tmark, tglyph, tuft and the existing non-touch keys. Decals
that share a key share one polygon offset, so they are layered at least 5 mm apart.
"""
exec(open(os.path.join(REPO, 'scripts', 'blender', 'detailkit.py')).read())
seed(13420613)

M_IRON = srgb(0x3a3d41)
M_IRON_L = srgb(0x5c6066)
M_BRASS = srgb(0xb08d3a)
M_RUST = srgb(0x7a4a2c)
M_CREAM = srgb(0xe6dcc0)
M_SOOT = srgb(0x26231f)
M_STREAK = srgb(0x5d594e)
M_STREAK_D = srgb(0x48453c)
M_MOSS = srgb(0x55672e)
M_MOSS_L = srgb(0x6f7f3a)
M_LICHEN = srgb(0x9a9e75)
M_LICHEN_O = srgb(0xa98a40)
M_DAMP = srgb(0x4a4d46)
M_NEEDLE = srgb(0x4b3b27)
M_STRAW = srgb(0xc9b06a)
M_PAVE_L = srgb(0xa59f91)
M_PAVE_D = srgb(0x625e55)
M_WAIN = srgb(0x5a4430)
M_WAIN_D = srgb(0x3b2c1e)
M_PATCH = srgb(0x948e7e)
M_JOINT = srgb(0x4b473f)
M_VINE = srgb(0x35432a)
M_RUT = srgb(0x5b4630)
M_PUDDLE = srgb(0x7f97a6)
M_GLASS = srgb(0x6f8da3)
M_WARM = srgb(0xfff0c8)
M_PLANK_D = srgb(0x2a1f15)
M_FLOWERS = [srgb(0xf0eee0), srgb(0xe8c840), srgb(0x9a74c4), srgb(0xd0503f)]
M_TUFT = [srgb(h) for h in (0x4f6b2f, 0x5c7a36, 0x6a8740, 0x7f8f3f)]
TEAM_DARK = {1: srgb(0x1c3a58), -1: srgb(0x741f1a)}
TEAM_NAME = {1: 'BLUE KEEP', -1: 'RED KEEP'}
TEAM_CHARGE = {1: 'tower', -1: 'saltire'}


def _side(cloth):
    return 1 if cloth == TEAM_CLOTH[1] else -1


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


def plate(fr, u, y, w, h, bg, fg, text, ph=None, border=M_CREAM, z=0.006, key='tmark'):
    """A sign plate with a border and one line of text."""
    mrect(fr, u - w / 2, y, u + w / 2, y + h, z, border)
    mrect(fr, u - w / 2 + 0.022, y + 0.022, u + w / 2 - 0.022, y + h - 0.022, z + 0.006, bg)
    if text:
        ph = ph or fw(text, w - 0.1, h * 0.55)
        type_label(fr, u, y + (h - ph) / 2, z + 0.008, text, ph, fg, key)


def stud(fr, u, y, z, r=0.03, h=0.024, tint=M_IRON, key='fit'):
    """A square-based nail head on a vertical face: four triangles."""
    a = [(u - r, y - r), (u + r, y - r), (u + r, y + r), (u - r, y + r)]
    for i in range(4):
        p, q = a[i], a[(i + 1) % 4]
        poly(key, fr, [(p[0], p[1], z), (q[0], q[1], z), (u, y, z + h)], tint)


def vblob(fr, u, y, rx, ry, tint, z=0.004, n=9, jitter=0.3, key='mark'):
    """An irregular patch on a vertical face."""
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        k = 1.0 - jitter + jitter * 2 * rnd()
        pts.append((u + rx * k * math.cos(a), y + ry * k * math.sin(a), z))
    poly(key, fr, pts, tint)


def streak(fr, u, ytop, ln, w, tint, z=0.004):
    """A rain streak running down a wall from ytop."""
    quadp(fr, [(u - w / 2, ytop), (u + w / 2, ytop), (u + w * 0.3, ytop - ln), (u - w * 0.3, ytop - ln)], z, tint)


def rain(fr, u0, u1, ytop, step=1.2, lo=0.7, hi=2.6, z=0.004, tints=None):
    """Dark water stains down a wall: thin, uneven and darker than the stone, never bars of light."""
    tints = tints or (M_STREAK, M_STREAK_D)
    u = u0 + step * 1.4 * rnd()
    while u < u1:
        streak(fr, u, ytop, lo + (min(hi, 2.0) - lo) * rnd() ** 1.8, 0.035 + 0.055 * rnd(), tints[int(rnd() * len(tints))], z)
        u += step * 1.4 * (0.55 + 0.9 * rnd())


def patches(fr, u0, u1, y0, y1, count, z=0.004):
    """Lichen, moss and lighter repair stones scattered over a face."""
    for _ in range(count):
        u, y = u0 + (u1 - u0) * rnd(), y0 + (y1 - y0) * rnd()
        k = rnd()
        if k < 0.4:
            vblob(fr, u, y, 0.14 + 0.16 * rnd(), 0.1 + 0.1 * rnd(), M_LICHEN, z, n=7)
        elif k < 0.65:
            vblob(fr, u, y, 0.08 + 0.1 * rnd(), 0.07 + 0.08 * rnd(), M_LICHEN_O, z, n=6)
        elif k < 0.9:
            vblob(fr, u, y, 0.16 + 0.2 * rnd(), 0.12 + 0.16 * rnd(), M_MOSS, z, n=7)
        else:
            w, h = 0.45 + 0.4 * rnd(), 0.25 + 0.2 * rnd()
            mrect(fr, u - w / 2, y - h / 2, u + w / 2, y + h / 2, z, M_PATCH)


def leaf_blob(fr, u, y, z, r, tint):
    """A small dome of leaves standing out of a wall face."""
    lathe('pine', fr, u, y, [(r, z), (r * 0.78, z + r * 0.5), (0.0, z + r * 0.72)], n=5, tint=tint, sharp=80.0, ax='z')


def vine(fr, u, y0, y1, z=0.04):
    """A wandering stem up a face with a dome of leaves at every bend."""
    n = max(3, int((y1 - y0) / 0.55))
    ph = rnd() * 6.0
    pts = [(u + 0.16 * math.sin(ph + i * 1.3), y0 + (y1 - y0) * i / n, z) for i in range(n + 1)]
    tube('pine', fr, pts, 0.026, n=3, tint=M_VINE, caps=False)
    for p in pts[1:]:
        leaf_blob(fr, p[0] + (rnd() - 0.5) * 0.2, p[1] + (rnd() - 0.5) * 0.2, 0.03, 0.07 + 0.06 * rnd(), GREENS[int(rnd() * 4)])


# the heater shield: a convex outline, 0..1 in height, -1..1 in width
_SHIELD = [(-1.0, 1.0), (1.0, 1.0), (1.0, 0.45), (0.78, 0.22), (0.4, 0.07), (0.0, 0.0), (-0.4, 0.07), (-0.78, 0.22), (-1.0, 0.45)]


def charge(fr, u, y, sz, kind, tint, z, bg=None, key='mark'):
    """The charge on a shield or a banner: a keep (blue) or a saltire (red). Centre u, y."""
    if kind == 'tower':
        quadp(fr, [(u - 0.3 * sz, y - 0.45 * sz), (u + 0.3 * sz, y - 0.45 * sz), (u + 0.3 * sz, y + 0.25 * sz),
                   (u - 0.3 * sz, y + 0.25 * sz)], z, tint, key)
        for k in (-1, 0, 1):
            cx = u + k * 0.22 * sz
            quadp(fr, [(cx - 0.08 * sz, y + 0.25 * sz), (cx + 0.08 * sz, y + 0.25 * sz), (cx + 0.08 * sz, y + 0.43 * sz),
                       (cx - 0.08 * sz, y + 0.43 * sz)], z, tint, key)
        if bg is not None:
            quadp(fr, [(u - 0.08 * sz, y - 0.45 * sz), (u + 0.08 * sz, y - 0.45 * sz), (u + 0.08 * sz, y - 0.1 * sz),
                       (u - 0.08 * sz, y - 0.1 * sz)], z + 0.006, bg, key)
    else:
        for sg in (-1, 1):
            d = (0.7071, 0.7071 * sg)
            n = (-d[1], d[0])
            p0 = (u - d[0] * 0.4 * sz, y - d[1] * 0.4 * sz)
            p1 = (u + d[0] * 0.4 * sz, y + d[1] * 0.4 * sz)
            hw = 0.075 * sz
            quadp(fr, [(p0[0] + n[0] * hw, p0[1] + n[1] * hw), (p1[0] + n[0] * hw, p1[1] + n[1] * hw),
                       (p1[0] - n[0] * hw, p1[1] - n[1] * hw), (p0[0] - n[0] * hw, p0[1] - n[1] * hw)], z, tint, key)


def shield(fr, u, y, w, h, field, border, s, z=0.006, bar=M_CREAM):
    """A heraldic shield on a wall: border, field and the keep's charge, layered 6 mm apart."""
    quadp(fr, [(u + p[0] * w / 2, y + p[1] * h) for p in _SHIELD], z, border)
    quadp(fr, [(u + p[0] * w * 0.4, y + 0.06 * h + p[1] * 0.86 * h) for p in _SHIELD], z + 0.006, field)
    charge(fr, u, y + 0.56 * h, w * 0.55, TEAM_CHARGE[s], bar, z + 0.012, field)


def round_shield(fr, u, y, r, tint, z=0.03, n=14):
    """A round shield with a rim and a boss, hung flat on a face."""
    poly('banner', fr, [(u + r * math.cos(2 * math.pi * i / n), y + r * math.sin(2 * math.pi * i / n), z) for i in range(n)], tint)
    quadp(fr, [(u - r * 0.14, y - r), (u + r * 0.14, y - r), (u + r * 0.14, y + r), (u - r * 0.14, y + r)], z + 0.008, M_CREAM, 'banner')
    torus('metal', fr, u, y, z, r, 0.022, ax='z', n=n, m=3)
    lathe('metal', fr, u, y, [(r * 0.3, z + 0.01), (r * 0.24, z + 0.07), (0.0, z + 0.1)], n=8, ax='z')


def trophy(fr, u, y, s):
    """A round shield over two crossed spears."""
    for sg in (-1, 1):
        a = (u - sg * 0.7, y - 0.6, 0.05)
        b = (u + sg * 0.7, y + 0.75, 0.05)
        tube('timber', fr, [a, b], 0.017, n=4)
        d = (b[0] - a[0], b[1] - a[1])
        ln = math.hypot(d[0], d[1])
        tip = (b[0] + d[0] / ln * 0.2, b[1] + d[1] / ln * 0.2, 0.05)
        tube('metal', fr, [b, tip], [0.026, 0.004], n=4, caps=False)
    round_shield(fr, u, y, 0.34, TEAM_CLOTH[s], 0.07)


def roof_courses(fr, xa, ya, xb, yb, z0, z1, n, tint, off=0.012, w=0.035):
    """Lines across a pitched face, from the eave (xa, ya) to the ridge (xb, yb), along z."""
    L = math.hypot(xb - xa, yb - ya)
    ux, uy = (xb - xa) / L, (yb - ya) / L
    nx, ny = -uy, ux
    if ny < 0:
        nx, ny = -nx, -ny
    for i in range(1, n):
        t = i / n * L
        px, py = xa + ux * t + nx * off, ya + uy * t + ny * off
        qx, qy = px + ux * w, py + uy * w
        facing('mark', fr, [(px, py, z0), (qx, qy, z0), (qx, qy, z1), (px, py, z1)], tint, (nx, ny, 0.0))


def roof_patches(fr, xa, ya, xb, yb, z0, z1, count, tint, off=0.014):
    """Fresh slates and moss on a pitched face."""
    L = math.hypot(xb - xa, yb - ya)
    ux, uy = (xb - xa) / L, (yb - ya) / L
    nx, ny = -uy, ux
    if ny < 0:
        nx, ny = -nx, -ny
    for _ in range(count):
        t = (0.12 + 0.76 * rnd()) * L
        z = z0 + (z1 - z0) * (0.06 + 0.88 * rnd())
        wl, wz = 0.3 + 0.5 * rnd(), 0.35 + 0.6 * rnd()
        px, py = xa + ux * t + nx * off, ya + uy * t + ny * off
        qx, qy = px + ux * wl, py + uy * wl
        c = tint[int(rnd() * len(tint))] if isinstance(tint, list) else tint
        facing('mark', fr, [(px, py, z), (qx, qy, z), (qx, qy, z + wz), (px, py, z + wz)], c, (nx, ny, 0.0))


def arched_leaf(fr, cx, w, h_rect, rise, z, tint, key='timber', n=8):
    """A door leaf: a rectangle with a segmental head."""
    hw = w / 2
    pts = [(cx - hw, 0.0), (cx + hw, 0.0), (cx + hw, h_rect)]
    for i in range(1, n):
        x = -hw + w * (n - i) / n
        pts.append((cx + x, h_rect + rise * (1.0 - (x / hw) ** 2)))
    pts.append((cx - hw, h_rect))
    quadp(fr, pts, z, tint, key)


# ------------------------------------------------------------------ wrapped pieces

_slit_layout = slit


def slit(ff, x, y0, y1, w=0.2):
    _slit_layout(ff, x, y0, y1, w)
    # a stain running down from under the sill
    streak(ff, x + (rnd() - 0.5) * 0.06, y0 - 0.12, 0.5 + 1.3 * rnd(), 0.09 + 0.08 * rnd(), M_STREAK_D, 0.004)


_torch_layout = torch


def torch(ff, x, y, reach=0.4):
    _torch_layout(ff, x, y, reach)
    # an iron plate behind the arm and the soot the flame leaves above it
    pbox('fit', ff, x, y - 0.1, 0.013, 0.12, 0.2, 0.026, M_IRON)
    quadp(ff, [(x - 0.1, y + 0.4), (x + 0.1, y + 0.4), (x + 0.04, y + 1.0), (x - 0.04, y + 1.0)], 0.004, M_STREAK_D)


_hang_banner_layout = hang_banner


def hang_banner(ff, x, ytop, w, h, cloth, z=0.07):
    _hang_banner_layout(ff, x, ytop, w, h, cloth, z)
    s = _side(cloth)
    hw, cols = w / 2, 6

    def zz(xx):
        i = (xx - (x - hw)) / (w / cols)
        i0 = max(0, min(cols - 1, int(i)))
        f = i - i0
        a = z + 0.035 * math.sin(i0 * 1.7)
        b = z + 0.035 * math.sin((i0 + 1) * 1.7)
        return a + (b - a) * f

    def ybot(xx):
        return ytop - h + 0.55 * (1.0 - abs(xx - x) / hw)
    for sg in (-1, 1):                  # a cream border down both edges
        xe, xi = x + sg * hw, x + sg * (hw - 0.09)
        poly('banner', ff, [(xe, ytop, zz(xe) + 0.008), (xe, ybot(xe), zz(xe) + 0.008), (xi, ybot(xi), zz(xi) + 0.008),
                            (xi, ytop, zz(xi) + 0.008)], TRIM_CLOTH)
    xs = [x - hw + w * i / cols for i in range(cols + 1)]
    for i in range(cols):               # and a band under the rod
        poly('banner', ff, [(xs[i], ytop - 0.22, zz(xs[i]) + 0.008), (xs[i + 1], ytop - 0.22, zz(xs[i + 1]) + 0.008),
                            (xs[i + 1], ytop - 0.34, zz(xs[i + 1]) + 0.008), (xs[i], ytop - 0.34, zz(xs[i]) + 0.008)], TRIM_CLOTH)
    charge(ff, x, ytop - h * 0.42, 0.55, TEAM_CHARGE[s], TEAM_DARK[s], z + 0.062, TRIM_CLOTH, key='banner')


_window_layout = window


def window(ff, x, y, w=0.9, h=1.15, shutters=True):
    _window_layout(ff, x, y, w, h, shutters)
    # sky in the glass, a transom, and a box of flowers under the sill
    poly('mark', ff, [(x - w * 0.42, y + h * 0.2, 0.126), (x - w * 0.12, y + h * 0.2, 0.126), (x + w * 0.1, y + h * 0.86, 0.126),
                      (x - w * 0.2, y + h * 0.86, 0.126)], M_GLASS)
    mrect(ff, x - w / 2, y + h * 0.64, x + w / 2, y + h * 0.64 + 0.03, 0.134, M_PLANK_D)
    pbox('timber', ff, x, y - 0.33, 0.22, w + 0.1, 0.18, 0.2, WHITE, skip=('-y',))
    for k in range(3):
        fx = x - w * 0.3 + w * 0.3 * k
        lathe('pine', ff, fx, 0.2, [(0.12, y - 0.24), (0.1, y - 0.1), (0.0, y - 0.04)], n=5,
              tint=GREENS[k % 4], sharp=80.0)
        lathe('pine', ff, fx + 0.04, 0.24, [(0.05, y - 0.1), (0.0, y - 0.03)], n=4,
              tint=M_FLOWERS[(k + int(x * 3)) % 4], sharp=80.0)
    if shutters:
        for sx in (-1, 1):              # slats and hinges on each shutter
            cx = x + sx * (w / 2 + 0.3)
            for j in range(3):
                mrect(ff, cx - 0.16, y + 0.2 + j * h * 0.3, cx + 0.16, y + 0.2 + j * h * 0.3 + 0.025, 0.178, M_PLANK_D)
            for yy in (y + 0.12, y + h - 0.12):
                pbox('fit', ff, cx - sx * 0.18 + sx * 0.0, yy, 0.18, 0.13, 0.04, 0.02, M_IRON)


_brazier_layout = brazier


def brazier(fr, cx, cz):
    _brazier_layout(fr, cx, cz)
    for k in range(3):
        a = k * 2.1 + 0.4
        tube('timber', fr, [(cx + 0.2 * math.cos(a), 0.78, cz + 0.2 * math.sin(a)),
                            (cx - 0.15 * math.cos(a), 0.98, cz - 0.15 * math.sin(a))], 0.06, n=5)
    blob(fr, cx, cz, 0.7, M_SOOT, 0.012, 9, 0.3)


_crate_layout = crate
_CRATE_TXT = ('ARROWS', 'BOLTS', 'GRAIN', 'SALT', 'OIL', 'STORES', 'RATIONS', 'PITCH')
_ct = [0]


def crate(s, x, z, size=1.4, h=1.0, base=0.0, key='wood', yaw=0.0):
    _crate_layout(s, x, z, size, h, base, key, yaw)
    fr = F(s, x, z, yaw, base)
    hs = size / 2
    txt = _CRATE_TXT[_ct[0] % len(_CRATE_TXT)]
    _ct[0] += 1
    for side in range(4):
        sf = turn(fr, side * math.pi / 2)
        zf = hs + 0.004
        if side % 2 == 0:
            label(sf, -size * 0.2, h * 0.68, zf, txt, fw(txt, size * 0.5, 0.11), srgb(0x2b2118))
        for sx in (-1, 1):
            for yy in (h * 0.2, h * 0.8):
                stud(sf, sx * (hs - 0.0375), yy, hs, 0.02, 0.016)
        mrect(sf, -hs + 0.08, h * 0.5 - 0.01, hs - 0.08, h * 0.5 + 0.01, zf, M_PLANK_D)
    top = Frame(fr.o[0], fr.o[1] + h + 0.004, fr.o[2], fr.yaw)
    for k in (-1, 1):
        fquad(top, -hs + 0.1, k * size / 6 - 0.012, hs - 0.1, k * size / 6 + 0.012, 0.0, M_PLANK_D)
    blob(top, (rnd() - 0.5) * size * 0.4, (rnd() - 0.5) * size * 0.4, 0.1 + 0.08 * rnd(), srgb(0x6b5b43), 0.0, 7, 0.3)


_well_layout = well


def well(s, x, z):
    _well_layout(s, x, z)
    fr = F(s, x, z)
    for yb in (0.32, 0.64):
        torus('cut', fr, 0, yb, 0, 1.0, 0.02, n=12, m=3)
    # a board hung under the windlass beam, read from both sides, and a damp ring on the paving
    for fa in (0.0, math.pi):
        sf = Frame(fr.o[0], fr.o[1], fr.o[2], fr.yaw + fa)
        pbox('timber', sf, 0, 2.5, 0.085, 0.92, 0.3, 0.05, WHITE)
        label(sf, 0.0, 2.4, 0.112, 'WELL', 0.2, M_CREAM)
        for sx in (-1, 1):
            tube('timber', sf, [(sx * 0.3, 2.82, 0.085), (sx * 0.3, 2.65, 0.085)], 0.01, n=4)
    blob(fr, 0, 0, 1.45, M_DAMP, 0.012, 12, 0.1)
    ivy(fr, 0.0, 0.0, 1.3, 0.28, seed=int(abs(x) * 5 + abs(z)) % 91 + 1)
    ivy(fr, -1.25, 0.0, 0.2, 0.24, seed=int(abs(x) * 3 + abs(z)) % 83 + 1)


_stone_layout = stone


def stone(s, x, z, r=1.4, h=2.8):
    _stone_layout(s, x, z, r, h)
    fr = F(s, x, z)
    if r <= 1.2:
        # a standing stone: carved marks on four of the flats (the flats of the 12-sided shaft are
        # centred on 15 degrees plus a multiple of 30): a short bar, a slant and a notch, repeated
        ap = r * math.cos(math.radians(15.0)) + 0.004
        for k in (1, 4, 7, 10):
            a = math.radians(15.0 + 30.0 * k)
            sf = radial(fr.o, ap, a)
            for j in range(5):
                y = 1.0 + 0.42 * j
                u = 0.12 * ((j * 5) % 3 - 1)
                mrect(sf, u - 0.12, y, u + 0.12, y + 0.035, 0.0, M_JOINT)
                quadp(sf, [(u - 0.09, y + 0.07), (u - 0.05, y + 0.07), (u + 0.09, y + 0.21), (u + 0.05, y + 0.21)], 0.0, M_JOINT)


_pine_layout = pine


def pine(s, x, z, h=6.4, seed=1):
    _pine_layout(s, x, z, h, seed)
    fr = F(s, x, z)
    blob(fr, 0, 0, 2.0 + 0.4 * rnd(), M_NEEDLE, 0.009, 8, 0.35)
    for k in range(3):                  # roots creeping out over the needles
        a = rnd() * 2 * math.pi
        c, sn = math.cos(a), math.sin(a)
        tube('timber', fr, [(0.3 * c, 0.14, 0.3 * sn), (1.2 * c, 0.0, 1.2 * sn)], [0.08, 0.03], n=4, caps=False)
    for k in range(3):                  # stubs of dead branches up the trunk
        a = rnd() * 2 * math.pi
        y = 1.3 + 0.9 * k
        c, sn = math.cos(a), math.sin(a)
        tube('timber', fr, [(0.33 * c, y, 0.33 * sn), (0.85 * c, y - 0.18, 0.85 * sn)], 0.035, n=3, caps=False)


_tower_viz_layout = tower_viz


def tower_viz(fr, r, h, cloth=None, n=24, seed=1):
    _tower_viz_layout(fr, r, h, cloth, n, seed)
    if abs(fr.o[0]) > 60.0 or abs(fr.o[2]) > 70.0:
        return                          # the far keeps are fog
    tall = h > 4.5
    skip = (h * 0.5, h - 1.25) if tall else (h * 0.55,)
    top = h - 1.6 if tall else h - 0.3
    y = 1.25
    while y < top:                      # courses of dressed stone round the shaft: a two-facet ridge
        if all(abs(y - k) > 0.22 for k in skip):
            lathe('cut', fr, 0, 0, [(r + 0.004, y - 0.05), (r + 0.036, y), (r + 0.004, y + 0.05)], n=n, sharp=80.0)
        y += 1.1
    if tall:                            # and the roof: bands and eight ribs to the finial
        R0, y0, H = r + 0.85, h + 0.25, 3.4 + 0.55 * r

        def cone(t):
            return ((R0 - 0.1) * (1 - t) ** 1.25 + 0.012, y0 + 0.24 + H * t)
        for t in (0.3, 0.6):
            rr, yy = cone(t)
            lathe('cut', fr, 0, 0, [(rr + 0.01, yy - 0.05), (rr + 0.05, yy), (rr + 0.01, yy + 0.05)], n=n, sharp=80.0)
        for k in range(6):
            a = 2 * math.pi * k / 6 + 0.2
            pts = [(cone(t)[0] * math.cos(a), cone(t)[1], cone(t)[0] * math.sin(a)) for t in (0.1, 0.45, 0.85)]
            tube('cut', fr, pts, 0.032, n=3, caps=False)
        a = 2.6 + seed * 0.9            # a vine climbing the shaft on the side away from the gate
        vf = radial(fr.o, r - 0.03, a)
        vine(vf, 0.0, 0.5, h * 0.62)
    else:
        a = 1.9 + seed * 0.7
        vine(radial(fr.o, r - 0.03, a), 0.0, 0.3, h - 0.3)


# ------------------------------------------------------------------ the perimeter

def perimeter_detail():
    t = 1.6
    for sx in (-1, 1):
        fz = '-x' if sx > 0 else '+x'
        yaw = FACE_YAW[fz]
        # rain, repairs and lichen along the inner face: the field stretch, then each keep's
        for z0, z1, ytop in ((-40.0, 40.0, 5.95), (40.0, 55.0, 6.45), (-55.0, -40.0, 6.45)):
            ff = Frame(sx * HX, 0.0, z0 if sx > 0 else z1, yaw)
            L = z1 - z0
            rain(ff, 0.4, L - 0.4, ytop, step=1.3, hi=3.2)
            patches(ff, 0.5, L - 0.5, 1.4, 5.4, int(L / 3.0))
        # arrow slits through the keep stretches, between the keeps' windows and above the torches
        for z in (-51.0, -47.0, -43.0, 43.0, 47.0, 51.0):
            slit(Frame(sx * HX, 0.0, z, yaw), 0.0, 3.6, 5.0)
        # vines, and a banner on the field stretch in the colours of the keep nearer to it
        for z in (-50.0, -25.0, 6.0, 33.0, 47.0):
            vine(Frame(sx * HX, 0.0, z, yaw), 0.0, 1.0, 3.6 + 1.6 * rnd())
        for z in (-32.0, -16.0, 8.0, 24.0):
            hang_banner(Frame(sx * HX, 0.0, z, yaw), 0.0, 5.7, 1.2, 3.0, TEAM_CLOTH[1 if z > 0 else -1])
        # a coping on each merlon
        n = int((HZ + t - 40.0) / 2.0)
        for sz in (-1, 1):
            for i in range(n):
                z = sz * (40.0 + (i + 0.5) * (HZ + t - 40.0) / n)
                pbox('cut', Frame(), sx * (HX + t / 2), 7.35, z, t + 0.1, 0.1, 1.1)
    for sz in (-1, 1):
        fz = '-z' if sz > 0 else '+z'
        yaw = FACE_YAW[fz]
        n = int(2 * (HX + t) / 2.0)
        for i in range(n):
            x = -HX - t + (i + 0.5) * 2 * (HX + t) / n
            pbox('cut', Frame(), x, 7.35, sz * (HZ + t / 2), 1.1, 0.1, t + 0.1)
        # the back wall, either side of the hall (which fills the middle of it)
        for xa, xb in ((-HX, -9.2), (9.2, HX)):
            ff = Frame(xa, 0.0, sz * HZ, yaw)
            # '-z' frames run toward -x, '+z' toward +x: keep u measured from the left-hand end
            fx = Frame(xa if sz < 0 else xb, 0.0, sz * HZ, yaw)
            L = xb - xa
            rain(fx, 0.3, L - 0.3, 6.45, step=1.3, hi=3.2)
            patches(fx, 0.5, L - 0.5, 1.4, 5.4, int(L / 3.0))
        for x in (-20.0, 20.0):
            slit(Frame(x, 0.0, sz * HZ, yaw), 0.0, 3.6, 5.0)
        for x in (-12.0, 12.0, -28.0, 28.0):
            hang_banner(Frame(x, 0.0, sz * HZ, yaw), 0.0, 5.8, 1.3, 3.2, TEAM_CLOTH[sz])
        for x in (-30.0, -16.0, 15.0, 30.0):
            vine(Frame(x, 0.0, sz * HZ, yaw), 0.0, 1.0, 4.4 + 1.5 * rnd())


# ------------------------------------------------------------------ the keep

def curtain_detail(s):
    t, zc = 1.4, 40.0
    fr = F(s, 0, zc)
    segs = [(-HX, -22.0), (-18.0, -3.5), (3.5, 18.0), (22.0, HX)]
    for x0, x1 in segs:
        L, xm = x1 - x0, (x0 + x1) / 2
        # rain down both faces, repairs and lichen, moss at the foot, a coping on every merlon
        fin = on_face(fr, x0, t / 2, '+z')
        rain(fin, 0.3, L - 0.3, 5.15, step=1.2, hi=2.4)
        patches(fin, 0.6, L - 0.6, 1.3, 4.6, max(1, int(L / 4.0)))
        fout = on_face(fr, x1, -t / 2, '-z')
        rain(fout, 0.3, L - 0.3, 4.62, step=1.2, hi=2.4)
        patches(fout, 0.6, L - 0.6, 1.3, 4.5, max(1, int(L / 4.0)))
        n = int(L / 2.0)
        for i in range(n):
            x = x0 + (i + 0.5) * L / n
            pbox('cut', F(s, x, zc), 0, CURTAIN + 0.85, 0, 1.1, 0.1, t + 0.1)


def gate_detail(s):
    t, zc = 1.4, 40.0
    fr = F(s, 0, zc)
    # the lintel: the keep's shield between its name and the year, on both faces
    for sz, face in ((-1, '-z'), (1, '+z')):
        ff = on_face(fr, 0.0, sz * 0.9, face)
        shield(ff, 0.0, 4.5, 0.85, 1.0, TEAM_CLOTH[s], M_CREAM, s)
        label(ff, -2.3, 4.78, 0.006, TEAM_NAME[s], 0.26, M_JOINT)
        label(ff, 2.3, 4.78, 0.006, 'AD 1342', 0.26, M_JOINT)
        # the postern lintels carry a name too
        for sx in (-1, 1):
            pf = on_face(fr, sx * 20.0, sz * 0.85, face)
            label(pf, 0.0, 4.3, 0.006, 'POSTERN', 0.24, M_CREAM)
    # the folded doors: plank seams, studs on the straps, a ring pull and rust running from the straps
    for sx in (-1, 1):
        d = F(s, sx * 3.35, zc - 0.9)
        for fa, off in (('+x', 0.1), ('-x', -0.1)):
            ff = on_face(d, off, 0.0, fa)
            for u in (-0.6, -0.3, 0.0, 0.3, 0.6):
                mrect(ff, u - 0.008, 0.06, u + 0.008, 3.74, 0.003, M_PLANK_D)
            for yb in (0.7, 1.9, 3.1):
                for k in range(7):
                    stud(ff, -0.75 + 0.25 * k, yb, 0.04, 0.03, 0.026)
                for k in (-0.6, 0.0, 0.5):
                    streak(ff, k + 0.07 * (yb > 1.0), yb - 0.1, 0.5 + 0.5 * rnd(), 0.05, M_RUST, 0.0035)
            torus('metal', ff, 0.5, 1.3, 0.04, 0.1, 0.016, ax='z', n=10, m=4)
            pbox('fit', ff, 0.5, 1.42, 0.04, 0.06, 0.06, 0.02, M_IRON)
    # the portcullis: spikes at the foot of every bar and a rivet where the rails cross them
    bf = turn(fr, math.pi)
    for i in range(14):
        x = -3.1 + i * 0.475
        lathe('metal', fr, x, -0.15, [(0.0, 3.3), (0.04, 3.46)], n=5)
        for y in (3.7, 4.2):
            stud(bf, -x, y, 0.15 + 0.03, 0.026, 0.02, M_IRON_L)
    # the gate towers: a plank door in an arched surround on the courtyard side, a step in front
    for sx in (-1, 1):
        ft = F(s, sx * 5.7, zc)
        c = ft.world((0.0, 0.0, 2.2 + 0.02))
        fd = Frame(c[0], c[1], c[2], ft.yaw)
        arch_ring('cut', fd, 0.0, 1.4, 1.75, 0.45, 0.26, -0.4, 0.16)
        for sg in (-1, 1):
            vbox('cut', fd, sg * 0.83, 0.88, -0.1, 0.26, 1.78, 0.5, skip=())
        arched_leaf(fd, 0.0, 1.4, 1.75, 0.45, -0.01, WHITE)
        for u in (-0.45, -0.15, 0.15, 0.45):
            mrect(fd, u - 0.008, 0.05, u + 0.008, 2.0, 0.0, M_PLANK_D)
        for yb in (0.45, 1.5):
            pbox('fit', fd, 0.0, yb, 0.015, 1.4, 0.12, 0.03, M_IRON)
            for k in range(5):
                stud(fd, -0.55 + 0.275 * k, yb, 0.03, 0.026, 0.02)
        torus('metal', fd, 0.35, 0.95, 0.03, 0.08, 0.014, ax='z', n=10, m=4)
        fquad(F(s, 0, 0), sx * 5.7 - 1.0, zc + 2.35, sx * 5.7 + 1.0, zc + 3.1, 0.012, M_PAVE_L)


# ------------------------------------------------------------------ the flag hall

def hall_detail(s):
    fr0 = F(s, 0, 0)
    frh = F(s, 0.0, 49.0)
    HW = 8.4
    cloth, dark = TEAM_CLOTH[s], TEAM_DARK[s]
    # ---- the back wall, seen from the hall: dado, rail, team frieze, the shield and the name
    bf = on_face(fr0, 0.0, 53.8, '-z')
    mrect(bf, -7.8, 0.0, 7.8, 1.05, 0.004, M_WAIN)
    mrect(bf, -7.8, 1.05, 7.8, 1.13, 0.006, M_WAIN_D)
    for k in range(-4, 5):
        mrect(bf, k * 1.95 - 0.03, 0.0, k * 1.95 + 0.03, 1.05, 0.008, M_WAIN_D)
    mrect(bf, -7.8, 4.0, 7.8, 4.34, 0.004, dark)
    mrect(bf, -7.8, 4.0, 7.8, 4.03, 0.01, M_CREAM)
    mrect(bf, -7.8, 4.31, 7.8, 4.34, 0.01, M_CREAM)
    for k in range(-7, 8):
        quadp(bf, [(k * 1.0 - 0.14, 4.17), (k * 1.0, 4.07), (k * 1.0 + 0.14, 4.17), (k * 1.0, 4.27)], 0.012, M_CREAM)
    shield(bf, 0.0, 1.9, 1.5, 1.8, cloth, M_CREAM, s, z=0.006)
    label(bf, 0.0, 1.3, 0.006, TEAM_NAME[s], 0.34, M_CREAM)
    rain(bf, -7.6, 7.6, 3.95, step=1.4, hi=1.8)
    # ---- the side walls from the inside: dado, trophies, a weapon rack
    for sx in (-1, 1):
        fa = '-x' if sx > 0 else '+x'
        for zc, L in ((46.05, 2.5), (52.55, 3.7)):
            sf = on_face(fr0, sx * 7.8, zc, fa)
            mrect(sf, -L / 2, 0.0, L / 2, 1.05, 0.004, M_WAIN)
            mrect(sf, -L / 2, 1.05, L / 2, 1.13, 0.006, M_WAIN_D)
            for k in range(1, int(L / 0.95) + 1):
                mrect(sf, -L / 2 + k * 0.95 - 0.03, 0.0, -L / 2 + k * 0.95 + 0.03, 1.05, 0.008, M_WAIN_D)
        trophy(on_face(fr0, sx * 7.8, 46.05, fa), 0.0, 2.8, s)
        trophy(on_face(fr0, sx * 7.8, 52.55, fa), 0.0, 3.3, s)
        rk = on_face(fr0, sx * 7.8, 52.55, fa)
        for ux in (-0.85, 0.85):                    # the rack: two posts, two rails, spears and shields
            tube('timber', rk, [(ux, 0.0, 0.14), (ux, 2.0, 0.14)], 0.05, n=6)
        for yy in (0.85, 1.65):
            tube('timber', rk, [(-0.85, yy, 0.14), (0.85, yy, 0.14)], 0.035, n=5)
        for k in range(7):
            ux = -0.65 + 0.217 * k
            tube('timber', rk, [(ux, 0.4, 0.17), (ux, 2.2 + 0.1 * (k % 2), 0.17)], 0.017, n=4)
            tube('metal', rk, [(ux, 2.2 + 0.1 * (k % 2), 0.17), (ux, 2.42 + 0.1 * (k % 2), 0.17)], [0.026, 0.004], n=4, caps=False)
        # iron hinges on the door leaves at the ends of the wall
        for zz in (47.3, 50.7):
            lf = F(s, sx * HW, zz)
            for sg in (-1, 1):
                for yy in (0.4, 1.1, 1.8):
                    pbox('fit', lf, sg * 0.5, yy, 0.0, 0.24, 0.08, 0.2, M_IRON)
    # ---- the plinth: a team ring, a pale inner line, spokes, and the name in the paving
    cx, cz = 0.0, 49.8
    fq = F(s, 0, 0)
    for i in range(36):
        a0, a1 = 2 * math.pi * i / 36, 2 * math.pi * (i + 1) / 36
        for r0, r1, col in ((2.2, 2.55, cloth), (2.05, 2.15, M_CREAM), (2.6, 2.7, M_CREAM)):
            upoly(fq, [(cx + r0 * math.cos(a0), 0.012, cz + r0 * math.sin(a0)), (cx + r1 * math.cos(a0), 0.012, cz + r1 * math.sin(a0)),
                       (cx + r1 * math.cos(a1), 0.012, cz + r1 * math.sin(a1)), (cx + r0 * math.cos(a1), 0.012, cz + r0 * math.sin(a1))], col)
    for k in range(8):
        a = math.pi * k / 4 + math.pi / 8
        c, sn = math.cos(a), math.sin(a)
        upoly(fq, [(cx + 2.8 * c - 0.05 * sn, 0.012, cz + 2.8 * sn + 0.05 * c), (cx + 3.7 * c - 0.05 * sn, 0.012, cz + 3.7 * sn + 0.05 * c),
                   (cx + 3.7 * c + 0.05 * sn, 0.012, cz + 3.7 * sn - 0.05 * c), (cx + 2.8 * c + 0.05 * sn, 0.012, cz + 2.8 * sn - 0.05 * c)],
              M_PAVE_D)
    # the processional way from the gate: slabs with a dark border, and joints
    for xe in (-1.5, 1.5):
        fquad(fq, xe - 0.05, 41.2, xe + 0.05, 47.5, 0.012, M_JOINT)
        fquad(fq, xe * 0.9 - 0.02, 41.2, xe * 0.9 + 0.02, 47.5, 0.012, M_CREAM)
    type_floor(F(s, 0.0, 47.2, math.pi, 0.012), TEAM_NAME[s], 0.4, M_CREAM)
    # ---- under the roof: purlins, lanterns on chains, bunting across the front
    for x in (-5.6, -2.8, 2.8, 5.6):
        tube('timber', frh, [(x, CEIL_Y - 0.05, -5.4), (x, CEIL_Y - 0.05, 5.4)], 0.07, n=6)
    for lx in (-4.0, 4.0):
        tube('metal', frh, [(lx, CEIL_Y - 0.2, 0.0), (lx, 3.65, 0.0)], 0.012, n=4)
        lathe('metal', frh, lx, 0.0, [(0.0, 3.1), (0.1, 3.14), (0.14, 3.3), (0.1, 3.58), (0.0, 3.62)], n=8)
        lathe('tglyph', frh, lx, 0.0, [(0.0, 3.2), (0.09, 3.24), (0.09, 3.5), (0.0, 3.54)], n=8, tint=M_WARM)
    pts = [(-7.7 + 15.4 * i / 16, CEIL_Y + 0.42 - 0.75 * (1.0 - ((-7.7 + 15.4 * i / 16) / 7.7) ** 2), -5.0) for i in range(17)]
    tube('timber', frh, pts, 0.015, n=4, caps=False)
    for i in range(16):
        xm, ym, zm = ((pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2, -5.0)
        col = cloth if i % 2 == 0 else TRIM_CLOTH
        poly('banner', frh, [(pts[i][0] + 0.03, pts[i][1], zm), (pts[i + 1][0] - 0.03, pts[i + 1][1], zm), (xm, ym - 0.5, zm)], col)
    # ---- the open gable: a board with the keep's arms on the king post
    gf = Frame(*frh.world((0.0, 0.0, -5.97)), frh.yaw + math.pi)
    pbox('timber', gf, 0.0, 5.85, -0.04, 1.0, 1.2, 0.05, WHITE)
    shield(gf, 0.0, 5.4, 0.8, 1.0, cloth, M_CREAM, s, z=0.0)
    # ---- the roof: courses, fresh slates, moss and a ridge row
    for sg in (-1, 1):
        xa, ya, xb, yb = sg * (HW + 1.2), CEIL_Y + 0.3, 0.0, CEIL_Y + 2.6
        roof_courses(frh, xa, ya, xb, yb, -6.0, 6.0, 16, M_JOINT, w=0.04)
        roof_patches(frh, xa, ya, xb, yb, -6.0, 6.0, 14, [srgb(0x59606a), srgb(0x6b727c), M_MOSS], 0.016)
    # the outer faces of the side walls: rain, repairs, lichen and a vine
    for sx in (-1, 1):
        fa = '+x' if sx > 0 else '-x'
        for z0, z1 in ((44.8, 47.3), (50.7, 54.4)):
            ff = on_face(fr0, sx * (HW + 0.6), (z0 + z1) / 2, fa)
            L = z1 - z0
            rain(ff, -L / 2 + 0.2, L / 2 - 0.2, 4.55, step=1.0, hi=2.2)
            patches(ff, -L / 2 + 0.3, L / 2 - 0.3, 1.4, 4.2, 2)
        vine(on_face(fr0, sx * (HW + 0.6), 52.5, fa), 0.0, 1.0, 4.0)


# ------------------------------------------------------------------ the barracks

def barracks_detail(s):
    fr0 = F(s, 0, 0)
    for sx in (-1, 1):
        cx, cz, w, d, h = sx * 27.0, 49.0, 7.0, 9.0, 5.0
        fr = F(s, cx, cz)
        inw = '-x' if sx > 0 else '+x'
        out = '+x' if sx > 0 else '-x'
        side_in = cx + (-1 if sx > 0 else 1) * (w / 2 + 0.05)
        side_out = cx + (1 if sx > 0 else -1) * (w / 2 + 0.05)
        # ---- the courtyard face: the door leaf, a name plate, streaks and lichen
        ff = on_face(fr0, side_in, cz, inw)
        pbox('timber', ff, 0.0, 1.1, 0.125, 1.3, 2.2, 0.03, WHITE, skip=('-y',))
        for u in (-0.5, -0.25, 0.0, 0.25, 0.5):
            mrect(ff, u - 0.008, 0.05, u + 0.008, 2.15, 0.142, M_PLANK_D)
        for yb in (0.45, 1.7):
            pbox('fit', ff, 0.0, yb, 0.15, 1.3, 0.12, 0.03, M_IRON)
            for k in range(5):
                stud(ff, -0.5 + 0.25 * k, yb, 0.166, 0.026, 0.02)
        torus('metal', ff, 0.45, 1.15, 0.16, 0.09, 0.015, ax='z', n=10, m=4)
        plate(ff, 0.0, 2.56, 1.5, 0.38, M_WAIN_D, M_CREAM, 'BARRACKS', 0.2, border=M_IRON, z=0.14)
        rain(ff, -4.3, 4.3, 5.0, step=1.2, hi=1.8, z=0.003)
        patches(ff, -4.0, 4.0, 0.6, 1.0, 3, z=0.003)
        # ---- the other faces
        fz = on_face(fr0, cx, cz - d / 2 - 0.05, '-z')
        rain(fz, -w / 2 + 0.3, w / 2 - 0.3, 5.0, step=1.2, hi=1.8, z=0.003)
        fo = on_face(fr0, side_out, cz, out)
        rain(fo, -d / 2 + 0.3, d / 2 - 0.3, 5.0, step=1.2, hi=1.8, z=0.003)
        vine(fz, 3.0, 0.9, 4.2, z=0.16)
        # ---- the roof: courses, patches and a ridge line; the pitch is (-4, 5) up to (0, 7)
        for sg in (-1, 1):
            xa, ya, xb, yb = sg * (w / 2 + 0.5), h, 0.0, h + 2.0
            roof_courses(fr, xa, ya, xb, yb, -d / 2 - 0.5, d / 2 + 0.5, 11, M_JOINT, w=0.035)
            roof_patches(fr, xa, ya, xb, yb, -d / 2 - 0.5, d / 2 + 0.5, 12, [srgb(0x59606a), srgb(0x6b727c), M_MOSS], 0.016)
            # the eave gutter
            tube('metal', fr, [(sg * (w / 2 + 0.56), h - 0.04, -d / 2 - 0.5), (sg * (w / 2 + 0.56), h - 0.07, d / 2 + 0.5)], 0.045, n=5)
        # downpipes at the two front corners of the courtyard side
        for zz in (-d / 2 + 0.25, d / 2 - 0.25):
            xi = (-1 if sx > 0 else 1) * (w / 2 + 0.06)
            xo = (-1 if sx > 0 else 1) * (w / 2 + 0.56)
            tube('metal', fr, [(xo, h - 0.07, zz), (xi, h - 0.32, zz), (xi, 0.15, zz)], 0.035, n=5, caps=False)
        # ---- the gables: a round window with a ring, bargeboards, and a hoist beam at the apex
        for sg in (-1, 1):
            gf = Frame(*fr.world((0.0, 0.0, sg * (d / 2 + 0.5))), fr.yaw + (0.0 if sg > 0 else math.pi))
            circle(gf, 0.0, h + 0.85, 0.012, 0.3, M_DARK, 'dark', 14)
            torus('timber', gf, 0.0, h + 0.85, 0.02, 0.32, 0.04, ax='z', n=12, m=4)
            for sgn in (-1, 1):
                tube('timber', gf, [(sgn * (w / 2 + 0.5), h, 0.04), (0.0, h + 2.0, 0.04)], 0.05, n=5)
            tube('timber', gf, [(0.0, h + 1.9, 0.04), (0.0, h + 1.9, 0.8)], 0.05, n=5)
            tube('timber', gf, [(0.0, h + 1.9, 0.8), (0.0, h + 1.3, 0.8)], 0.012, n=4)
        # ---- the chimney: pots and a band of lead round the foot
        chx, chz = w * 0.2, -d * 0.18
        for ox in (-0.2, 0.2):
            lathe('shingle', fr, chx + ox, chz, [(0.1, h + 3.72), (0.13, h + 3.8), (0.11, h + 4.05), (0.14, h + 4.12), (0.0, h + 4.12)], n=8)
        pbox('fit', fr, chx, h + 1.1 - 0.05, chz, 1.08, 0.1, 1.08, M_IRON_L, skip=('-y',))
        # a lantern on a bracket by the door
        tube('metal', ff, [(-1.05, 2.1, 0.02), (-1.05, 2.1, 0.45), (-1.05, 1.9, 0.45)], 0.02, n=4)
        lathe('metal', ff, -1.05, 0.45, [(0.0, 1.62), (0.08, 1.66), (0.1, 1.86), (0.0, 1.9)], n=8)
        lathe('tglyph', ff, -1.05, 0.45, [(0.0, 1.68), (0.06, 1.7), (0.06, 1.82), (0.0, 1.84)], n=8, tint=M_WARM)


# ------------------------------------------------------------------ the courtyard and the field

def courtyard_detail(s):
    fq = F(s, 0, 0)
    # cart ruts through the gate and out across the apron
    for tx in (-0.95, 0.95):
        z = 44.2
        while z > 30.0:
            fquad(fq, tx - 0.11, z - 1.8, tx + 0.11, z, 0.011, M_RUT)
            z -= 2.6 + 1.0 * rnd()
    # a heap of straw by the stacked crates, damp under the barrels, moss under the walls
    for k in range(34):
        a = rnd() * 6.28
        sx = 1 if k % 2 else -1
        cxx, czz = sx * (12.4 + 2.0 * rnd() * math.cos(a)), 52.0 + 2.0 * rnd() * math.sin(a)
        L = 0.25 + 0.2 * rnd()
        c, sn = math.cos(a), math.sin(a)
        upoly(fq, [(cxx - c * L, 0.013, czz - sn * L), (cxx - sn * 0.02, 0.013, czz + c * 0.02), (cxx + c * L, 0.013, czz + sn * L),
                   (cxx + sn * 0.02, 0.013, czz - c * 0.02)], M_STRAW)
    for sx in (-1, 1):
        for bx, bz in ((17.5, 53.8), (18.6, 53.2), (15.4, 53.9)):
            blob(fq, sx * bx, bz, 0.7, M_DAMP, 0.012, 8, 0.3)
    # puddles in the ruts out in the apron
    for (px, pz, pr) in ((0.9, 37.0, 0.7), (-1.0, 34.0, 0.55), (0.0, 31.5, 0.8)):
        blob(fq, px, pz, pr, M_PUDDLE, 0.013, 10, 0.2)


def field_detail(s):
    fr0 = F(s, 0, 0)
    for sx in (-1, 1):
        # the ruined wall: both faces of the long run and of the return
        runs = ((sx * 11.5, 25.5, '-z', 7.0), (sx * 11.5, 26.5, '+z', 7.0))
        for (x, z, fa, L) in runs:
            ff = on_face(fr0, x, z, fa)
            rain(ff, -L / 2 + 0.3, L / 2 - 0.3, 2.95, step=0.9, lo=0.5, hi=1.8)
            patches(ff, -L / 2 + 0.4, L / 2 - 0.4, 0.5, 2.6, 5)
        for (x, z, fa) in ((sx * 14.5, 28.25, '-x' if sx > 0 else '+x'), (sx * 15.5, 28.25, '+x' if sx > 0 else '-x')):
            ff = on_face(fr0, x, z, fa)
            rain(ff, -2.0, 2.0, 2.95, step=0.9, lo=0.5, hi=1.8)
            patches(ff, -2.0, 2.0, 0.5, 2.6, 3)
        # a pointed window in each face of the long run, and ivy
        for (x, z, fa) in ((sx * 10.2, 25.5, '-z'), (sx * 10.2, 26.5, '+z')):
            ff = on_face(fr0, x, z, fa)
            lancet(ff, 0.0, 1.0, 2.5, 0.7, z=0.012)
            for sg in (-1, 1):
                vbox('cut', ff, sg * 0.5, 1.7, 0.05, 0.14, 1.6, 0.1, skip=())
            vbox('cut', ff, 0.0, 0.92, 0.07, 1.1, 0.1, 0.16, skip=())
            vine(ff, 1.8, 0.1, 2.9)
        # fallen capstones on the broken top
        for k in range(5):
            ax = sx * (8.6 + 1.5 * k + rnd() * 0.5)
            pbox('cut', F(s, ax, 26.0), 0, 3.09 + 0.05 * (k % 2), 0, 0.5 + 0.3 * rnd(), 0.14, 0.7)
        # the low walls: joints in the coping, lichen, pebbles
        for (xa, xb, zz) in ((4.0, 11.0, 34.0), (13.5, 17.0, 14.0)):
            fq = F(s, 0, 0)
            xm, L = sx * (xa + xb) / 2, xb - xa
            k = 0.7
            while k < L - 0.3:
                fquad(fq, sx * (xa + k) - 0.012, zz - 0.43, sx * (xa + k) + 0.012, zz + 0.43, 1.105, M_JOINT)
                k += 0.9
        for k in range(3):
            fquad(F(s, 0, 0), sx * 13.5 - 0.43, 10.5 + 1.3 * k, sx * 13.5 + 0.43, 10.5 + 1.3 * k + 0.024, 1.105, M_JOINT)
        for (x, z, fa, L) in ((sx * 7.5, 33.65, '-z', 7.0), (sx * 7.5, 34.35, '+z', 7.0), (sx * 15.25, 13.65, '-z', 3.5),
                              (sx * 15.25, 14.35, '+z', 3.5)):
            ff = on_face(fr0, x, z, fa)
            patches(ff, -L / 2 + 0.3, L / 2 - 0.3, 0.3, 0.8, 3)
        # the barricade: seams, rope lashings, nails and two round shields on the keep side
        bf = F(s, sx * 8.0, 37.0, sx * 0.35)
        for sz, fa in ((1, '+z'), (-1, '-z')):
            ff = on_face(bf, 0.0, sz * 0.25, fa)
            for yy in (0.33, 0.66):
                mrect(ff, -1.5, yy - 0.01, 1.5, yy + 0.01, 0.003, M_PLANK_D)
            for ux in (-1.2, 0.0, 1.2):
                mrect(ff, ux - 0.04, 0.0, ux + 0.04, 1.0, 0.006, srgb(0x6b5a3a))
                stud(ff, ux, 0.25, 0.006, 0.022, 0.016)
                stud(ff, ux, 0.75, 0.006, 0.022, 0.016)
        sfc = on_face(bf, 0.0, 0.25, '+z')
        round_shield(sfc, -0.7, 0.5, 0.32, TEAM_CLOTH[s], 0.02)
        round_shield(sfc, 0.7, 0.5, 0.32, TEAM_CLOTH[s], 0.02)


def causeway_detail():
    fq = Frame()
    # the deck: a border inlay inside each kerb, cross joints, and a ring at the middle (blue to the
    # south, red to the north)
    for sx in (-1, 1):
        fquad(fq, sx * 4.2 - 0.05, -12.0, sx * 4.2 + 0.05, 12.0, 1.404, M_PAVE_D)
    z = -11.5
    while z < 12.0:
        fquad(fq, -4.7, z - 0.02, 4.7, z + 0.02, 1.404, M_PAVE_D)
        z += 1.5
    for i in range(36):
        a0, a1 = 2 * math.pi * i / 36, 2 * math.pi * (i + 1) / 36
        col = TEAM_CLOTH[1] if math.sin((a0 + a1) / 2) > 0 else TEAM_CLOTH[-1]
        for r0, r1, c in ((1.6, 2.0, col), (1.45, 1.52, M_CREAM), (2.08, 2.15, M_CREAM)):
            upoly(fq, [(r0 * math.cos(a0), 1.408, r0 * math.sin(a0)), (r1 * math.cos(a0), 1.408, r1 * math.sin(a0)),
                       (r1 * math.cos(a1), 1.408, r1 * math.sin(a1)), (r0 * math.cos(a1), 1.408, r0 * math.sin(a1))], c)
    fquad(fq, -0.06, -1.3, 0.06, 1.3, 1.408, M_CREAM)
    fquad(fq, -1.3, -0.06, 1.3, 0.06, 1.408, M_CREAM)
    # the long faces: moss where the grass meets them, a few lichen patches and rain from the kerb
    for sx in (-1, 1):
        ff = Frame(sx * 5.0, 0.0, -12.0 if sx > 0 else 12.0, FACE_YAW['+x' if sx > 0 else '-x'])
        # '+x' frames run toward -z, so u is measured from the north end for the east face
        rain(ff, 0.5, 23.5, 1.35, step=1.4, lo=0.3, hi=0.9, z=0.003)
        patches(ff, 0.8, 23.2, 0.3, 1.2, 8, z=0.003)
    # the ramps' wheel track and the worn middle
    for sz in (-1, 1):
        for tx in (-1.0, 1.0):
            fquad(fq, tx - 0.12, sz * 12.2 if sz > 0 else sz * 18.2, tx + 0.12, sz * 18.2 if sz > 0 else sz * 12.2, 0.0, M_RUT)


def trail_detail():
    """Wheel ruts and puddles down the flank trails and the track up the middle, then straw."""
    fq = Frame()
    for tx in (-19.2, -20.8, 19.2, 20.8, -0.8, 0.8):
        z = -37.5
        while z < 37.0:
            ln = 2.0 + 1.5 * rnd()
            fquad(fq, tx - 0.09, z, tx + 0.09, z + ln, 0.011, M_RUT)
            z += ln + 0.9 + 1.4 * rnd()
    for k in range(12):
        x = (-20.0 if k % 2 else 20.0) + (rnd() - 0.5) * 1.6
        blob(fq, x, -34.0 + 6.0 * (k // 2) + rnd() * 2, 0.45 + 0.4 * rnd(), M_PUDDLE, 0.013, 9, 0.25)


def ground_scatter():
    """Tufts of grass and wild flowers on the open meadow, never on the paving or the trails."""
    fq = Frame()

    def clear(x, z):
        ax, az = abs(x), abs(z)
        if az > 39.0:
            return False                                  # the keeps' yards
        if ax < 5.6 and az < 19.0:
            return False                                  # the causeway and its ramps
        if ax < 3.2 or 17.2 < ax < 22.8:
            return False                                  # the trails
        if ax > 24.0 and az > 3.0:
            return False                                  # the pine grove's needles
        return True
    placed, guard = 0, 0
    while placed < 90 and guard < 4000:
        guard += 1
        cx, cz = (rnd() * 2 - 1) * 30.0, (rnd() * 2 - 1) * 39.0
        if not clear(cx, cz):
            continue
        placed += 1
        for _ in range(3):
            x, z = cx + (rnd() - 0.5) * 0.9, cz + (rnd() - 0.5) * 0.9
            col = M_TUFT[int(rnd() * 4)]
            hh = 0.28 + 0.2 * rnd()
            for _b in range(5):
                a = rnd() * 2 * math.pi
                lean = 0.05 + 0.13 * rnd()
                bx, bz = x + 0.05 * math.cos(a), z + 0.05 * math.sin(a)
                px, pz = -math.sin(a) * 0.022, math.cos(a) * 0.022
                poly('tuft', fq, [(bx - px, 0.0, bz - pz), (bx + px, 0.0, bz + pz),
                                  (bx + lean * math.cos(a), hh * (0.7 + 0.5 * rnd()), bz + lean * math.sin(a))], col)
    placed, guard = 0, 0
    while placed < 90 and guard < 4000:                   # flowers: a stem and a head
        guard += 1
        x, z = (rnd() * 2 - 1) * 30.0, (rnd() * 2 - 1) * 39.0
        if not clear(x, z):
            continue
        placed += 1
        hh = 0.22 + 0.14 * rnd()
        col = M_FLOWERS[int(rnd() * 4)]
        poly('tuft', fq, [(x - 0.01, 0.0, z), (x + 0.01, 0.0, z), (x, hh, z)], M_TUFT[1])
        r = 0.05
        poly('tuft', fq, [(x - r, hh, z), (x, hh - 0.03, z + r), (x + r, hh, z), (x, hh + 0.03, z - r)], col)


# ------------------------------------------------------------------ far off

_house_layout = house_far


def house_far(x, y, z, yaw, w=6.0, d=8.0, h=3.2):
    _house_layout(x, y, z, yaw, w, d, h)
    fr = Frame(x, y, z, yaw)
    ff = Frame(*fr.world((w / 2, 0.0, 0.0)), yaw + math.pi / 2)
    poly('dark', ff, [(-0.5, 0.0, 0.03), (0.5, 0.0, 0.03), (0.5, 2.0, 0.03), (-0.5, 2.0, 0.03)])
    for u in (-2.4, 2.4):
        poly('dark', ff, [(u - 0.4, 1.2, 0.03), (u + 0.4, 1.2, 0.03), (u + 0.4, 2.1, 0.03), (u - 0.4, 2.1, 0.03)])
        pbox('timber', ff, u, 1.12, 0.06, 1.0, 0.08, 0.1, WHITE)


_windmill_layout = windmill


def windmill(x, y, z, yaw):
    _windmill_layout(x, y, z, yaw)
    fr = Frame(x, y, z, yaw)
    torus('timber', fr, 0, 3.6, 0, 2.7, 0.09, n=16, m=4)
    poly('dark', Frame(*fr.world((0.0, 0.0, -3.2)), yaw + math.pi), [(-0.6, 0.0, 0.0), (0.6, 0.0, 0.0), (0.6, 2.0, 0.0), (-0.6, 2.0, 0.0)])
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        c, sn = math.cos(a), math.sin(a)

        def rot(px, py):
            return (px * c - py * sn, 9.9 + px * sn + py * c)
        for yb in (2.6, 4.0, 5.4, 6.8):                   # the lattice across each sail
            prism('timber', fr, [rot(0.2, yb), rot(1.9, yb), rot(1.9, yb + 0.1), rot(0.2, yb + 0.1)], 3.0, 3.25)


# ------------------------------------------------------------------ entry

def keep_detail(s):
    curtain_detail(s)
    gate_detail(s)
    hall_detail(s)
    barracks_detail(s)
    courtyard_detail(s)
    field_detail(s)


def bastion_detail():
    perimeter_detail()
    causeway_detail()
    trail_detail()
    both(keep_detail)
    ground_scatter()
