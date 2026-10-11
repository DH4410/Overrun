"""
warzonedetail: the second pass over WARZONE. Exec'd by build_warzone.py after the layout's own
functions (so it can wrap wall_holes, bldg, wreck, bus, container, crate, lamp_post and rubble) and
before `result = ...`. build_layout() calls warzone_detail() just before rk_finalize().

Everything here is scenery, in the keys fit / mark / glyph / tmark / tglyph (see detailkit.py):
    - every wall opening: window frames, mullions and transoms, glass left in the corners, boards,
      shutters and torn curtains; door frames, thresholds, hinges and house numbers; soot above the
      windows
    - every wall, outside and in: bullet pocks, cracks, rain streaks, repair patches, downpipes; indoors
      a painted dado, damp, posters and exit signs over the doors
    - the buildings: names over the doors, shop awnings, aerials, dishes and rubble on the floors
    - vehicles: door seams and handles, mirrors, plates, rust and bullet holes, a route sign and a
      livery on the bus; containers: ids, stencils and rust; crates: stencils and nails
    - the ground: manholes, patches, potholes, crosswalks, skid marks, shell casings, paper, brick
      chunks, oil; base names and a flag, signs on the perimeter wall, a fuel price board

Nothing here emits a collider and nothing moves one: warzone.json stays as it was. Decals that share a
key share one polygon offset, so they are layered at least 5 mm apart.
"""
exec(open(os.path.join(REPO, 'scripts', 'blender', 'detailkit.py')).read())
seed(20261011)
_reseed = seed            # bldg() and rubble() take a `seed` argument of their own

M_SOOT = srgb(0x58524c)
M_SOOT_H = srgb(0x71695f)
M_STREAK = srgb(0x7c786f)
M_STREAK_D = srgb(0x66625a)
M_HOLE = srgb(0x1a1815)
M_CHIP = srgb(0xcfc7b6)
M_CRACK = srgb(0x46433e)
M_PATCH = srgb(0x9a9486)
M_DAMP = srgb(0x6b675f)
M_WAINS = srgb(0x52605a)
M_WAINS_L = srgb(0x7f8c84)
M_GLASS = srgb(0x7f9db0)
M_CURT = srgb(0x6a4f3e)
M_BOARD = srgb(0x6a5238)
M_BOARD_D = srgb(0x45351f)
M_SHUT = srgb(0x3f5a45)
M_FRAMES = [srgb(h) for h in (0x2c2f33, 0x4b4f52, 0xd4cfc0, 0x3a4b3c)]
M_RUST = srgb(0x7a3f22)
M_RUST_D = srgb(0x55311f)
M_PLATE_BG = srgb(0x1c3a58)
M_BRASS = srgb(0xb08d3a)
M_PAPER = srgb(0xd9d4c4)
M_OIL = srgb(0x2d2d30)
M_ASPH_P = srgb(0x2f2f31)
M_ASPH_L = srgb(0x4a4a4c)
M_MAN = srgb(0x3c3d3f)
M_ZEBRA = srgb(0xcfcabb)
M_SKID = srgb(0x2b2b2e)
M_GRAY = srgb(0x6a6e72)
M_IRON = srgb(0x3a3d41)
M_CONC = srgb(0x8c8a84)
M_BRICK = srgb(0x7a4a3a)
M_AWN = [srgb(0xb3281f), srgb(0xe6e3d8)]
M_EXIT = srgb(0x0f7a45)
M_AMBER = srgb(0xffb02e)
M_ALPHA = srgb(0x1f4f8a)
M_BRAVO = srgb(0xa3281f)
M_OLIVE = srgb(0x55582f)
M_STRAW = srgb(0x9a8c55)
M_NAME = srgb(0x23282c)
M_NUM = srgb(0x20242a)

SIGNS = {7: 'APARTMENTS', 17: 'WAREHOUSE 4', 21: 'CHAPEL', 25: 'OFFICE', 29: 'MACHINE WORKS', 33: 'NO 12', 35: 'NO 14'}
SHOP_NAMES = ('BAKERY', 'PHARMACY', 'CAFE')
SHOP_TINTS = (srgb(0x8a3a2a), srgb(0x1f6a52), srgb(0x2a4d7a))
CONT_PREFIX = ('HLCN', 'ATLS', 'RZOR', 'MRSK', 'OVRN')
_CRATE_TXT = ('AMMO', '5.56 MM', 'MEDICAL', 'RATIONS', 'FUEL', 'SPARES', 'THIS WAY UP', 'FRAGILE')
_state = {'door': 0, 'cont': 0, 'crate': 0}

DIRN = {'+z': (0.0, 1.0), '-z': (0.0, -1.0), '+x': (1.0, 0.0), '-x': (-1.0, 0.0)}


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


def both_sides(key, fr, pts, tint):
    """A thin loose piece (a shard, a rag) seen from either side."""
    poly(key, fr, pts, tint)
    poly(key, fr, pts[::-1], tint)


def plate(fr, u, y, w, h, bg, fg, text, ph=None, border=M_CHIP, z=0.006, key='tmark'):
    """A sign plate with a border and one line of text."""
    mrect(fr, u - w / 2, y, u + w / 2, y + h, z, border)
    mrect(fr, u - w / 2 + 0.02, y + 0.02, u + w / 2 - 0.02, y + h - 0.02, z + 0.006, bg)
    if text:
        ph = ph or fw(text, w - 0.08, h * 0.55)
        type_label(fr, u, y + (h - ph) / 2, z + 0.012, text, ph, fg, key)


def seg_quad(fr, p0, p1, w, z, tint, key='mark'):
    """A thin straight strip between two (u, y) points on a vertical face."""
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    ln = math.hypot(dx, dy) or 1e-6
    nx, ny = -dy / ln * w / 2, dx / ln * w / 2
    quadp(fr, [(p0[0] - nx, p0[1] - ny), (p1[0] - nx, p1[1] - ny), (p1[0] + nx, p1[1] + ny), (p0[0] + nx, p0[1] + ny)],
          z, tint, key)


