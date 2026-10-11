"""
desertdetail: the second pass over DESERT. Exec'd by build_desert.py after the layout's own functions
(so it can wrap house, window, entry, rug, arcade, stall, crate, well, cistern, palm, tower and
perimeter) and before `result = ...`. build_layout() calls desert_detail() just before rk_finalize().

Everything here is scenery, in the keys fit / mark / glyph / tmark / tglyph (see detailkit.py):
    - every house face: rising damp at the foot, rain streaks under the sills and the roof spouts,
      cracks, whitewash laid over bad patches, a number plate by each door, pots on the sills and
      the odd timber lattice over a window
    - the arcades: a column of glazed tiles up each pier and a diamond frieze in the band
    - the market: a painted board on the front of each stall, strings of dried goods under the
      awning, stencils on the crates, a damp ring round each well, plates on the cistern, date
      bunches and dead fronds on the palms
    - the town wall: damp, stains, cracks, repairs, sector plates, studs and straps on the gate
      leaves, a name over each gate, a pennant on each tower
    - the ground: cracks in the paving, sand drifted in at the gaps, cart ruts, foot tracks, rugs
      laid out for sale, stones, fallen fronds and sherds

Nothing here emits a collider and nothing moves one: desert.json stays as it was. Decals that share a
key share one polygon offset, so they are layered at least 5 mm apart. Nothing is put on a roof:
the parapets hide it from every place a player can stand.
"""
_desert_blob = blob       # desert's lump (key, fr, x, y, z, rx, ry, tint, n); detailkit has a flat stain of the same name
exec(open(os.path.join(REPO, 'scripts', 'blender', 'detailkit.py')).read())
ground_blob = blob        # detailkit's: (fr, cx, cz, r, tint, y, n, jitter)
blob = _desert_blob
seed(20261012)
_reseed = seed            # house() and palm() take a `seed` argument of their own

M_DAMP = srgb(0x7d6446)
M_STREAK = srgb(0x8a7457)
M_STREAK_D = srgb(0x6f5b44)
M_CRACK = srgb(0x4f4033)
M_WHITE = srgb(0xe6dcc6)
M_DRIFT = srgb(0xc2a074)
M_RUT = srgb(0x73604a)
M_PRINT = srgb(0x6d5c48)
M_PCRACK = srgb(0x5b4a3a)
M_DUST = srgb(0xb59a70)
M_TEAL = srgb(0x1f6b6b)
M_BLUE = srgb(0x2f5d8a)
M_CREAM = srgb(0xe6dcc0)
M_TERRA = srgb(0xb5663a)
M_OCHRE = srgb(0xc9a13a)
M_IRON = srgb(0x3a3d41)
M_INK = srgb(0x3a2a1c)
M_ROPE = srgb(0x8a7550)
M_DRY = srgb(0x8f7b4a)
M_DATE = srgb(0x7a3a1c)
M_STONE = srgb(0xa89678)
TILES = (M_TEAL, M_CREAM, M_BLUE, M_CREAM)
STALL_NAMES = ('SPICES', 'DATES', 'TEA', 'RUGS', 'WATER', 'POTTERY', 'BREAD', 'SALT')
CRATE_TXT = ('DATES', 'SPICE', 'SALT', 'INDIGO', 'FIGS', 'WATER', 'RICE', 'CLOTH')
_state = {'door': 0, 'stall': 0, 'crate': 0}

# Footprints of every house in the layout, in the layout's own half (the other half is the point
# reflection of it): the scatter must not drop things into a building.
FOOTPRINTS = ((-21, 21, -10, 32), (10, 23, 20, 32), (-21, 13, -5, 18.5), (5, 13, 21, 18.5),
              (-42, 26, -21, 32), (-36, 14, -26, 21.5), (-42, 8, -39, 18), (-36, 2, -27, 10), (-24, 2, -17, 8),
              (28, 27, 42, 32), (25, 11, 32, 18), (16, 3, 21, 9), (-14, 10, -5, 13), (5, 10, 14, 13),
              (28, 24, 42, 27), (-26, 10.4, -21, 21.1))


def inside_building(x, z, pad=0.5):
    for x0, z0, x1, z1 in FOOTPRINTS:
        if x0 - pad <= x <= x1 + pad and z0 - pad <= z <= z1 + pad:
            return True
    return abs(x) < 2.9 and abs(z) < 2.9          # the cistern


# ------------------------------------------------------------------ small shared pieces

def both_sides(key, fr, pts, tint):
    """A thin loose piece (a frond, a pennant, a sherd) seen from either side."""
    poly(key, fr, pts, tint)
    poly(key, fr, pts[::-1], tint)