def floor_seg(fr, p, q, w, y, tint):
    """A thin straight strip between two (x, z) points on the ground."""
    dx, dz = q[0] - p[0], q[1] - p[1]
    ln = math.hypot(dx, dz) or 1e-6
    nx, nz = -dz / ln * w / 2, dx / ln * w / 2
    upoly(fr, [(p[0] - nx, y, p[1] - nz), (q[0] - nx, y, q[1] - nz), (q[0] + nx, y, q[1] + nz), (p[0] + nx, y, p[1] + nz)], tint)


def crack(fr, u, y, ln, z=0.004, w=0.016, tint=M_CRACK):
    """A wandering fissure that runs mostly downward."""
    n = max(3, int(ln / 0.2))
    p = (u, y)
    ang = math.pi * 1.5 + (rnd() - 0.5) * 1.0
    for i in range(n):
        ang += (rnd() - 0.5) * 1.5
        q = (p[0] + math.cos(ang) * ln / n, p[1] + math.sin(ang) * ln / n)
        seg_quad(fr, p, q, w * (1.0 - 0.6 * i / n), z, tint)
        p = q


def pocks(fr, u, y, count, z=0.004, spread=0.45):
    """Bullet strikes: a pale chip of render round a dark hole."""
    for _ in range(count):
        a, d = rnd() * 6.28, spread * rnd() ** 0.8
        pu, py = u + math.cos(a) * d, y + math.sin(a) * d * 0.8
        r = 0.022 + 0.018 * rnd()
        circle(fr, pu, py, z, r * 2.3, M_CHIP, 'mark', 6)
        circle(fr, pu, py, z + 0.006, r, M_HOLE, 'mark', 4)


def blob_v(fr, u, y, rx, ry, tint, z=0.004, n=9, jitter=0.3):
    """An irregular patch on a vertical face."""
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        k = 1.0 - jitter + jitter * 2 * rnd()
        pts.append((u + rx * k * math.cos(a), y + ry * k * math.sin(a)))
    quadp(fr, pts, z, tint)


def rain(fr, u, ytop, z=0.004):
    """A dark water stain down a wall: thin, uneven."""
    ln = 0.7 + 1.7 * rnd() ** 1.5
    w = 0.04 + 0.07 * rnd()
    quadp(fr, [(u - w / 2, ytop), (u + w / 2, ytop), (u + w * 0.3, ytop - ln), (u - w * 0.3, ytop - ln)], z,
          M_STREAK if rnd() < 0.5 else M_STREAK_D)


def tilt_plank(fr, cu, cy, ln, w, ang, z0, z1, tint):
    """A board across an opening, turned by ang."""
    c, s = math.cos(ang), math.sin(ang)
    hl, hw = ln / 2, w / 2
    pts = [(cu + x * c - y * s, cy + x * s + y * c) for x, y in ((-hl, -hw), (hl, -hw), (hl, hw), (-hl, hw))]
    prism('fit', fr, pts, z0, z1, tint, True)


# ------------------------------------------------------------------ wall faces

def face_frame(x0, z0, x1, z1, t, outward):
    """A frame on one face of an axis-aligned wall: +z out of that face, origin at its middle.
    Returns the frame, the wall's length, and k such that local u = (u_along - L / 2) * k."""
    along_x = abs(x1 - x0) > abs(z1 - z0)
    L = abs(x1 - x0) if along_x else abs(z1 - z0)
    sgn = 1 if (x1 - x0 if along_x else z1 - z0) > 0 else -1
    nx, nz = DIRN[outward]
    yaw = OUT_YAW[outward]
    fr = Frame((x0 + x1) / 2 + nx * t / 2, 0.0, (z0 + z1) / 2 + nz * t / 2, yaw)
    k = sgn * (math.cos(yaw) if along_x else -math.sin(yaw))
    return fr, L, k


def clear_of(holes, u, y, pad):
    """True when (u, y) is at least pad from every opening (a, b, y0, y1 in local u)."""
    for a, b, y0, y1 in holes:
        if a - pad <= u <= b + pad and y0 - pad <= y <= y1 + pad:
            return False
    return True


def clear_col(holes, u, ya, yb, pad):
    return all(clear_of(holes, u, y, pad) for y in (ya, (ya + yb) / 2, yb))


def outer_decor(fr, L, h, holes, base_seed):
    seed(base_seed)
    half = L / 2
    # soot above some windows
    for a, b, y0, y1 in holes:
        if y0 > 0.3 and y1 + 1.0 < h and rnd() < 0.4:
            cu, w = (a + b) / 2, b - a
            top = min(h - 0.3, y1 + 0.7 + 0.6 * rnd())
            # a pale halo with a narrower dark core, so the plume fades instead of ending on a hard edge
            quadp(fr, [(a - 0.1, y1 + 0.22), (b + 0.1, y1 + 0.22), (cu + w * 0.2, top), (cu - w * 0.2, top)], 0.004, M_SOOT_H)
            quadp(fr, [(a + 0.1, y1 + 0.22), (b - 0.1, y1 + 0.22), (cu + w * 0.1, y1 + 0.22 + (top - y1 - 0.22) * 0.66),
                       (cu - w * 0.1, y1 + 0.22 + (top - y1 - 0.22) * 0.66)], 0.010, M_SOOT)
    # bullet strikes in clusters, away from the openings
    for _ in range(1 + int(L / 6.0)):
        u, y = -half + 0.8 + (L - 1.6) * rnd(), 0.8 + (min(h, 3.4) - 1.2) * rnd()
        if clear_of(holes, u, y, 0.55):
            pocks(fr, u, y, 3 + int(rnd() * 4))
    # cracks and rain
    for _ in range(1 + int(L / 7.0)):
        u, y = -half + 0.6 + (L - 1.2) * rnd(), h - 0.4 - 1.0 * rnd()
        if clear_col(holes, u, y - 1.4, y, 0.25):
            crack(fr, u, y, 0.9 + 0.9 * rnd())
    for _ in range(max(2, int(L / 2.2))):
        u = -half + 0.5 + (L - 1.0) * rnd()
        if clear_col(holes, u, h - 1.9, h - 0.2, 0.2):
            rain(fr, u, h - 0.2)
    # a render repair
    u = -half + 1.2 + (L - 2.4) * rnd()
    y = 0.8 + 1.2 * rnd()
    if clear_of(holes, u, y, 0.7):
        mrect(fr, u - 0.4, y - 0.25, u + 0.4, y + 0.25, 0.004, M_PATCH)
    # a downpipe at each end, bracketed
    for sg in (-1, 1):
        u = sg * (half - 0.95)
        if clear_col(holes, u, 0.2, h - 0.3, 0.1):
            pole(fr, u, 0.075, h - 0.5, 0.045, M_GRAY, 0.15, 5)
            pbox('fit', fr, u, h - 0.36, 0.075, 0.16, 0.1, 0.12, M_GRAY, skip=('-y', '-z'))