def plate(fr, u, y, w, h, bg, fg, text, ph=None, border=M_CREAM, z=0.006):
    """A painted board with a border and one line of text."""
    mrect(fr, u - w / 2, y, u + w / 2, y + h, z, border)
    mrect(fr, u - w / 2 + 0.02, y + 0.02, u + w / 2 - 0.02, y + h - 0.02, z + 0.006, bg)
    if text:
        ph = ph or fw(text, w - 0.1, h * 0.55)
        type_label(fr, u, y + (h - ph) / 2, z + 0.012, text, ph, fg, 'tmark')


def seg_quad(fr, p0, p1, w, z, tint):
    """A thin straight strip between two (u, y) points on a vertical face."""
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    ln = math.hypot(dx, dy) or 1e-6
    nx, ny = -dy / ln * w / 2, dx / ln * w / 2
    quadp(fr, [(p0[0] - nx, p0[1] - ny), (p1[0] - nx, p1[1] - ny), (p1[0] + nx, p1[1] + ny), (p0[0] + nx, p0[1] + ny)], z, tint)


def floor_seg(fr, p, q, w, y, tint):
    """A thin straight strip between two (x, z) points on the ground."""
    dx, dz = q[0] - p[0], q[1] - p[1]
    ln = math.hypot(dx, dz) or 1e-6
    nx, nz = -dz / ln * w / 2, dx / ln * w / 2
    upoly(fr, [(p[0] - nx, y, p[1] - nz), (q[0] - nx, y, q[1] - nz), (q[0] + nx, y, q[1] + nz), (p[0] + nx, y, p[1] + nz)], tint)


def crack(fr, u, y, ln, z=0.025, w=0.022, tint=M_CRACK):
    """A wandering fissure that runs mostly downward."""
    n = max(3, int(ln / 0.22))
    p = (u, y)
    ang = math.pi * 1.5 + (rnd() - 0.5) * 1.0
    for i in range(n):
        ang += (rnd() - 0.5) * 1.5
        q = (p[0] + math.cos(ang) * ln / n, p[1] + math.sin(ang) * ln / n)
        seg_quad(fr, p, q, w * (1.0 - 0.6 * i / n), z, tint)
        p = q


def blob_v(fr, u, y, rx, ry, tint, z=0.010, n=8, jitter=0.3):
    """An irregular patch on a vertical face."""
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        k = 1.0 - jitter + jitter * 2 * rnd()
        pts.append((u + rx * k * math.cos(a), y + ry * k * math.sin(a)))
    quadp(fr, pts, z, tint)


def streak(fr, u, ytop, ln, w, z, tint):
    """A water stain running down a wall, narrowing as it goes."""
    quadp(fr, [(u - w / 2, ytop), (u + w / 2, ytop), (u + w * 0.3, ytop - ln), (u - w * 0.3, ytop - ln)], z, tint)


def clear_of(holes, u, y, pad):
    """True when (u, y) is at least pad from every opening (u0, u1, y0, y1 in local u)."""
    for a, b, y0, y1 in holes:
        if a - pad <= u <= b + pad and y0 - pad <= y <= y1 + pad:
            return False
    return True


def clear_col(holes, u, ya, yb, pad):
    return all(clear_of(holes, u, y, pad) for y in (ya, (ya + yb) / 2, yb))


def stone_bit(fr, x, z, r, h, tint):
    """A low stone on the ground: five facets and a flat top."""
    lathe('fit', fr, x, z, [(r, 0.0), (r * 0.6, h), (0.0, h)], n=5, tint=tint)


# ------------------------------------------------------------------ what the layout built, as it is built

_faces = {}        # id(frame) -> face name, for the frames face_frame handed out
_cur = None        # the house being built: its openings per face and its windows

_orig_face_frame = face_frame


def face_frame(face, xa, xb, za, zb):
    L, fr = _orig_face_frame(face, xa, xb, za, zb)
    _faces[id(fr)] = face
    return L, fr


_orig_window = window


def window(fr, u, y, wd, ht, kind, tint, shutter):
    _orig_window(fr, u, y, wd, ht, kind, tint, shutter)
    if _cur is not None and id(fr) in _faces:
        _cur['holes'].setdefault(_faces[id(fr)], []).append((u - wd / 2 - 0.35, u + wd / 2 + 0.35, y - 0.25, y + ht + 0.4))
        _cur['wins'].append((fr, u, y, wd, ht, kind))


_orig_rug = rug


def rug(fr, u, y, w, h, tint, edge):
    _orig_rug(fr, u, y, w, h, tint, edge)
    if _cur is not None and id(fr) in _faces:
        _cur['holes'].setdefault(_faces[id(fr)], []).append((u - w / 2 - 0.1, u + w / 2 + 0.1, y - 0.1, y + h + 0.1))


_orig_entry = entry


def entry(fr, u, wd=1.3, ht=2.35, tint=STONE, vous=9, wv=0.2, leaf=True, ring=True):
    _orig_entry(fr, u, wd, ht, tint, vous, wv, leaf, ring)
    if _cur is not None and id(fr) in _faces:
        _cur['holes'].setdefault(_faces[id(fr)], []).append((u - wd / 2 - 0.5, u + wd / 2 + 1.0, 0.0, ht + 0.5))
        # a number on an enamel plate beside the door
        _state['door'] += 1
        num = str((3 + 7 * _state['door']) % 89 + 2)
        plate(fr, u + wd / 2 + wv + 0.34, 1.55, 0.36, 0.24, M_TEAL, M_CREAM, num, 0.13, M_CREAM, 0.006)


# ------------------------------------------------------------------ houses

def shade(c, k):
    return tuple(v * k for v in c)


def damp_band(fr, lo, hi, y0, holes, base, z=0.005):
    """Rising damp along a wall's foot: a run of slanted-topped quads in two tones, darkest at the
    bottom and a shade off the wall's own colour above, so the silhouette is not one hard stair-step.
    (The face takes one colour, so the fade is two layers, not a vertex gradient.)"""
    n = max(2, int((hi - lo) / 0.65))
    us = [lo + (hi - lo) * i / n for i in range(n + 1)]
    hs = [y0 + 0.3 + 0.45 * rnd() for _ in us]
    c_lo, c_hi = shade(base, 0.76), shade(base, 0.92)
    for i in range(n):
        if not clear_of(holes, (us[i] + us[i + 1]) / 2, y0 + 0.3, 0.05):
            continue
        ma, mb = y0 + (hs[i] - y0) * 0.5, y0 + (hs[i + 1] - y0) * 0.5
        quadp(fr, [(us[i], ma), (us[i + 1], mb), (us[i + 1], hs[i + 1]), (us[i], hs[i])], z, c_hi)
        quadp(fr, [(us[i], y0), (us[i + 1], y0), (us[i + 1], mb), (us[i], ma)], z, c_lo)


def wall_decor(fr, L, h, holes, key):
    half = L / 2
    lo, hi = -half + 0.5, half - 0.5
    if hi <= lo:
        return
    base = TINT[key]
    damp_band(fr, lo, hi, 0.5, holes, base)
    # a stain under every window sill, and a second narrower one now and then
    for a, b, y0, y1 in holes:
        if y0 < 0.3 or rnd() < 0.3:
            continue
        cu = (a + b) / 2
        streak(fr, cu + (rnd() - 0.5) * 0.3, y0 + 0.2, 0.5 + 1.1 * rnd(), 0.2 + 0.2 * rnd(), 0.015, shade(base, 0.78))
        if rnd() < 0.4:
            streak(fr, cu + 0.3 + 0.2 * rnd(), y0 + 0.2, 0.4 + 0.7 * rnd(), 0.1, 0.020, shade(base, 0.66))
    # cracks, from the cornice down
    for _ in range(1 + int(L / 6.0)):
        cu, cy = lo + (hi - lo) * rnd(), h - 0.55 - 0.9 * rnd()
        if clear_col(holes, cu, cy - 1.3, cy, 0.25):
            crack(fr, cu, cy, 0.9 + 0.9 * rnd())
    # a patch of fresh limewash or of bare render over a bad place, only a shade off the wall
    for _ in range(1 + int(L / 8.0)):
        cu, cy = lo + 0.6 + (hi - lo - 1.2) * rnd(), 0.9 + 1.1 * rnd()
        if clear_of(holes, cu, cy, 0.8):
            blob_v(fr, cu, cy, 0.4 + 0.3 * rnd(), 0.3 + 0.25 * rnd(), shade(base, 1.12 if rnd() < 0.5 else 0.88), 0.010, 8, 0.35)