def inner_decor(fr, L, h, holes, base_seed):
    seed(base_seed + 1)
    half = L / 2
    # a painted dado, broken only by the doorways; a lighter rule along its top
    cuts = sorted((a, b) for a, b, y0, y1 in holes if y0 == 0)
    u = -half
    for a, b in cuts + [(half, half)]:
        if a - u > 0.2:
            mrect(fr, u, 0.0, a, 1.05, 0.005, M_WAINS)
            mrect(fr, u, 1.05, a, 1.11, 0.011, M_WAINS_L)
        u = max(u, b)
    # damp coming down from the roof, strikes, cracks, a poster or two
    for _ in range(1 + int(L / 4.0)):
        uu = -half + 0.6 + (L - 1.2) * rnd()
        if clear_col(holes, uu, h - 1.4, h, 0.2):
            blob_v(fr, uu, h - 0.2, 0.5 + 0.7 * rnd(), 0.6 + 0.8 * rnd(), M_DAMP, 0.017, 8, 0.4)
    for _ in range(int(L / 8.0)):
        uu, y = -half + 0.8 + (L - 1.6) * rnd(), 1.4 + (h - 2.0) * rnd()
        if clear_of(holes, uu, y, 0.55):
            pocks(fr, uu, y, 3 + int(rnd() * 4), 0.023)
    for _ in range(int(L / 6.0)):
        uu, y = -half + 0.6 + (L - 1.2) * rnd(), h - 0.5 - 1.0 * rnd()
        if clear_col(holes, uu, y - 1.3, y, 0.25):
            crack(fr, uu, y, 0.8 + 0.8 * rnd(), 0.023)
    if L > 5.0:
        for _ in range(1 + int(L / 8.0)):
            uu, y = -half + 1.0 + (L - 2.0) * rnd(), 1.4 + 0.5 * rnd()
            if clear_of(holes, uu, y, 0.5) and clear_of(holes, uu, y + 0.5, 0.5):
                pw, ph_ = 0.38, 0.52
                mrect(fr, uu - pw / 2, y, uu + pw / 2, y + ph_, 0.029, M_PAPER)
                for r_ in range(4):
                    mrect(fr, uu - pw / 2 + 0.04, y + 0.07 + r_ * 0.1, uu + pw / 2 - 0.04 - 0.1 * rnd(), y + 0.1 + r_ * 0.1, 0.035, M_STREAK_D)
    # exit signs over the doorways
    for a, b, y0, y1 in holes:
        if y0 == 0 and y1 + 0.5 < h:
            plate(fr, (a + b) / 2, y1 + 0.12, 0.5, 0.2, M_EXIT, M_WHT, 'EXIT', 0.08, M_WHT, 0.02, 'tglyph')


def opening(fr, a, b, y0, y1, h, holes):
    """Frames, glass and boards in one opening. u runs left to right on the face, z into the wall."""
    cu, wd, ht = (a + b) / 2, b - a, y1 - y0
    cy = (y0 + y1) / 2
    zb = -0.13
    tone = M_FRAMES[int(rnd() * len(M_FRAMES))]

    def room(sg, reach):
        """True when no other opening lies within reach of this one on side sg."""
        e0 = cu + sg * wd / 2
        e1 = e0 + sg * reach
        lo, hi = min(e0, e1), max(e0, e1)
        return all(not (lo < bb and hi > aa) for aa, bb, _, _ in holes if (aa, bb) != (a, b))

    if y0 == 0:
        # a doorway: two posts, a head, a threshold and two hinges; a number beside it
        for sg in (-1, 1):
            pbox('fit', fr, cu + sg * (wd / 2 - 0.04), y1 / 2, zb, 0.08, y1, 0.2, tone, skip=('-y', '+y'))
        pbox('fit', fr, cu, y1 - 0.04, zb, wd, 0.08, 0.2, tone, skip=('+y',))
        pbox('fit', fr, cu, 0.015, zb, wd - 0.1, 0.03, 0.34, M_CONC, skip=('-y',))
        if room(1, 0.6):
            plate(fr, cu + wd / 2 + 0.32, 1.5, 0.18, 0.16, M_PLATE_BG, M_WHT, str(11 + _state['door'] * 3), 0.07, M_CHIP, 0.01)
        _state['door'] += 1
        return
    if y1 >= h - 0.05:
        # a break open to the sky: a few brick chunks on the sill
        for _ in range(3 + int(wd * 1.5)):
            u = cu + (rnd() - 0.5) * (wd - 0.2)
            pbox('fit', fr, u, y0 + 0.04, zb + (rnd() - 0.5) * 0.1, 0.1 + 0.2 * rnd(), 0.08 + 0.08 * rnd(), 0.12 + 0.1 * rnd(),
                 M_BRICK if rnd() < 0.5 else M_CONC)
        return
    # a window: frame, mullion and transom
    for sg in (-1, 1):
        pbox('fit', fr, cu + sg * (wd / 2 - 0.03), cy, zb, 0.06, ht, 0.1, tone)
    for yy in (y0 + 0.03, y1 - 0.03):
        pbox('fit', fr, cu, yy, zb, wd, 0.06, 0.1, tone)
    pbox('fit', fr, cu, cy, zb, 0.04, ht - 0.1, 0.07, tone)
    pbox('fit', fr, cu, y0 + ht * 0.62, zb, wd - 0.1, 0.04, 0.07, tone)
    r = rnd()
    if r < 0.34:
        # boarded: three planks across, nailed
        for k in range(3):
            yy = y0 + ht * (0.2 + 0.3 * k)
            tilt_plank(fr, cu, yy, wd + 0.25, 0.14, (rnd() - 0.5) * 0.14, 0.02, 0.07, M_BOARD if k != 1 else M_BOARD_D)
    elif r < 0.6:
        # shutters flat against the wall either side, with slats
        for sg in (-1, 1):
            if not room(sg, 0.75):
                continue
            sx = cu + sg * (wd / 2 + 0.3)
            pbox('fit', fr, sx, cy, 0.03, 0.5, ht, 0.04, M_SHUT)
            for j in range(4):
                mrect(fr, sx - 0.2, y0 + 0.2 + j * ht * 0.22, sx + 0.2, y0 + 0.2 + j * ht * 0.22 + 0.035, 0.055, M_BOARD_D)
    else:
        # open to the weather: a torn curtain
        for k in range(3):
            ux = cu - wd / 2 + 0.12 + k * (wd - 0.24) / 2.4
            ln = ht * (0.3 + 0.35 * rnd())
            both_sides('fit', fr, [(ux, y1 - 0.06, zb + 0.04), (ux + 0.2, y1 - 0.06, zb + 0.04),
                                   (ux + 0.14, y1 - 0.06 - ln, zb + 0.04), (ux + 0.02, y1 - 0.06 - ln * 0.8, zb + 0.04)], M_CURT)
    # glass left in the corners
    for sx, sy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        if rnd() < 0.55:
            ax, ay = cu + sx * (wd / 2 - 0.06), (y0 + 0.06) if sy < 0 else (y1 - 0.06)
            lx, ly = 0.1 + 0.2 * rnd(), 0.1 + 0.22 * rnd()
            both_sides('fit', fr, [(ax, ay, zb + 0.03), (ax - sx * lx, ay, zb + 0.03), (ax, ay - sy * ly, zb + 0.03)], M_GLASS)


# ------------------------------------------------------------------ wrapped pieces

_wall_holes_layout = wall_holes


def wall_holes(x0, z0, x1, z1, h, t, key, holes, inner, detail=False):
    _wall_holes_layout(x0, z0, x1, z1, h, t, key, holes, inner, detail)
    if not detail:
        return
    outer = FLIP[inner]
    base_seed = int(abs(x0 * 13 + z0 * 7 + x1 * 5 + z1 * 3) * 10) + 101
    for out, deco in ((outer, outer_decor), (inner, inner_decor)):
        fr, L, k = face_frame(x0, z0, x1, z1, t, out)
        hl = []
        for u0, u1, y0, y1 in holes:
            a, b = (u0 - L / 2) * k, (u1 - L / 2) * k
            hl.append((min(a, b), max(a, b), y0, y1))
        deco(fr, L, h, hl, base_seed + (0 if out == outer else 40))
        if out == outer:
            seed(base_seed + 7)
            for a, b, y0, y1 in hl:
                opening(fr, a, b, y0, y1, h, hl)


_bldg_layout = bldg