def spout_stains(fr, xa, xb, face, h, holes, key):
    """Under each roof spout (house() puts them on the two long faces, W // 5 of them)."""
    if face not in ('+z', '-z'):
        return
    W = xb - xa
    k = max(1, int(W // 5.0))
    cx = (xa + xb) / 2
    sgn = 1.0 if face == '+z' else -1.0
    for i in range(k):
        u = (xa + (i + 0.5) * W / k - cx) * sgn
        if clear_col(holes, u, h - 2.4, h - 0.3, 0.1):
            streak(fr, u, h - 0.3, 1.4 + 1.0 * rnd(), 0.34, 0.015, shade(TINT[key], 0.8))
            streak(fr, u, h - 0.3, 0.8 + 0.6 * rnd(), 0.16, 0.020, shade(TINT[key], 0.66))


def window_extras(fr, u, y, wd, ht, kind):
    """A sill pot, or a timber lattice over the opening."""
    r = rnd()
    if r < 0.22:
        x = u + (rnd() - 0.5) * 0.3
        lathe('fit', fr, x, 0.1, [(0.0, y), (0.07, y), (0.1, y + 0.06), (0.11, y + 0.15), (0.085, y + 0.17), (0.0, y + 0.17)],
              n=6, tint=CLAY[int(rnd() * len(CLAY))])
        lathe('fit', fr, x, 0.1, [(0.0, y + 0.16), (0.14, y + 0.24), (0.1, y + 0.36), (0.0, y + 0.4)],
              n=6, tint=GREENS[int(rnd() * len(GREENS))])
    elif r < 0.36 and kind != 2:
        # a lattice: a frame, three uprights and two rails, a hand's breadth in front of the shutters
        x0, x1, y0, y1 = u - wd / 2 - 0.06, u + wd / 2 + 0.06, y + 0.04, y + ht - 0.12
        zc = 0.115
        for yy in (y0, y1):
            pbox('fit', fr, u, yy, zc, x1 - x0, 0.045, 0.04, DARK_TIMBER, skip=('-y', '-z', '+x', '-x'))
        for xx in (x0, x1, u):
            pbox('fit', fr, xx, (y0 + y1) / 2, zc, 0.04, y1 - y0, 0.04, DARK_TIMBER, skip=('-y', '+y', '-z'))
        for k in (1, 2):
            pbox('fit', fr, u, y0 + (y1 - y0) * k / 3, zc, x1 - x0, 0.025, 0.03, TIMBER, skip=('-y', '-z', '+x', '-x'))


_orig_house = house


def house(x0, z0, x1, z1, h, key='plaster', faces='+x-x+z-z', vigas=False, seed=1, door=None):
    global _cur
    _faces.clear()
    _cur = {'holes': {}, 'wins': []}
    _orig_house(x0, z0, x1, z1, h, key, faces, vigas, seed, door)
    holes, wins = _cur['holes'], _cur['wins']
    _cur = None
    xa, xb = sorted((x0, x1))
    za, zb = sorted((z0, z1))
    _reseed(int(abs(x0 * 131 + z0 * 17 + x1 * 7 + z1 * 3) * 100) % 99991 + 1)
    for face in ('+x', '-x', '+z', '-z'):
        if face not in faces:
            continue
        L, fr = _orig_face_frame(face, xa, xb, za, zb)
        hs = holes.get(face, [])
        wall_decor(fr, L, h, hs, key)
        spout_stains(fr, xa, xb, face, h, hs, key)
    for fr, u, y, wd, ht, kind in wins:
        window_extras(fr, u, y, wd, ht, kind)


# ------------------------------------------------------------------ arcades

_orig_arcade = arcade


def arcade(x0, z0, x1, z1, h, t, key, n, pier, spring, seg=12, block_lintel=0):
    _orig_arcade(x0, z0, x1, z1, h, t, key, n, pier, spring, seg, block_lintel)
    _reseed(int(abs(x0 * 53 + z0 * 29 + x1 * 11 + z1 * 7) * 100) % 99991 + 1)
    along_x = abs(x1 - x0) > abs(z1 - z0)
    L = abs(x1 - x0) if along_x else abs(z1 - z0)
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    yaw = 0.0 if along_x else math.pi / 2
    ow = (L - (n + 1) * pier) / n
    r = ow / 2
    crown = spring + r
    ht = t / 2
    band_y = (crown + h - 0.2) / 2
    for side in (1, -1):
        fr = Frame(cx, 0, cz, yaw + (0.0 if side > 0 else math.pi))
        # a column of glazed tiles up each pier, on the strip the layout set on it
        tw = max(0.1, pier * 0.62 - 0.1)
        for i in range(n + 1):
            uc = -L / 2 + i * (pier + ow) + pier / 2
            if side < 0:
                uc = -uc
            yy = 0.62
            k = 0
            while yy + 0.16 < spring - 0.25:
                mrect(fr, uc - tw / 2, yy, uc + tw / 2, yy + 0.16, ht + 0.1, TILES[(i + k) % 4])
                yy += 0.2
                k += 1
        # a frieze of diamonds in the band over the arches, clear of the keystones and the cornice
        if band_y - 0.09 < crown + 0.2 or band_y + 0.09 > h - 0.2:
            continue
        nd = int((L - 0.6) / 0.34)
        for j in range(nd):
            u = -L / 2 + 0.3 + (j + 0.5) * (L - 0.6) / nd
            if any(abs(u - (-L / 2 + pier + i * (pier + ow) + r)) < 0.42 for i in range(n)):
                continue
            uu = u if side > 0 else -u
            quadp(fr, [(uu - 0.09, band_y), (uu, band_y - 0.09), (uu + 0.09, band_y), (uu, band_y + 0.09)], ht + 0.012, TILES[j % 2 * 2])


# ------------------------------------------------------------------ the market

_orig_stall = stall


def stall(s, x, z, along_x=True, length=3.0, seed=5):
    _orig_stall(s, x, z, along_x, length, seed)
    fr = F(s, x, z, 0.0 if along_x else math.pi / 2)
    _reseed(seed * 977 + 13)
    name = STALL_NAMES[_state['stall'] % len(STALL_NAMES)]
    _state['stall'] += 1
    odd = _state['stall'] % 2
    # a painted board on the cloth over the counter's front (the cloth is at z 0.412)
    plate(fr, 0, 0.4, min(length - 0.3, 1.6), 0.4, M_TEAL if odd else M_OCHRE, M_CREAM if odd else M_INK, name, None, M_CREAM, 0.418)
    # strings of dried goods under the awning's front edge, above head height
    for sx in (-0.38, 0.38):
        u = sx * length
        pbox('fit', fr, u, 2.05, 0.99, 0.012, 0.4, 0.012, M_ROPE, skip=('-y',))
        for k in range(3):
            yk = 1.97 - 0.11 * k
            lathe('fit', fr, u, 0.99, [(0.0, yk - 0.07), (0.055, yk), (0.0, yk + 0.07)], n=5, tint=PRODUCE[int(rnd() * len(PRODUCE))])


_orig_crate = crate


def crate(s, x, z, size=1.4, h=1.0, base=0.0, key='wood', yaw=0.0):
    _orig_crate(s, x, z, size, h, base, key, yaw)
    fr = F(s, x, z, yaw, base)
    hs = size / 2
    _state['crate'] += 1
    pw = min(size - 0.3, 0.9)
    for k in range(4):
        text = CRATE_TXT[(_state['crate'] * 3 + k) % len(CRATE_TXT)]
        f2 = Frame(fr.o[0], fr.o[1], fr.o[2], fr.yaw + k * math.pi / 2)
        mrect(f2, -pw / 2, h * 0.28, pw / 2, h * 0.72, hs + 0.004, M_CREAM)
        ph = fw(text, pw - 0.1, h * 0.3)
        type_label(f2, 0, h * 0.5 - ph / 2, hs + 0.012, text, ph, M_INK, 'tmark')


_orig_well = well


def well(s, x, z):
    _orig_well(s, x, z)
    fr = F(s, x, z)
    _reseed(int(abs(x * 31 + z * 17) * 10) + 5)
    # the paving darkened where the bucket drips
    ground_blob(fr, 0, 0, 1.75, M_DAMP, 0.0125, 12, 0.18)
    ground_blob(fr, 0.2, 0.1, 1.45, M_STREAK_D, 0.0185, 10, 0.2)


_orig_cistern = cistern


def cistern():
    _orig_cistern()
    _reseed(4141)
    S, H = 4.6, 3.4
    names = ('CISTERN', 'WATER', 'NO 1', 'DRINK')
    for i, face in enumerate(('+x', '-x', '+z', '-z')):
        L, f = _orig_face_frame(face, -S / 2, S / 2, -S / 2, S / 2)
        plate(f, 0, 2.63, 1.5, 0.3, M_TEAL, M_CREAM, names[i], None, M_CREAM, 0.012)
        # damp and cracks either side of the door, where the dome sheds
        for sg in (-1, 1):
            streak(f, sg * (1.25 + 0.35 * rnd()), H - 0.38, 0.6 + 0.8 * rnd(), 0.3, 0.015, M_STREAK_D)
            crack(f, sg * (1.3 + 0.3 * rnd()), H - 0.7, 0.9)


_orig_palm = palm


def palm(s, x, z, h=6.4, lean=0.0, seed=3):
    _orig_palm(s, x, z, h, lean, seed)
    fr = F(s, x, z)
    _reseed(seed * 311 + 7)
    top = lean
    # three bunches of dates hanging under the crown, and a skirt of dead fronds
    for j in range(3):
        a = 2 * math.pi * j / 3 + rnd()
        bx, bz = top + 0.32 * math.cos(a), 0.32 * math.sin(a)
        pbox('fit', fr, bx, h - 0.45, bz, 0.025, 0.5, 0.025, M_ROPE, skip=('-y',))
        for k in range(3):
            yk = h - 0.72 - 0.08 * k
            lathe('fit', fr, bx + (k - 1) * 0.05, bz + (k % 2) * 0.05, [(0.0, yk - 0.1), (0.07, yk), (0.0, yk + 0.08)], n=4, tint=M_DATE)
    for i in range(6):
        a = 2 * math.pi * i / 6 + rnd() * 0.5
        ca, sa = math.cos(a), math.sin(a)
        d0, d1 = 0.3, 1.5
        both_sides('fit', fr, [(top + d0 * ca, h - 0.2, d0 * sa), (top + d1 * ca, h - 1.4, d1 * sa),
                               (top + d1 * ca - 0.09 * sa, h - 1.4, d1 * sa + 0.09 * ca),
                               (top + d0 * ca - 0.12 * sa, h - 0.2, d0 * sa + 0.12 * ca)], M_DRY)


_orig_tower = tower


def tower(cx, cz, r=2.9, hgt=9.0, roof_tint=None):
    _orig_tower(cx, cz, r, hgt, roof_tint)
    if roof_tint:
        fr = Frame(cx, 0, cz)
        top = hgt + 2.6
        pbox('fit', fr, 0, top + 0.5, 0, 0.04, 1.0, 0.04, M_IRON, skip=('-y',))
        both_sides('fit', fr, [(0.02, top + 0.9, 0), (0.7, top + 0.78, 0), (0.02, top + 0.6, 0)],
                   M_TEAL if (cx > 0) == (cz > 0) else M_TERRA)


# ------------------------------------------------------------------ the town wall

_orig_perimeter = perimeter


def perimeter():
    _orig_perimeter()
    _reseed(7771)
    names = {'+x': 'WEST', '-x': 'EAST', '+z': 'NORTH', '-z': 'SOUTH'}
    for face, (xa, xb, za, zb) in (('+x', (-HX - 1, -HX, -HZ, HZ)), ('-x', (HX, HX + 1, -HZ, HZ)),
                                   ('+z', (-HX, HX, -HZ - 1, -HZ)), ('-z', (-HX, HX, HZ, HZ + 1))):
        L, fr = _orig_face_frame(face, xa, xb, za, zb)
        n = int(L // 8.0)
        bu = []
        for i in range(n):
            u = (i + 0.5) * L / n - L / 2
            wx, _, wz = fr.world((u, 0, 0))
            if face in ('+z', '-z') and abs(wx) < 6.0:
                continue
            bu.append(u)
        # the buttresses and their slits, and on the long faces the gate
        bad = [(u - 0.6, u + 0.6, 0.0, WALL_H) for u in bu] + [(u + 3.7, u + 4.1, 4.0, 5.6) for u in bu]
        if face in ('+z', '-z'):
            bad.append((-6.0, 6.0, 0.0, WALL_H))
        half = L / 2
        # rising damp along the foot above the stone course
        damp_band(fr, -half + 0.5, half - 0.5, 0.62, bad, TINT['mud'])
        for _ in range(int(L / 4.0)):
            uu = -half + 0.5 + (L - 1.0) * rnd()
            if clear_col(bad, uu, WALL_H - 3.0, WALL_H - 0.3, 0.2):
                streak(fr, uu, WALL_H - 0.3, 1.2 + 2.2 * rnd(), 0.25 + 0.3 * rnd(), 0.015,
                       shade(TINT['mud'], 0.8 if rnd() < 0.5 else 0.66))
        for _ in range(int(L / 9.0)):
            uu, yy = -half + 0.8 + (L - 1.6) * rnd(), WALL_H - 0.8 - 1.6 * rnd()
            if clear_col(bad, uu, yy - 1.4, yy, 0.25):
                crack(fr, uu, yy, 1.2 + 1.2 * rnd())
        for _ in range(int(L / 7.0)):
            uu, yy = -half + 1.0 + (L - 2.0) * rnd(), 1.4 + 3.2 * rnd()
            if clear_of(bad, uu, yy, 0.8):
                blob_v(fr, uu, yy, 0.5 + 0.5 * rnd(), 0.35 + 0.3 * rnd(), shade(TINT['mud'], 1.12 if rnd() < 0.5 else 0.88), 0.010, 8, 0.35)
        # a sector plate between each pair of buttresses
        for i, bu_ in enumerate(bu):
            plate(fr, bu_ + 2.0, 2.5, 1.5, 0.36, M_TEAL, M_CREAM, '%s WALL %d' % (names[face], i + 1), None, M_CREAM, 0.015)
    # the gates: studs and straps on the leaf, a name over the arch
    for s in (1, -1):
        face = '-z' if s > 0 else '+z'
        za, zb = (HZ, HZ + 1) if s > 0 else (-HZ - 1, -HZ)
        L, fr = _orig_face_frame(face, -HX, HX, za, zb)
        r, yc = 2.6, 1.4
        for yy in (0.4, 1.1, 1.9, 2.7, 3.35):
            half = r if yy <= yc else math.sqrt(max(0.0, r * r - (yy - yc) ** 2))
            m = int((half - 0.3) / 0.46)
            for k in range(-m, m + 1):
                xx = k * 0.46 + 0.23 * (1 if int(yy * 10) % 2 else 0)
                if abs(xx) < 0.2 or abs(xx) > half - 0.25:
                    continue
                circle(fr, xx, yy, 0.012, 0.045, M_IRON, 'mark', 6)
        plate(fr, 0, 4.78, 3.0, 0.42, M_TEAL, M_CREAM, 'SOUTH GATE' if s > 0 else 'NORTH GATE', None, M_CREAM, 0.012)
        for sg in (-1, 1):
            for yy in (0.9, 2.1):
                mrect(fr, sg * 1.3 - 0.45, yy - 0.05, sg * 1.3 + 0.45, yy + 0.05, 0.020, M_IRON)


# ------------------------------------------------------------------ the ground

def paving_detail(s):
    _reseed(9100 + s)
    fr = Frame()
    zones = ((-13.0, 13.0, 0.5, 9.0), (-4.0, 4.0, 11.0, 20.0), (-9.0, 9.0, 23.0, 31.0))
    # cracks across the flagstones, kept on the paving, and sand drifted onto it
    for x0, x1, z0, z1 in zones:
        for _ in range(4):
            p = (x0 + (x1 - x0) * rnd(), z0 + (z1 - z0) * rnd())
            ang = rnd() * 6.28
            for _ in range(6):
                ang += (rnd() - 0.5) * 1.2
                q = (p[0] + math.cos(ang) * 0.55, p[1] + math.sin(ang) * 0.55)
                if not (x0 - 0.5 <= q[0] <= x1 + 0.5 and z0 - 0.5 <= q[1] <= z1 + 0.5):
                    break
                floor_seg(fr, (s * p[0], s * p[1]), (s * q[0], s * q[1]), 0.022, 0.0125, M_PCRACK)
                p = q
        for _ in range(3):
            ground_blob(fr, s * (x0 + (x1 - x0) * rnd()), s * (z0 + (z1 - z0) * rnd()), 0.5 + 0.7 * rnd(), M_DRIFT, 0.0125, 9, 0.4)
    # sand blown in across the kerb gaps, in small ragged tongues
    for gx, gz in ((0, 10), (-3, 10.6), (3, 10.6), (0, 21), (-9.5, 22), (9.5, 22)):
        for _ in range(3):
            ground_blob(fr, s * (gx + (rnd() - 0.5) * 2.0), s * (gz + (rnd() - 0.5) * 1.2), 0.3 + 0.35 * rnd(), M_DRIFT, 0.0125, 12, 0.5)
    # cart ruts down the approach, broken where the wheels lifted
    for off in (-0.8, 0.8):
        for i in range(9):
            if rnd() < 0.3:
                continue
            a = (s * (off + 0.04 * math.sin(i * 0.9)), s * (21.0 - i * 1.1))
            b = (s * (off + 0.04 * math.sin((i + 1) * 0.9)), s * (21.0 - (i + 0.8) * 1.1))
            floor_seg(fr, a, b, 0.09, 0.0185, M_RUT)
    # foot tracks, two routes in from the gate to the square, a print every 0.75 m
    for route in (((0.5, 30.0), (0.5, 22.0), (0.9, 12.0), (0.0, 6.0), (-6.0, 1.0), (-12.0, -2.0)),
                  ((-3.0, 30.0), (-3.0, 22.0), (-1.5, 12.0), (3.0, 5.0), (9.0, 1.0))):
        side = 1
        for (ax, az), (bx, bz) in zip(route, route[1:]):
            ln = math.hypot(bx - ax, bz - az)
            dx, dz = (bx - ax) / ln, (bz - az) / ln
            for i in range(int(ln / 0.75)):
                cx, cz = ax + dx * i * 0.75 - dz * 0.12 * side, az + dz * i * 0.75 + dx * 0.12 * side
                side = -side
                pts = []
                for j in range(6):
                    a = 2 * math.pi * j / 6
                    ex, ez = 0.055 * math.cos(a), 0.13 * math.sin(a)
                    pts.append((s * (cx + ex * dz + ez * dx), 0.0125, s * (cz - ex * dx + ez * dz)))
                upoly(fr, pts, M_PRINT)


def rug_on_ground(s, x, z, w, d, yaw, c1, c2, c3):
    fr = F(s, x, z, yaw)
    y = 0.0125
    fquad(fr, -w / 2, -d / 2, w / 2, d / 2, y, c1)
    b = 0.09
    fquad(fr, -w / 2 + b, -d / 2 + b, w / 2 - b, d / 2 - b, y + 0.006, c2)
    for k in (-1, 0, 1):
        fquad(fr, -w / 2 + b, k * d * 0.25 - 0.05, w / 2 - b, k * d * 0.25 + 0.05, y + 0.012, c3)
    upoly(fr, [(-0.2, y + 0.018, 0), (0, y + 0.018, 0.2), (0.2, y + 0.018, 0), (0, y + 0.018, -0.2)], c1)
    for sg in (-1, 1):
        for k in range(5):
            xx = -w / 2 + (k + 0.5) * w / 5
            fquad(fr, xx - 0.02, sg * d / 2, xx + 0.02, sg * (d / 2 + 0.1), y, M_CREAM)


def scatter(s, count, seed_):
    """Stones, fallen fronds, sherds and dust over the open ground, never inside a building."""
    _reseed(seed_ + s)
    fr = Frame()
    for _ in range(count):
        lx, lz = -41.0 + 82.0 * rnd(), -31.0 + 62.0 * rnd()
        r = rnd()
        if inside_building(lx, lz) or inside_building(-lx, -lz):
            continue
        x, z = s * lx, s * lz
        if r < 0.45:
            stone_bit(fr, x, z, 0.08 + 0.1 * rnd(), 0.05 + 0.07 * rnd(), tuple(c * (0.85 + 0.3 * rnd()) for c in M_STONE))
        elif r < 0.7:
            a = rnd() * 6.28
            ca, sa = math.cos(a), math.sin(a)
            both_sides('fit', fr, [(x - ca * 0.8, 0.018, z - sa * 0.8), (x + ca * 0.8, 0.018, z + sa * 0.8),
                                   (x + ca * 0.8 - sa * 0.08, 0.018, z + sa * 0.8 + ca * 0.08),
                                   (x - ca * 0.8 - sa * 0.1, 0.018, z - sa * 0.8 + ca * 0.1)], M_DRY)
        elif r < 0.88:
            a = rnd() * 6.28
            ca, sa = math.cos(a), math.sin(a)
            both_sides('fit', fr, [(x, 0.02, z), (x + 0.16 * ca, 0.03, z + 0.16 * sa), (x - 0.07 * sa, 0.015, z + 0.07 * ca)],
                       CLAY[int(rnd() * len(CLAY))])
        else:
            ground_blob(fr, x, z, 0.3 + 0.2 * rnd(), M_DUST, 0.0125, 8, 0.4)


def desert_detail():
    both(paving_detail)
    # rugs laid out for sale: in the square, in the spawn yards, in a souk street and in the caravan yard
    both(lambda s: rug_on_ground(s, -6.0, 1.0, 1.3, 2.0, 0.15, M_TERRA, M_TEAL, M_CREAM))
    both(lambda s: rug_on_ground(s, 7.6, 2.4, 2.0, 1.3, -0.1, M_BLUE, M_OCHRE, M_CREAM))
    both(lambda s: rug_on_ground(s, 0.5, 26.0, 2.2, 1.4, 0.2, M_OCHRE, M_BLUE, M_CREAM))
    both(lambda s: rug_on_ground(s, -30.0, 23.8, 1.5, 1.0, 0.4, M_TERRA, M_CREAM, M_BLUE))
    both(lambda s: rug_on_ground(s, 30.0, 9.6, 1.6, 1.0, 0.4, M_TEAL, M_CREAM, M_TERRA))
    both(lambda s: scatter(s, 90, 9300))