def bldg(s, xa, xb, za, zb, doors, key='brick', roofed=True, h=CEIL_Y, seed=1, wins=True, notches=0.15, pitch=3.6):
    _bldg_layout(s, xa, xb, za, zb, doors, key, roofed, h, seed, wins, notches, pitch)
    t = 0.35
    H = CEIL_Y if roofed else h
    cx, cz = (xa + xb) / 2, (za + zb) / 2
    txt = 'BARRACKS ' + ('A' if s > 0 else 'B') if seed == 5 else SIGNS.get(seed)
    s_doors, n_doors = doors.get('S', []), doors.get('N', [])
    if seed == 9:
        south = F(s, cx, zb + t / 2, 0.0)
        for i, u0 in enumerate(s_doors[:3]):
            u = xa + u0 - cx
            plate(south, u, 3.02, 1.9, 0.5, SHOP_TINTS[i], M_WHT, SHOP_NAMES[i], 0.26, M_CHIP, 0.012)
            # a striped awning over the door, above head height
            x0 = u - 1.5
            for j in range(6):
                p, q = x0 + j * 0.5, x0 + (j + 1) * 0.5
                hull('fit', south, [[(p, 2.95, 0.05), (q, 2.95, 0.05), (q, 2.45, 1.0), (p, 2.45, 1.0)],
                                    [(p, 2.91, 0.05), (q, 2.91, 0.05), (q, 2.41, 1.0), (p, 2.41, 1.0)],
                                    [(p, 2.95, 0.05), (p, 2.91, 0.05), (p, 2.41, 1.0), (p, 2.45, 1.0)],
                                    [(q, 2.95, 0.05), (q, 2.91, 0.05), (q, 2.41, 1.0), (q, 2.45, 1.0)],
                                    [(p, 2.95, 0.05), (q, 2.95, 0.05), (q, 2.91, 0.05), (p, 2.91, 0.05)],
                                    [(p, 2.45, 1.0), (q, 2.45, 1.0), (q, 2.41, 1.0), (p, 2.41, 1.0)]], M_AWN[j & 1])
    elif txt:
        # the name over the south door, or over the north one, or in the middle of the south wall
        if n_doors and not s_doors:
            fr, u = F(s, cx, za - t / 2, math.pi), cx - (xa + n_doors[0])
        else:
            fr, u = F(s, cx, zb + t / 2, 0.0), (xa + s_doors[0] - cx) if s_doors else 0.0
        w = min(xb - xa - 1.0, text_w(txt, 0.3) + 0.5)
        plate(fr, u, 2.62, w, 0.5, M_NAME, M_WHT, txt, 0.3, M_CHIP, 0.012)
    seed_ = seed * 977 + 31
    # roof furniture: an aerial and a dish, in a corner away from the layout's own units
    if roofed:
        fr = F(s, cx, cz)
        hx, hz = (xb - xa) / 2, (zb - za) / 2
        top = H + 0.3
        _reseed(seed_)
        sx, sz = (1 if rnd() < 0.5 else -1), (1 if rnd() < 0.5 else -1)
        ax, az = sx * (hx - 1.2), sz * (hz - 1.0)
        tube('fit', fr, [(ax, top, az), (ax, top + 2.2, az)], 0.02, n=4, tint=M_GRAY)
        for yy in (top + 1.1, top + 1.7):
            pbox('fit', fr, ax, yy, az, 0.7, 0.025, 0.025, M_GRAY)
        dx, dz = -sx * (hx - 1.6), sz * (hz - 1.4)
        tube('fit', fr, [(dx, top, dz), (dx, top + 0.5, dz)], 0.025, n=4, tint=M_GRAY)
        lathe('fit', fr, dx, dz, [(0.0, top + 0.5), (0.35, top + 0.62), (0.4, top + 0.7), (0.4, top + 0.73), (0.0, top + 0.6)],
              n=10, tint=srgb(0xb8b6ae))
    # what lies on the floor: brick, paper, damp
    _reseed(seed_ + 5)
    for _ in range(int((xb - xa) * (zb - za) / 20.0)):
        x, z = xa + 0.6 + (xb - xa - 1.2) * rnd(), za + 0.6 + (zb - za - 1.2) * rnd()
        ff = F(s, x, z, rnd() * 6.28)
        kk = rnd()
        if kk < 0.4:
            pbox('fit', ff, 0, 0.04, 0, 0.1 + 0.2 * rnd(), 0.06 + 0.06 * rnd(), 0.1 + 0.15 * rnd(), M_CONC, skip=('-y',))
        elif kk < 0.75:
            fquad(ff, -0.1, -0.14, 0.1, 0.14, 0.012, M_PAPER)
        else:
            blob(ff, 0, 0, 0.25 + 0.3 * rnd(), M_DAMP, 0.012, 8, 0.4)


_wreck_layout = wreck


def wreck(s, x, z, yaw, tint, L=4.4, W=1.9, H=1.45):
    _wreck_layout(s, x, z, yaw, tint, L, W, H)
    fr = F(s, x, z, yaw)
    sf = Frame(fr.o[0], fr.o[1], fr.o[2], fr.yaw - math.pi / 2)
    k = L / 4.4
    hw = W / 2 - 0.05
    ch = hw - 0.1
    seed(int(abs(x * 31 + z * 17)) + 7)
    for side in (1, -1):
        f2 = turn(sf, 0.0 if side > 0 else math.pi)
        zz = hw + 0.006
        for xs in (-0.9 * k, 0.05 * k, 0.95 * k):                 # door seams, on the lower body
            mrect(f2, xs - 0.008, 0.36, xs + 0.008, 0.95, zz, M_SOOT)
        for xs in (-0.45 * k, 0.55 * k):                          # handles
            pbox('fit', f2, xs, 0.86, zz + 0.012, 0.12, 0.028, 0.026, M_GRAY)
        for _ in range(2):
            blob_v(f2, (rnd() - 0.5) * 3.2 * k, 0.5 + 0.3 * rnd(), 0.2 + 0.25 * rnd(), 0.07 + 0.07 * rnd(),
                   M_RUST if rnd() < 0.6 else M_RUST_D, zz + 0.004, 7, 0.4)
        pocks(f2, (rnd() - 0.5) * 2.0 * k, 0.66, 3 + int(rnd() * 3), zz + 0.012, 0.12)
        # a wing mirror hanging off the cabin
        pbox('fit', f2, 0.95 * k, 1.15, ch + 0.08, 0.05, 0.1, 0.14, M_IRON)
    for sg in (-1, 1):
        ff = turn(sf, sg * math.pi / 2)
        plate(ff, 0.0, 0.4, 0.5, 0.12, M_PAPER, M_NUM, 'OV %d' % (100 + int(rnd() * 899)), 0.07, M_NUM, 2.2 * k + 0.104, 'tmark')
    # soot on the cabin roof, and a few chunks of glass on the ground beside it
    blob(sf, -0.1 * k, 0.0, 0.5, M_SOOT, 1.456, 8, 0.3)
    for _ in range(3):
        a = rnd() * 6.28
        fquad(F(s, x + math.cos(a) * 1.5, z + math.sin(a) * 2.2, rnd() * 6), -0.06, -0.04, 0.06, 0.04, 0.0125, M_GLASS)


_bus_layout = bus


def bus(s, x, z, yaw, tint):
    _bus_layout(s, x, z, yaw, tint)
    fr = F(s, x, z, yaw)
    sf = Frame(fr.o[0], fr.o[1], fr.o[2], fr.yaw - math.pi / 2)
    hl, hw = 5.25, 1.23
    seed(int(abs(x * 19 + z * 23)) + 3)
    band = tuple(min(1.0, c * 1.6 + 0.12) for c in tint)
    for side in (1, -1):
        f2 = turn(sf, 0.0 if side > 0 else math.pi)
        zz = hw + 0.006
        mrect(f2, -hl + 0.2, 0.95, hl - 0.6, 1.2, zz, band)
        label(f2, -1.2, 1.26, zz + 0.006, 'CITY TRANSIT', 0.22, M_WHT)
        for xs in (2.35, 3.5):        # the folding doors, forward, in the gaps between windows
            mrect(f2, xs - 0.02, 0.5, xs + 0.02, 1.55, zz, M_SOOT)
        for _ in range(3):
            blob_v(f2, -hl + 1.0 + (hl * 2 - 2.0) * rnd(), 0.65 + 0.2 * rnd(), 0.35, 0.12, M_RUST, zz + 0.012, 7, 0.4)
        pocks(f2, -1.0 + 3.0 * rnd(), 1.3, 6, zz + 0.012, 0.3)
    fx = turn(sf, math.pi / 2)
    plate(fx, 0.0, 1.76, 1.2, 0.3, srgb(0x15171a), M_AMBER, 'ROUTE 7', 0.16, M_BLK, hl + 0.012, 'tglyph')
    plate(fx, 0.0, 0.44, 0.55, 0.13, M_PAPER, M_NUM, 'OV 7731', 0.075, M_NUM, hl + 0.14, 'tmark')
    # a faded advert on the back
    fb = turn(sf, -math.pi / 2)
    plate(fb, 0.0, 1.5, 1.8, 0.8, srgb(0x3a3d41), srgb(0xb8b2a0), 'RADIO OVERRUN', 0.2, M_CHIP, hl + 0.012, 'tmark')


_container_layout = container


def container(s, x, z, along_x, tint, h=2.59, stack=False):
    _container_layout(s, x, z, along_x, tint, h, stack)
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2)
    L, W = 6.06, 2.44
    seed(int(abs(x * 11 + z * 29)) + 17)
    pre = CONT_PREFIX[_state['cont'] % len(CONT_PREFIX)]
    num = '%s %06d 7' % (pre, 100000 + int(rnd() * 899999))
    _state['cont'] += 1
    zz = W / 2 + 0.026
    dark = tuple(c * 0.55 for c in tint)
    light = tuple(min(1.0, c * 1.5 + 0.1) for c in tint)
    for side in (1, -1):
        f2 = turn(fr, 0.0 if side > 0 else math.pi)
        label(f2, -L / 2 + 1.7, h - 0.5, zz, num, fw(num, 2.4, 0.2), M_WHT)
        mrect(f2, -L / 2 + 0.4, h * 0.45, L / 2 - 0.4, h * 0.45 + 0.06, zz, light)
        label(f2, L / 2 - 1.5, h * 0.52, zz, pre, 0.34, light)
        for _ in range(3):
            u = -L / 2 + 0.5 + (L - 1.0) * rnd()
            quadp(f2, [(u - 0.05, h - 0.1), (u + 0.05, h - 0.1), (u + 0.02, h - 0.1 - (0.6 + 1.0 * rnd())),
                       (u - 0.02, h - 0.1 - (0.4 + 0.8 * rnd()))], zz + 0.01, M_RUST_D)
        blob_v(f2, -L / 2 + 0.7 + (L - 1.4) * rnd(), 0.35 + 0.4 * rnd(), 0.4, 0.14, dark, zz + 0.01, 7, 0.4)
    # the door end: a data plate and the lock bars' brackets
    fe = turn(fr, math.pi / 2)
    ze = L / 2 + 0.09
    plate(fe, 0.0, h - 0.5, 1.0, 0.22, M_NAME, M_WHT, 'MAX 30480 KG', 0.1, M_CHIP, ze, 'tmark')
    for sg in (-1, 1):
        pbox('fit', fe, sg * 0.85, h * 0.45, L / 2 + 0.045, 0.07, 0.07, 0.04, M_IRON)


_crate_layout = crate


def crate(s, x, z, size=1.2, h=1.0, base=0.0, yaw=0.0):
    _crate_layout(s, x, z, size, h, base, yaw)
    fr = F(s, x, z, yaw, base)
    hs = size / 2
    txt = _CRATE_TXT[_state['crate'] % len(_CRATE_TXT)]
    _state['crate'] += 1
    for side in range(4):
        sf = turn(fr, side * math.pi / 2)
        zf = hs + 0.004
        if side % 2 == 0:
            label(sf, 0.0, h * 0.58, zf, txt, fw(txt, size * 0.7, 0.11), srgb(0x232a1c))
            mrect(sf, -hs + 0.1, h * 0.34, hs - 0.1, h * 0.34 + 0.03, zf, M_AMBER)


_lamp_layout = lamp_post


def lamp_post(s, x, z, yaw=0.0, h=4.4):
    _lamp_layout(s, x, z, yaw, h)
    fr = F(s, x, z, yaw)
    # a base plate with four bolts, a service hatch and a band of reflective tape
    pbox('fit', fr, 0, 0.03, 0, 0.36, 0.06, 0.36, M_GRAY, skip=('-y',))
    pbox('fit', fr, 0, 0.7, 0.088, 0.14, 0.32, 0.016, M_IRON, skip=('-z',))
    lathe('fit', fr, 0, 0, [(0.092, 1.05), (0.092, 1.15)], n=8, tint=M_AMBER, phase=math.pi / 8)


_rubble_layout = rubble


def rubble(s, x, z, yaw=0.0, size=1.0, seed=1):
    _rubble_layout(s, x, z, yaw, size, seed)
    _reseed(int(seed) * 53 + 11)
    fr = F(s, x, z, yaw)
    for _ in range(int(5 * size)):
        a, d = rnd() * 6.28, (1.5 + 0.9 * rnd()) * size
        ff = Frame(*fr.world((math.cos(a) * d * 1.2, 0.0, math.sin(a) * d * 0.9)), fr.yaw + rnd() * 6.28)
        pbox('fit', ff, 0, 0.05, 0, 0.1 + 0.28 * rnd(), 0.07 + 0.08 * rnd(), 0.1 + 0.2 * rnd(), M_CONC if rnd() < 0.6 else M_BRICK,
             skip=('-y',))
    blob(fr, 0, 0, 2.1 * size, M_DAMP, 0.0125, 11, 0.3)


# ------------------------------------------------------------------ the ground

def road_detail(s):
    """Patches, potholes, manholes, crosswalks and skid marks on both roads, in this half."""
    seed(7001 + s)
    g = F(s, 0, 0)
    # boulevard (|x| < 5, z 11..50) and avenue (x 16..66, z -3.5..4.5)
    for _ in range(9):
        x, z = -4.4 + 8.8 * rnd(), 14.0 + 34.0 * rnd()
        fquad(g, x - 0.6, z - 0.45, x + 0.6, z + 0.45, 0.0125, M_ASPH_P if rnd() < 0.6 else M_ASPH_L)
    for _ in range(7):
        x, z = 18.0 + 46.0 * rnd(), -3.0 + 7.0 * rnd()
        fquad(g, x - 0.6, z - 0.4, x + 0.6, z + 0.4, 0.0125, M_ASPH_P if rnd() < 0.6 else M_ASPH_L)
    for _ in range(5):
        x, z = -4.0 + 8.0 * rnd(), 16.0 + 30.0 * rnd()
        blob(F(s, x, z), 0, 0, 0.5 + 0.4 * rnd(), M_ASPH_L, 0.0135, 9, 0.3)
        blob(F(s, x, z), 0, 0, 0.32 + 0.25 * rnd(), M_OIL, 0.0195, 9, 0.35)
    # manholes
    for mx, mz in ((-2.0, 20.0), (2.4, 30.0), (-1.5, 42.0), (25.0, 1.8), (45.0, -1.2), (60.0, 2.4)):
        fr = F(s, mx, mz)
        ring_decal(fr, 0, 0, 0.42, 0.0125, M_ASPH_L, 14)
        ring_decal(fr, 0, 0, 0.36, 0.0185, M_MAN, 14)
        for k in (-0.2, 0.0, 0.2):
            fquad(fr, -0.3, k - 0.012, 0.3, k + 0.012, 0.0245, M_GRAY)
    # crosswalks where the boulevard meets the plaza and where the avenue leaves it
    for k in range(8):
        fquad(g, -4.2 + k * 1.2, 11.4, -3.6 + k * 1.2, 13.4, 0.0135, M_ZEBRA)
    for k in range(6):
        fquad(g, 17.0, -3.2 + k * 1.3, 19.0, -2.7 + k * 1.3, 0.0135, M_ZEBRA)
    # skid marks: two tyre tracks swerving across the boulevard, two along the avenue
    for off in (-0.7, 0.7):
        p = None
        for i in range(12):
            q = (1.4 + off - 0.012 * i * i, 46.0 - i * 1.3)
            if p:
                floor_seg(g, p, q, 0.1, 0.0145, M_SKID)
            p = q
        p = None
        for i in range(10):
            q = (24.0 + i * 1.4, 1.2 + off + 0.02 * i * i)
            if p:
                floor_seg(g, p, q, 0.1, 0.0145, M_SKID)
            p = q


def scatter(s):
    """Loose things on the open ground: brick chunks, casings, paper, scrap, oil."""
    seed(7100 + s)
    regions = ((-4.6, 4.6, 12.0, 48.0, 28), (-15.0, 15.0, 0.5, 10.5, 20), (17.0, 65.0, -3.2, 4.2, 30),
               (-15.0, 15.0, 37.0, 49.0, 12))
    for x0, x1, z0, z1, n in regions:
        for _ in range(n):
            x, z = x0 + (x1 - x0) * rnd(), z0 + (z1 - z0) * rnd()
            ff = F(s, x, z, rnd() * 6.28)
            kk = rnd()
            if kk < 0.28:
                pbox('fit', ff, 0, 0.04, 0, 0.12 + 0.22 * rnd(), 0.06 + 0.06 * rnd(), 0.1 + 0.15 * rnd(),
                     M_CONC if rnd() < 0.6 else M_BRICK, skip=('-y',))
            elif kk < 0.5:
                for j in range(2):
                    pbox('fit', F(s, x + 0.08 * j, z + 0.05 * (j & 1), rnd() * 6.28), 0, 0.012, 0, 0.012, 0.012, 0.045, M_BRASS,
                         skip=('-y',))
            elif kk < 0.75:
                fquad(ff, -0.1, -0.14, 0.1, 0.14, 0.0125, M_PAPER)
            elif kk < 0.9:
                tube('fit', ff, [(-0.3, 0.02, 0), (0.0, 0.05, 0.12), (0.3, 0.02, 0.04)], 0.012, n=4, tint=M_RUST, caps=False)
            else:
                blob(ff, 0, 0, 0.3 + 0.3 * rnd(), M_OIL, 0.0135, 8, 0.4)


def plaza_detail(s):
    seed(7200 + s)
    g = F(s, 0, 0)
    # cracks in the paving, and weeds that found them
    for _ in range(14):
        x, z = -14.0 + 28.0 * rnd(), 0.5 + 10.0 * rnd()
        if abs(x) < 3.8 and abs(z) < 3.8:
            continue
        ang = rnd() * 6.28
        p = (x, z)
        for i in range(5):
            ang += (rnd() - 0.5) * 1.4
            q = (p[0] + math.cos(ang) * 0.5, p[1] + math.sin(ang) * 0.5)
            floor_seg(g, p, q, 0.025, 0.0125, M_CRACK)
            p = q
        if rnd() < 0.5:
            for _j in range(3):
                a = rnd() * 6.28
                tube('fit', F(s, x, z), [(0, 0, 0), (math.cos(a) * 0.1, 0.12, math.sin(a) * 0.1), (math.cos(a) * 0.2, 0.22, math.sin(a) * 0.2)],
                     0.006, n=3, tint=M_STRAW if rnd() < 0.5 else M_OLIVE, caps=False)
    # the monument: a plaque on each face of the obelisk, and an inscription round the plinth
    for k in range(4):
        fr = Frame(0, 0, 0, k * math.pi / 2)
        plate(fr, 0, 2.4, 1.0, 0.7, srgb(0x2a2d30), srgb(0xd8d3c0), 'REMEMBER', 0.14, M_CHIP, 0.653, 'tmark')
        label(fr, 0.0, 0.18, 3.204, 'FOR THE FALLEN', 0.14, srgb(0x2a2d30))


def base_detail(s):
    nm = 'ALPHA' if s > 0 else 'BRAVO'
    col = M_ALPHA if s > 0 else M_BRAVO
    # the base name, big, on the yard's front wall, facing the boulevard; stripes in the team colour
    fr = F(s, -12.5, 36.0 - 0.25, math.pi)
    mrect(fr, -3.0, 1.3, 3.0, 1.38, 0.005, col)
    label(fr, 0.0, 1.5, 0.006, nm, 0.7, col)
    mrect(fr, -3.0, 2.28, 3.0, 2.36, 0.005, col)
    fr = F(s, 12.5, 36.0 - 0.25, math.pi)
    label(fr, 0.0, 1.5, 0.006, 'BASE ' + ('1' if s > 0 else '2'), 0.5, col)
    # a flagpole by the side wall: a ball, and a flag with a white band
    fp = F(s, 15.35, 46.5)
    tube('fit', fp, [(0, 0, 0), (0, 6.4, 0)], 0.045, n=6, tint=M_GRAY)
    lathe('fit', fp, 0, 0, [(0.0, 6.4), (0.09, 6.45), (0.0, 6.56)], n=8, tint=M_BRASS)
    for j in range(5):
        a0, a1 = -j * 0.34, -(j + 1) * 0.34
        z0, z1 = 0.06 * math.sin(j * 1.6), 0.06 * math.sin((j + 1) * 1.6)
        both_sides('fit', fp, [(a0, 6.2, z0), (a1, 6.2, z1), (a1, 5.35, z1), (a0, 5.35, z0)], col)
        both_sides('fit', fp, [(a0, 5.93, z0 + 0.004), (a1, 5.93, z1 + 0.004), (a1, 5.62, z1 + 0.004), (a0, 5.62, z0 + 0.004)], M_CHIP)
    # a warning board on a stake in front of each sandbag run
    for xx in (-7.0, 7.0):
        sf = F(s, xx, 33.4, math.pi)
        tube('fit', sf, [(0, 0, 0), (0, 1.3, 0)], 0.02, n=5, tint=M_IRON)
        pbox('fit', sf, 0, 1.15, 0, 0.62, 0.32, 0.03, M_BLK)
        plate(sf, 0, 1.0, 0.56, 0.26, M_BLK, M_AMBER, 'HALT', 0.14, M_AMBER, 0.017, 'tmark')


def perimeter_detail():
    seed(7300)
    t = 0.5
    n = 1
    for face, (xa, xb, za, zb) in (('+x', (-HX - t, -HX, -HZ, HZ)), ('-x', (HX, HX + t, -HZ, HZ)),
                                   ('+z', (-HX, HX, -HZ - t, -HZ)), ('-z', (-HX, HX, HZ, HZ + t))):
        L, P = face_fn(face, xa, xb, za, zb)
        yaw = OUT_YAW[face]
        k = 4.5                     # the pilasters stand every 9 m from P(0); signs sit mid-bay
        while k < L - 3.0:
            c = P(k, 0)
            fr = Frame(c[0], 0.0, c[2], yaw)
            plate(fr, 0, 2.4, 1.3, 0.55, M_BLK, M_AMBER, ('DANGER', 'KEEP OUT', 'NO ENTRY')[int(rnd() * 3)], 0.17, M_AMBER, 0.006, 'tmark')
            label(fr, 0.0, 3.4, 0.006, 'SECTOR %02d' % n, 0.28, M_WHT)
            n += 1
            pocks(fr, (rnd() - 0.5) * 6.0, 1.2 + 1.8 * rnd(), 4, 0.006, 0.5)
            if rnd() < 0.5:
                crack(fr, (rnd() - 0.5) * 6.0, 4.6, 1.3, 0.006)
            for _ in range(2):
                rain(fr, (rnd() - 0.5) * 7.0, 5.3, 0.006)
            k += 9.0


def fuel_detail(s):
    cfr = F(s, 48.0, 14.0)
    for sz in (-1, 1):
        ff = turn(cfr, 0.0 if sz > 0 else math.pi)
        label(ff, 0.0, CEIL_Y - 0.06, 4.65 + 0.004, 'OVERRUN FUEL', 0.17, M_WHT)
    # the price board on a pole at the corner of the lot
    pf = F(s, 40.5, 8.5, math.pi / 2)
    tube('fit', pf, [(0, 0, 0), (0, 5.0, 0)], 0.07, n=6, tint=M_GRAY)
    pbox('fit', pf, 0, 4.6, 0, 1.5, 1.7, 0.2, M_BLK)
    for side in (1, -1):
        ff = turn(pf, 0.0 if side > 0 else math.pi)
        zz = 0.104
        label(ff, 0.0, 5.18, zz, 'FUEL', 0.2, M_AMBER)
        for i, (nm, pr) in enumerate((('DIESEL', '1.89'), ('PETROL', '2.15'), ('PREMIUM', '2.39'))):
            y = 4.76 - i * 0.37
            label(ff, -0.38, y, zz, nm, 0.11, M_WHT)
            type_label(ff, 0.46, y, zz, pr, 0.16, M_AMBER, 'tglyph')


def warzone_detail():
    both(road_detail)
    both(scatter)
    both(plaza_detail)
    both(base_detail)
    both(fuel_detail)
    perimeter_detail()
