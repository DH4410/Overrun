"""
BASTION: two stone keeps and the grass between them, a capture-the-flag map generated in Blender.
64 by 110 m. Each keep is a walled bailey with a flag hall; between them runs open grass with a
raised stone causeway down the middle, ruined walls, standing stones, and a pine grove and a trail
on each flank.

Run inside Blender 4.2+ (Scripting tab, or through the Blender MCP):

    OVERRUN_REPO = r"C:/path/to/repo"
    exec(open(OVERRUN_REPO + "/scripts/blender/build_bastion.py").read())

It rebuilds the BASTION collection and writes assets/maps/bastion.glb and bastion.json. Run with
plain Python instead and it only works out the collider tables (see mapkit.py, plan mode).

The layout, south half (the north half is the same turned half a turn):

    keep         z 40..55: a curtain wall across the width with a gate in the middle (a tower each
                 side) and a postern each flank, the flag hall (open to the front, roofed, with a
                 side door each way) and a barracks block against each flank
    field        |z| < 40: open grass. A ruined wall, a low wall and a boulder each flank, standing
                 stones near the middle, and the causeway: a 1.4 m deck, |z| < 12, with a ramp
                 at each end
    flank        x +-18..22: a dirt trail from each postern the whole length of the map, and a pine
                 grove to its outside

Heights, for movement: low walls, crates and stone blocks are 1.0 m (a hop); the causeway is 1.4 m
(the ramps, or a hop off a block); everything else a player cannot climb is 2.8 m or more. The hall
roof is the lowest thing overhead, 4.6 m, which is CEIL_Y.

How the detail is kept out of the colliders: the build is checked by casting down from 4.2 m
(tests/e2e/blender-maps.spec.mjs). Under that height only the touch keys (grass, paving, castle,
rock, wood, slates, trunk) may show a surface a player could stand on or hit, and each must match a
collider. Everything else below it, the plinths, buttresses, quoins, window surrounds, timber
framing, torches, ivy and bushes, is in a key outside that list ('cut', 'timber', 'plaster',
'shingle', 'thatch', 'flame', 'metal', 'dark', 'pine', 'banner'); above 4.2 m the touch keys are
free. Colliders are emitted in the same order as before, so bastion.json does not change.
"""
import math
import os

MAP = 'bastion'
HX, HZ = 32.0, 55.0      # playable half extents
CURTAIN = 5.2            # the keeps' front wall
CEIL_Y = 4.6             # underside of the hall roof

MATERIALS = {
    'grass':   ((0.30, 0.42, 0.20), 4.0),
    'hill':    ((0.30, 0.42, 0.20), 9.0),     # beyond the walls, no collider
    'dirt':    ((0.42, 0.33, 0.22), 3.0),     # trails: a decal
    'paving':  ((0.50, 0.48, 0.44), 2.5),     # courtyard flags and the causeway deck: a decal on the ground
    'castle':  ((0.58, 0.55, 0.50), 2.5),     # cut stone: keeps, towers, causeway
    'rock':    ((0.50, 0.50, 0.47), 2.5),     # dry stone: field walls, boulders, the flank walls
    'wood':  ((0.45, 0.33, 0.22), 1.5),     # crates, doors, barricades
    'slates':  ((0.30, 0.32, 0.36), 2.5),     # roofs
    'trunk':   ((0.35, 0.27, 0.20), 1.0),
    'pine':    ((1.00, 1.00, 1.00), 1.0),     # needles, ivy and bushes, tinted, no collider
    'banner':  ((1.00, 1.00, 1.00), 1.0),     # cloth, tinted, no collider
    'dark':    ((0.06, 0.06, 0.07), 1.0),     # arrow slits and doorways, flush
    'metal':   ((0.20, 0.20, 0.22), 1.0),
    'far':     ((1.00, 1.00, 1.00), 8.0),     # backdrop, tinted
    # Detail with no collider; none of these is in the ghost probe's touch list.
    'cut':     ((0.66, 0.62, 0.55), 2.5),     # dressed stone: plinths, quoins, arches, buttresses, rubble
    'timber':  ((0.30, 0.21, 0.13), 1.5),     # framing, posts, shutters, stakes
    'plaster': ((0.82, 0.78, 0.68), 2.5),     # whitewashed infill
    'shingle': ((0.40, 0.27, 0.20), 2.0),     # low roofs, under the ghost probe's reach
    'thatch':  ((0.70, 0.58, 0.32), 1.5),
    'flame':   ((1.00, 0.55, 0.12), 1.0),     # torches and braziers: unlit
    # The detail pass (bastiondetail.py): per-piece colour, no collider, none in the ghost probe's list.
    'fit':     ((0.35, 0.37, 0.40), 1.0),     # hardware: studs, hinges, rings, plates
    'mark':    ((1.00, 1.00, 1.00), 1.0),     # paint, stains, lichen: decals
    'glyph':   ((1.00, 1.00, 1.00), 1.0),     # lamp glass: unlit
    'tmark':   ((1.00, 1.00, 1.00), 1.0),     # sign text, a quad per character
    'tglyph':  ((1.00, 1.00, 1.00), 1.0),
    'tuft':    ((1.00, 1.00, 1.00), 1.0),     # grass tufts and wild flowers
}
TINTED = {'pine', 'banner', 'far', 'fit', 'mark', 'glyph', 'tmark', 'tglyph', 'tuft'}
SMOOTH = {'hill'}

PROPS = {
    'barrel': ('wine_barrel_01', 1000, 'cyl', (0.76, 0.87, 0.76)),
}

# Rounded edges, smooth normals and wear (roundkit_dh.py). Nothing in it emits a collider.
RK_ROUND = {'castle': 0.09, 'rock': 0.11, 'cut': 0.06, 'wood': 0.05, 'timber': 0.035, 'plaster': 0.02,
            'slates': 0.05, 'shingle': 0.04, 'trunk': 0.05, 'metal': 0.025, 'thatch': 0.1}
RK_ROUND_DEFAULT = 0.04
RK_CELL = 8.0            # wear patches: metres between cuts
RK_PLAIN = {'far', 'dark', 'banner', 'pine', 'grass', 'hill', 'dirt', 'paving', 'flame',
            'fit', 'mark', 'glyph', 'tmark', 'tglyph', 'tuft'}
RK_WEAR = {'castle': (0.30, 0.14, True), 'rock': (0.30, 0.14, True), 'cut': (0.22, 0.10),
           'plaster': (0.22, 0.12), 'timber': (0.18, 0.10), 'wood': (0.22, 0.10), 'slates': (0.0, 0.12),
           'shingle': (0.0, 0.12), 'trunk': (0.2, 0.10), 'thatch': (0.0, 0.16)}
TINTED = TINTED | set(RK_WEAR)

exec(open(os.path.join(globals()['OVERRUN_REPO'], 'scripts', 'blender', 'mapkit.py')).read())
exec(open(os.path.join(REPO, 'scripts', 'blender', 'roundkit_dh.py')).read())

_vbox_round = vbox


def vbox(key, frame, cx, cy, cz, w, h, d, tint=WHITE, skip=('-y',)):
    """The rounding kit's box, except where the box is too slim for a bevel to show: jambs, slats,
    rivets and beams stay plain, which keeps the file a size a browser can fetch in a blink."""
    if min(w, h, d) < 0.2:
        return _vbox0(key, frame, cx, cy, cz, w, h, d, tint, skip)
    return _vbox_round(key, frame, cx, cy, cz, w, h, d, tint, skip)


GREENS = [srgb(h) for h in (0x2f4a28, 0x365a2c, 0x2a4524, 0x3d5f30)]
TEAM_CLOTH = {1: srgb(0x2f5d8a), -1: srgb(0xa8322a)}     # the south keep is blue's, the north red's
TRIM_CLOTH = srgb(0xe6dcc0)
FACE_YAW = {'+z': 0.0, '+x': math.pi / 2, '-z': math.pi, '-x': -math.pi / 2}


def rnd_gen(seed):
    state = [seed * 2654435761 % 2147483647 or 1]

    def rnd():
        state[0] = (state[0] * 1103515245 + 12345) & 0x7fffffff
        return state[0] / 0x7fffffff
    return rnd


def lin(a, b, n):
    return [a + (b - a) * i / n for i in range(n + 1)]


def W(s, x0, z0, x1, z1, h, t, key, top_key=None, block=1):
    """A wall run in the south half's coordinates, turned with the half."""
    wall(s * x0, s * z0, s * x1, s * z1, h, t, key, block=block, top_key=top_key)


def block(s, key, cx, cz, w, d, h, yaw=0.0, base=0.0):
    solid(key, F(s, cx, cz, yaw), 0, base + h / 2, 0, w, h, d)


def ccol(fr, cx, cz, r, h, y0=0.0, block=1):
    """A cylinder collider on its own: the row cyl() would emit, for pieces that model their own look."""
    x, y, z = fr.world((cx, y0 + h / 2, cz))
    CYLINDERS.append([round(x, 4), round(y, 4), round(z, 4), round(r, 4), round(h, 4), block])


def on_face(fr, cx, cz, face, y=0.0):
    """A frame standing on a wall face: local +z points out of the wall, +x runs along it, +y up."""
    x, yy, z = fr.world((cx, y, cz))
    return Frame(x, yy, z, fr.yaw + FACE_YAW[face])


def radial(o, r, a, y=0.0):
    """A frame on the circle of radius r about world point o at angle a, local +z pointing outward."""
    return Frame(o[0] + r * math.cos(a), y, o[2] + r * math.sin(a), math.atan2(math.cos(a), math.sin(a)))


def disc(key, fr, cx, cz, r, y, n=18, tint=WHITE):
    """A flat circle facing up."""
    pts = [(cx + r * math.cos(2 * math.pi * k / n), y, cz + r * math.sin(2 * math.pi * k / n)) for k in range(n)]
    if newell(pts)[1] < 0:
        pts.reverse()
    poly(key, fr, pts, tint)


def lancet(fr, cx, y0, y1, w, key='dark', z=0.0, tint=WHITE):
    """A pointed slit, in the plane z of a frame whose +z faces the viewer."""
    hw = w / 2
    ys = y1 - w * 1.1
    poly(key, fr, [(cx - hw, y0, z), (cx + hw, y0, z), (cx + hw, ys, z), (cx + hw * 0.5, ys + (y1 - ys) * 0.78, z),
                   (cx, y1, z), (cx - hw * 0.5, ys + (y1 - ys) * 0.78, z), (cx - hw, ys, z)], tint)


def slit(ff, x, y0, y1, w=0.2):
    """An arrow slit with a dressed surround, proud of a wall face."""
    lancet(ff, x, y0, y1, w, z=0.012)
    for sx in (-1, 1):
        vbox('cut', ff, x + sx * (w / 2 + 0.09), (y0 + y1) / 2, 0.05, 0.16, y1 - y0 + 0.06, 0.1)
    vbox('cut', ff, x, y0 - 0.06, 0.06, w + 0.42, 0.12, 0.14, skip=())
    vbox('cut', ff, x, y1 + 0.03, 0.05, w + 0.42, 0.14, 0.1, skip=())


def window(ff, x, y, w=0.9, h=1.15, shutters=True):
    """A small rectangular window in a plastered wall: dark glass, a frame, a sill, shutters."""
    poly('dark', ff, [(x - w / 2, y, 0.12), (x + w / 2, y, 0.12), (x + w / 2, y + h, 0.12), (x - w / 2, y + h, 0.12)])
    for sx in (-1, 1):
        vbox('timber', ff, x + sx * (w / 2 + 0.04), y + h / 2, 0.14, 0.08, h + 0.16, 0.06, skip=())
    for yy in (y - 0.04, y + h + 0.04):
        vbox('timber', ff, x, yy, 0.14, w + 0.16, 0.08, 0.06, skip=())
    vbox('timber', ff, x, y + h / 2, 0.135, 0.05, h, 0.04, skip=())
    vbox('cut', ff, x, y - 0.14, 0.2, w + 0.4, 0.1, 0.22, skip=())
    if shutters:
        for sx in (-1, 1):
            vbox('timber', ff, x + sx * (w / 2 + 0.3), y + h / 2, 0.15, 0.4, h, 0.05, skip=())


def torch(ff, x, y, reach=0.4):
    """A wall torch: an iron arm, a cup and a flame."""
    tube('metal', ff, [(x, y - 0.12, 0.02), (x, y - 0.1, reach * 0.7), (x, y - 0.06, reach)], 0.026, n=6)
    lathe('metal', ff, x, reach, [(0.0, y - 0.12), (0.06, y - 0.1), (0.12, y + 0.04), (0.1, y + 0.06)], n=10)
    lathe('flame', ff, x, reach, [(0.0, y + 0.02), (0.09, y + 0.08), (0.1, y + 0.2), (0.05, y + 0.36), (0.0, y + 0.52)], n=8)


def brazier(fr, cx, cz):
    """An iron fire basket on three legs; its collider is the 0.35 m cylinder it replaces."""
    ccol(fr, cx, cz, 0.35, 0.9)
    for k in range(3):
        a = 2 * math.pi * k / 3 + 0.5
        tube('metal', fr, [(cx + 0.34 * math.cos(a), 0.0, cz + 0.34 * math.sin(a)),
                           (cx + 0.14 * math.cos(a), 0.64, cz + 0.14 * math.sin(a))], 0.028, n=6)
    lathe('metal', fr, cx, cz, [(0.0, 0.5), (0.2, 0.56), (0.42, 0.86), (0.47, 0.93), (0.4, 0.93), (0.0, 0.64)], n=14)
    lathe('flame', fr, cx, cz, [(0.0, 0.86), (0.26, 0.9), (0.23, 1.1), (0.12, 1.32), (0.0, 1.58)], n=10)


def hang_banner(ff, x, ytop, w, h, cloth, z=0.07):
    """A cloth banner on a rod, with a swallow-tail, a little ripple and a pale lozenge."""
    hw = w / 2
    cols = 6
    xs = [x - hw + w * i / cols for i in range(cols + 1)]

    def ybot(xx):
        return ytop - h + 0.55 * (1.0 - abs(xx - x) / hw)

    def zz(i):
        return z + 0.035 * math.sin(i * 1.7)
    for i in range(cols):
        poly('banner', ff, [(xs[i], ytop, zz(i)), (xs[i + 1], ytop, zz(i + 1)), (xs[i + 1], ybot(xs[i + 1]), zz(i + 1)),
                            (xs[i], ybot(xs[i]), zz(i))], cloth)
    cy = ytop - h * 0.42
    poly('banner', ff, [(x, cy + 0.38, z + 0.05), (x + 0.3, cy, z + 0.05), (x, cy - 0.38, z + 0.05), (x - 0.3, cy, z + 0.05)],
         TRIM_CLOTH)
    tube('timber', ff, [(x - hw - 0.14, ytop + 0.05, z - 0.03), (x + hw + 0.14, ytop + 0.05, z - 0.03)], 0.04, n=6)
    for sx in (-1, 1):
        lathe('metal', ff, x + sx * (hw + 0.17), z - 0.03, [(0.0, ytop - 0.02), (0.06, ytop + 0.03), (0.0, ytop + 0.12)], n=8)


def buttress(ff, x, h, w=0.9, out=0.5, key='cut'):
    """A two-step buttress against a wall face."""
    vbox(key, ff, x, h * 0.3, out / 2 - 0.02, w, h * 0.6, out)
    vbox(key, ff, x, h * 0.78, out * 0.3, w * 0.8, h * 0.44, out * 0.62)


def arch_ring(key, fr, cx, span, y0, rise, thick, z0, z1, n=14):
    """A segmental arch of dressed stone: a ring of thickness `thick` over an opening of width
    `span` that springs at y0 and rises `rise`, extruded from z0 to z1."""
    c = span / 2
    R = (c * c + rise * rise) / (2 * rise)
    cy = y0 + rise - R
    a0 = math.asin(c / R)
    ang = lin(-a0, a0, n)
    outer = [(cx + (R + thick) * math.sin(a), cy + (R + thick) * math.cos(a)) for a in ang]
    inner = [(cx + R * math.sin(a), cy + R * math.cos(a)) for a in ang]
    pts = outer + inner[::-1]
    m = len(pts)
    if sum(pts[i][0] * pts[(i + 1) % m][1] - pts[(i + 1) % m][0] * pts[i][1] for i in range(m)) < 0:
        pts.reverse()
    prism(key, fr, pts, z0, z1)


def half_timber(ff, x0, x1, y0, y1, post=1.9, tint=WHITE):
    """Timber framing on a plastered face: sill, mid rail and head beam, posts and braces."""
    L = x1 - x0
    n = max(1, round(L / post))
    xs = [x0 + L * i / n for i in range(n + 1)]
    for y in (y0 + 0.07, (y0 + y1) / 2, y1 - 0.07):
        vbox('timber', ff, (x0 + x1) / 2, y, 0.07, L + 0.1, 0.14, 0.07, tint, skip=())
    for x in xs:
        vbox('timber', ff, x, (y0 + y1) / 2, 0.07, 0.14, y1 - y0, 0.07, tint, skip=())
    for i in range(n):
        a, b = xs[i], xs[i + 1]
        if i % 2 == 0:
            tube('timber', ff, [(a + 0.1, y0 + 0.14, 0.08), (b - 0.1, (y0 + y1) / 2 - 0.08, 0.08)], 0.04, n=6)
        else:
            tube('timber', ff, [(b - 0.1, y0 + 0.14, 0.08), (a + 0.1, (y0 + y1) / 2 - 0.08, 0.08)], 0.04, n=6)


def ivy(fr, x, y, z, r, seed, n=9):
    """A clump of ivy or a low bush: a squat dome of leaves, tinted."""
    rnd = rnd_gen(seed)
    for k in range(2):
        tint = GREENS[int(rnd() * len(GREENS))]
        rr = r * (1.0 - 0.28 * k)
        lathe('pine', fr, x + (rnd() - 0.5) * r * 0.5, z + (rnd() - 0.5) * r * 0.5,
              [(rr * 0.9, y), (rr, y + rr * 0.35), (rr * 0.72, y + rr * 0.85), (rr * 0.3, y + rr * 1.1), (0.0, y + rr * 1.15)],
              n=n, tint=tint, sharp=80.0)


def rubble(fr, x, z, seed, count=5, spread=0.7, rmax=0.34):
    """A heap of rounded stones, none higher than a step."""
    rnd = rnd_gen(seed)
    for _ in range(count):
        a = rnd() * 2 * math.pi
        d = rnd() * spread
        r = rmax * (0.5 + 0.5 * rnd())
        cx, cz = x + d * math.cos(a), z + d * math.sin(a)
        lathe('cut', fr, cx, cz, [(r, 0.0), (r * 1.05, r * 0.45), (r * 0.8, r * 0.9), (r * 0.35, r * 1.05), (0.0, r * 1.08)],
              n=8, sharp=80.0)


# ------------------------------------------------------------------ trees, stones, towers

def pine(s, x, z, h=6.4, seed=1):
    """A pine: the trunk collides as a cylinder, the needles are out of reach."""
    fr = F(s, x, z)
    ccol(fr, 0, 0, 0.4, h)
    rnd = rnd_gen(seed)
    # roots flare only below 0.3 m, and the trunk is straight from there up to the probe height, so
    # a ray never grazes a taper that the collider does not follow
    lathe('trunk', fr, 0, 0, [(0.52, 0.0), (0.44, 0.18), (0.36, 0.3), (0.36, 4.6), (0.22, h + 0.6), (0.0, h + 0.7)],
          n=12, sharp=80.0)
    y = 1.7
    for k, r in enumerate((2.7, 2.35, 1.95, 1.5, 1.0)):
        tint = GREENS[int(rnd() * len(GREENS))]
        rr = r * (0.92 + 0.16 * rnd())
        ht = 1.95 - 0.13 * k
        ox, oz = (rnd() - 0.5) * 0.25, (rnd() - 0.5) * 0.25
        # a drooping skirt, a shoulder, then up to the point
        lathe('pine', fr, ox, oz, [(rr * 0.82, y - 0.1), (rr, y + 0.1 * ht), (rr * 0.66, y + 0.52 * ht), (rr * 0.3, y + 0.82 * ht),
                                   (0.0, y + ht)], n=10, tint=tint, sharp=85.0)
        y += 1.1 - 0.05 * k


def stone(s, x, z, r=1.4, h=2.8):
    """A boulder or standing stone: a cylinder to the game. A boulder (r > 1.2, which the ghost
    probe leaves alone) swells and rolls over; a standing stone stays full width almost to the top,
    because its 12-sided collider has no mesh to back it up where the stone would thin."""
    fr = F(s, x, z)
    ccol(fr, 0, 0, r, h)
    if r > 1.2:
        lathe('rock', fr, 0, 0, [(r * 0.97, 0.0), (r * 1.05, h * 0.16), (r * 1.0, h * 0.45), (r * 0.95, h * 0.72),
                                 (r * 0.78, h * 0.92), (r * 0.45, h * 1.0), (0.0, h)], n=24, sharp=80.0)
        n = 24
    else:
        lathe('rock', fr, 0, 0, [(r, 0.0), (r, h - 0.22), (r * 0.9, h - 0.08), (r * 0.72, h), (0.0, h)], n=12, sharp=80.0)
        n = 12
    for yb in (h * 0.34, h * 0.58):
        torus('cut', fr, 0, yb, 0, r * 1.0, 0.07, n=n, m=6)
    ivy(fr, 0.0, h - 0.12, 0.0, r * 0.6, seed=int(x * 7 + z * 3) % 97 + 1, n=9)
    rubble(fr, 0.0, 0.0, int(abs(x) * 3 + abs(z)) % 89 + 1, count=4, spread=r + 0.55, rmax=0.3)


def tower_viz(fr, r, h, cloth=None, n=24, seed=1):
    """A round tower's look: shaft, plinth, string courses, a corbelled crown under a conical slate
    roof with a finial and pennant; or, under 4.5 m, a ruined stump with a broken rim. The collider
    is the caller's. Above the probe's 4.2 m the stone may be a touch key, so the tall tower's
    crown and roof are castle and slates and the stump's rim is cut stone."""
    ox, _, oz = fr.o
    tall = h > 4.5
    rnd = rnd_gen(seed)
    # shaft: a touch key, capped when low so its collider top has a mesh to meet
    lathe('castle', fr, 0, 0, [(r, 0.0), (r, h)], n=n, caps=(False, not tall))
    lathe('cut', fr, 0, 0, [(r + 0.34, 0.0), (r + 0.34, 0.3), (r + 0.18, 0.72), (r + 0.04, 0.95)], n=n, sharp=80.0)
    for yy in ((h * 0.5, h - 1.25) if tall else (h * 0.55,)):
        torus('cut', fr, 0, yy, 0, r + 0.02, 0.1, n=n, m=6)
    if tall:
        for k in range(4):
            a = 2 * math.pi * k / 4 + 0.6 + seed * 0.3
            slit(radial((ox, 0, oz), r - 0.005, a), 0, h * 0.42, h * 0.42 + 1.5)
        # corbel table and deck under the roof
        lathe('castle', fr, 0, 0, [(r, h - 1.0), (r + 0.1, h - 0.72), (r + 0.26, h - 0.48), (r + 0.4, h - 0.3), (r + 0.4, h),
                                   (0.0, h)], n=n, sharp=80.0)
        m = 16
        for i in range(m):
            a = 2 * math.pi * (i + 0.5) / m
            vbox('cut', radial((ox, 0, oz), r + 0.05, a), 0, h - 0.62, 0.0, 0.3, 0.6, 0.42)
        R0, y0 = r + 0.85, h + 0.25
        H = 3.4 + 0.55 * r
        prof = [(R0, y0), (R0 - 0.14, y0 + 0.24)]
        for t in (0.1, 0.24, 0.4, 0.57, 0.74, 0.88):
            prof.append(((R0 - 0.1) * (1 - t) ** 1.25, y0 + 0.24 + H * t))
        prof.append((0.0, y0 + 0.24 + H))
        lathe('slates', fr, 0, 0, prof, n=n, sharp=70.0)
        lathe('timber', fr, 0, 0, [(r + 0.3, h), (R0 - 0.05, y0)], n=n)
        torus('timber', fr, 0, y0 + 0.02, 0, R0 - 0.06, 0.06, n=n, m=6)
        yt = y0 + 0.24 + H
        lathe('metal', fr, 0, 0, [(0.0, yt - 0.04), (0.15, yt + 0.06), (0.17, yt + 0.2), (0.08, yt + 0.36), (0.0, yt + 0.4)],
              n=10)
        tube('metal', fr, [(0, yt + 0.3, 0), (0, yt + 1.7, 0)], 0.03, n=6)
        if cloth is not None:
            poly('banner', fr, [(0.0, yt + 1.62, 0.0), (0.0, yt + 1.12, 0.0), (1.1, yt + 1.2, 0.0), (0.82, yt + 1.38, 0.0),
                                (1.1, yt + 1.56, 0.0)], cloth)
    else:
        # a stump: a broken rim of unequal stones and rubble round it
        m = 11
        for i in range(m):
            if i in (3, 4, 8):
                continue
            a = 2 * math.pi * (i + 0.5) / m
            hh = 0.25 + 0.55 * rnd()
            vbox('cut', radial((ox, 0, oz), r - 0.18, a), 0, h + hh / 2, 0.0, 0.7, hh, 0.52)
        rubble(fr, 0.0, 0.0, seed + 5, count=7, spread=r + 0.9, rmax=0.42)
        ivy(fr, r * 0.55, 0.3, 0.0, 0.9, seed + 11)


def round_tower(s, x, z, r, h, seed=1):
    fr = F(s, x, z)
    ccol(fr, 0, 0, r, h)
    tower_viz(fr, r, h, TEAM_CLOTH[s], seed=seed)


# ------------------------------------------------------------------ ground and edges

def ground():
    GX, GZ = HX + 1.5, HZ + 1.5
    poly('grass', Frame(), [(-GX, 0, GZ), (GX, 0, GZ), (GX, 0, -GZ), (-GX, 0, -GZ)])
    collider(Frame(), 0, -0.5, 0, 2 * GX, 1.0, 2 * GZ, block=0)
    for sx in (-1, 1):
        flat('dirt', sx * 18.0, -40.0, sx * 22.0, 40.0, 0.004)       # the flank trails
    flat('dirt', -2.5, -38.0, 2.5, 38.0, 0.004)                      # the trail down the middle
    for s in (1, -1):
        flat('paving', -22.0, s * 41.2, 22.0, s * HZ, 0.006)         # the courtyard
        flat('paving', -4.0, s * 36.0, 4.0, s * 40.0, 0.006)         # the apron outside the gate
    # worn patches where the trails meet the keeps and round the causeway's feet: rounded decals
    rnd = rnd_gen(77)
    for s in (1, -1):
        for sx in (-1, 1):
            for k in range(5):
                disc('dirt', Frame(), sx * (14.0 + 6.0 * rnd()), s * (30.0 + 7.0 * rnd()), 1.2 + 1.6 * rnd(), 0.005 + 0.0005 * k)
            for k in range(3):
                disc('dirt', Frame(), sx * (3.0 + 3.0 * rnd()), s * (12.0 + 6.0 * rnd()), 1.0 + 1.2 * rnd(), 0.0055)


def perimeter():
    """The wall round the playable area, outside it, so it blocks nothing: dry stone along the
    field and cut stone round the keeps."""
    t = 1.6
    for sx in (-1, 1):
        x = sx * (HX + t / 2)
        wall(x, -40.0, x, 40.0, 6.0, t, 'rock', block=0)
        for sz in (-1, 1):
            wall(x, sz * 40.0, x, sz * (HZ + t), 6.5, t, 'castle', block=0)
    for sz in (-1, 1):
        wall(-HX - t, sz * (HZ + t / 2), HX + t, sz * (HZ + t / 2), 6.5, t, 'castle', block=0)
    # merlons along the back walls, and the field walls' coping
    for sz in (-1, 1):
        n = int(2 * (HX + t) / 2.0)
        for i in range(n):
            x = -HX - t + (i + 0.5) * 2 * (HX + t) / n
            vbox('castle', Frame(), x, 6.9, sz * (HZ + t / 2), 1.0, 0.8, t)
    for sx in (-1, 1):
        for sz in (-1, 1):
            n = int((HZ + t - 40.0) / 2.0)
            for i in range(n):
                z = sz * (40.0 + (i + 0.5) * (HZ + t - 40.0) / n)
                vbox('castle', Frame(), sx * (HX + t / 2), 6.9, z, t, 0.8, 1.0)
        vbox('rock', Frame(), sx * (HX + t / 2), 6.1, 0.0, t + 0.3, 0.25, 80.0)
    # the walls' inner faces: a plinth, pilasters, slits and torches, none of it in the way
    for sx in (-1, 1):
        ff0 = Frame(sx * HX, 0, 0, FACE_YAW['-x' if sx > 0 else '+x'])
        vbox('cut', ff0, 0, 0.5, 0.1, 2 * (HZ + 1.6), 1.0, 0.2)
        for z in range(-36, 37, 8):
            buttress(Frame(sx * HX, 0, z, FACE_YAW['-x' if sx > 0 else '+x']), 0, 4.6, 0.9, 0.38)
        for z in (-28, -12, 12, 28):
            torch(Frame(sx * HX, 0, z + 4, FACE_YAW['-x' if sx > 0 else '+x']), 0, 3.0)
    for sz in (-1, 1):
        ff0 = Frame(0, 0, sz * HZ, FACE_YAW['-z' if sz > 0 else '+z'])
        vbox('cut', ff0, 0, 0.5, 0.1, 2 * (HX + 1.6), 1.0, 0.2)
        for x in range(-28, 29, 8):
            buttress(Frame(x, 0, sz * HZ, FACE_YAW['-z' if sz > 0 else '+z']), 0, 4.6, 0.9, 0.38)
    # corner towers, beyond the corners of the keeps
    for sx in (-1, 1):
        for sz in (-1, 1):
            tower_viz(Frame(sx * (HX + 2.0), 0, sz * (HZ + 2.0)), 3.4, 10.0, TEAM_CLOTH[sz], seed=4 + sx + 2 * sz)


# ------------------------------------------------------------------ the keeps

def curtain(s):
    """The front wall of a keep: a gate in the middle, a tower each side of it, a postern each flank."""
    t = 1.4
    zc = 40.0
    fr = F(s, 0, zc)
    segs = [(-HX, -22.0), (-18.0, -3.5), (3.5, 18.0), (22.0, HX)]
    for x0, x1 in segs:
        W(s, x0, zc, x1, zc, CURTAIN, t, 'castle')
        L, xm = x1 - x0, (x0 + x1) / 2
        for sz in (-1, 1):                                   # a plinth, both faces
            vbox('cut', fr, xm, 0.5, sz * (t / 2 + 0.12), L, 1.0, 0.24)
        vbox('castle', fr, xm, 4.78, -(t / 2 + 0.08), L, 0.26, 0.16)      # string course under the parapet
        # slits and buttresses along both faces, counted from the segment's right-hand end
        k = x1 - 2.0
        while k > x0 + 1.0:
            for face, zf in (('-z', -t / 2), ('+z', t / 2)):
                slit(on_face(fr, k, zf, face), 0, 2.9, 4.1)
            if k - 2.0 > x0 + 0.8:
                buttress(on_face(fr, k - 2.0, -t / 2, '-z'), 0, 4.3)
            k -= 4.0
        # merlons
        n = int((x1 - x0) / 2.0)
        for i in range(n):
            x = x0 + (i + 0.5) * (x1 - x0) / n
            vbox('castle', F(s, x, zc), 0, CURTAIN + 0.4, 0, 1.0, 0.8, t)
        for xe in (x0, x1):                                  # quoins up the ends beside the openings
            if abs(xe) in (HX,):
                continue
            inw = -1.0 if xe == x1 else 1.0
            for j in range(4):
                w = 0.55 if j % 2 == 0 else 0.9
                vbox('cut', fr, xe + inw * (w / 2 - 0.02), 0.35 + 0.95 * j, 0.0, w, 0.4, t + 0.1)
    for sx in (-1, 1):
        round_tower(s, sx * 5.7, zc, 2.2, 7.5, seed=2 + sx)
        # the postern: a timber lintel over the gap, out of reach
        vbox('wood', F(s, sx * 20.0, zc), 0, CURTAIN - 0.5, 0, 4.4, 0.7, t + 0.3)
        arch_ring('cut', fr, sx * 20.0, 4.0, 3.0, 0.9, 0.42, -(t / 2 + 0.1), t / 2 + 0.1)
    # the great gate: a stone lintel with the timber doors folded back against the towers
    vbox('castle', F(s, 0, zc), 0, 5.0, 0, 8.4, 1.2, t + 0.4)
    for sx in (-1, 1):
        solid('wood', F(s, sx * 3.35, zc - 0.9), 0, 1.9, 0, 0.2, 3.8, 1.8)
    # the arch round the gate, a keystone, and a raised portcullis
    arch_ring('cut', fr, 0.0, 7.0, 3.2, 1.2, 0.55, -(t / 2 + 0.12), t / 2 + 0.12)
    vbox('cut', fr, 0.0, 5.0, 0.0, 0.55, 0.7, t + 0.34)
    for sx in (-1, 1):
        d = F(s, sx * 3.35, zc - 0.9)
        for fa in ('+x', '-x'):
            ff = on_face(d, 0.1 if fa == '+x' else -0.1, 0.0, fa)
            for yb in (0.7, 1.9, 3.1):
                vbox('metal', ff, 0.0, yb, 0.02, 1.7, 0.16, 0.04)
    for i in range(14):
        x = -3.1 + i * 0.475
        tube('metal', fr, [(x, 3.45, -0.15), (x, 4.42, -0.15)], 0.03, n=6)
    for y in (3.7, 4.2):
        tube('metal', fr, [(-3.2, y, -0.15), (3.2, y, -0.15)], 0.028, n=6)
    # torches either side of the gate, and a banner each side on the courtyard face
    for sx in (-1, 1):
        for dx in (-1.1, 1.1):
            torch(Frame(*fr.world((sx * 5.7 + dx, 0.0, -(math.sqrt(2.2 ** 2 - dx ** 2)))), fr.yaw + math.pi), 0, 2.7)
    for sx in (-1, 1):
        hang_banner(on_face(fr, sx * 14.4, t / 2, '+z'), 0.0, 4.7, 1.5, 3.2, TEAM_CLOTH[s])


def flag_hall(s):
    """Open to the courtyard, roofed, a doorway through each side wall, the flag on a plinth at the back."""
    cx, cz = 0.0, 49.0
    HW = 8.4
    fr0 = F(s, 0, 0)
    frh = F(s, cx, cz)
    # side walls with a doorway each, the back wall, and a pier at each front corner
    for sx in (-1, 1):
        W(s, sx * HW, 44.8, sx * HW, 47.3, 4.6, 1.2, 'castle')
        W(s, sx * HW, 50.7, sx * HW, 54.4, 4.6, 1.2, 'castle')
        for zz in (47.3, 50.7):
            solid('wood', F(s, sx * HW, zz), 0, 1.1, 0, 1.3, 2.2, 0.16)       # door posts, flush with the wall ends
        # the pier: base, shaft, moulded capital
        pf = F(s, sx * HW, 44.2)
        ccol(pf, 0, 0, 0.7, 4.6)
        lathe('cut', pf, 0, 0, [(0.98, 0.0), (0.98, 0.25), (0.82, 0.55), (0.74, 0.7)], n=12, sharp=80.0)
        lathe('castle', pf, 0, 0, [(0.7, 0.0), (0.7, 4.6)], n=12, caps=(False, True))
        torus('cut', pf, 0, 2.3, 0, 0.7, 0.07, n=12, m=6)
        lathe('castle', pf, 0, 0, [(0.7, 4.6), (0.92, 4.7), (1.06, 4.86), (1.06, 5.02), (0.0, 5.02)], n=12, sharp=80.0)
    W(s, -HW - 0.6, 54.4, HW + 0.6, 54.4, 5.0, 1.2, 'castle')
    # the side walls' outer faces: plinth, quoins, slits, a timber lintel over each doorway
    for sx in (-1, 1):
        fa = '+x' if sx > 0 else '-x'
        for z0, z1 in ((44.8, 47.3), (50.7, 54.4)):
            vbox('cut', fr0, sx * (HW + 0.72), 0.5, (z0 + z1) / 2, 0.24, 1.0, z1 - z0)
        slit(on_face(fr0, sx * (HW + 0.6), 45.8, fa), 0, 1.7, 3.4)
        slit(on_face(fr0, sx * (HW + 0.6), 52.5, fa), 0, 1.7, 3.4)
        buttress(on_face(fr0, sx * (HW + 0.6), 54.0, fa), 0, 4.4, 0.9, 0.4)
        vbox('timber', fr0, sx * HW, 3.78, 49.0, 1.6, 0.44, 3.5, skip=())
        for j in range(4):                                   # quoins up each side of the doorway
            w = 0.55 if j % 2 == 0 else 0.9
            vbox('cut', fr0, sx * HW, 0.35 + 0.95 * j, 47.3 - w / 2 + 0.02, 1.5, 0.4, w)
            vbox('cut', fr0, sx * HW, 0.35 + 0.95 * j, 50.7 + w / 2 - 0.02, 1.5, 0.4, w)
    # the roof slab and its pitched shingles (visual only above it)
    zlo, zhi = (43.4, 54.9) if s > 0 else (-54.9, -43.4)
    slab('slates', -(HW + 0.9), zlo, HW + 0.9, zhi, CEIL_Y, 0.3, block=0)
    prism('slates', frh, [(-(HW + 1.2), CEIL_Y + 0.3), (HW + 1.2, CEIL_Y + 0.3), (0, CEIL_Y + 2.6)], -6.0, 6.0)
    tube('slates', frh, [(0, CEIL_Y + 2.62, -6.1), (0, CEIL_Y + 2.62, 6.1)], 0.2, n=10)
    for sx in (-1, 1):
        tube('timber', frh, [(sx * (HW + 1.22), CEIL_Y + 0.28, -6.12), (sx * (HW + 1.22), CEIL_Y + 0.28, 6.12)], 0.1, n=6)
    # a louvred lantern on the ridge
    for k in range(8):
        a = 2 * math.pi * k / 8
        tube('timber', frh, [(0.95 * math.cos(a), CEIL_Y + 2.5, 0.95 * math.sin(a)), (0.95 * math.cos(a), CEIL_Y + 3.9, 0.95 * math.sin(a))],
             0.07, n=6)
    lathe('dark', frh, 0, 0, [(0.9, CEIL_Y + 2.7), (0.9, CEIL_Y + 3.8)], n=8)
    lathe('slates', frh, 0, 0, [(1.4, CEIL_Y + 3.82), (1.15, CEIL_Y + 3.98), (0.5, CEIL_Y + 4.7), (0.0, CEIL_Y + 5.3)], n=8, sharp=70.0)
    lathe('metal', frh, 0, 0, [(0.0, CEIL_Y + 5.25), (0.1, CEIL_Y + 5.35), (0.0, CEIL_Y + 5.6)], n=8)
    # the open gable at the front: a timber truss and the keep's arms
    zf = -5.9
    for sx in (-1, 1):
        tube('timber', frh, [(sx * (HW + 1.0), CEIL_Y + 0.4, zf), (0.0, CEIL_Y + 2.45, zf)], 0.13, n=6)
        tube('timber', frh, [(sx * 1.0, CEIL_Y + 0.4, zf), (sx * 3.4, CEIL_Y + 1.6, zf)], 0.09, n=6)
    tube('timber', frh, [(0, CEIL_Y + 0.3, zf), (0, CEIL_Y + 2.5, zf)], 0.12, n=6)
    tube('timber', frh, [(-(HW + 1.1), CEIL_Y + 0.32, zf), (HW + 1.1, CEIL_Y + 0.32, zf)], 0.13, n=6)
    # rafters showing under the roof
    for z in (45.0, 49.0, 53.0):
        vbox('wood', F(s, 0, z), 0, CEIL_Y - 0.2, 0, 2 * HW, 0.35, 0.3, skip=())
    # the plinth the flag stands on (a step of stone, under 0.3 m), and the banners on the back wall
    lathe('castle', F(s, 0, 49.8), 0, 0, [(2.0, 0.0), (2.0, 0.08), (1.82, 0.14), (1.5, 0.14), (0.0, 0.14)], n=24, sharp=80.0)
    lathe('castle', F(s, 0, 49.8), 0, 0, [(1.5, 0.14), (1.42, 0.2), (1.1, 0.2), (0.0, 0.2)], n=24, sharp=80.0)
    for x in (-5.0, 5.0):
        hang_banner(on_face(fr0, x, 53.8, '-z'), 0.0, 4.4, 1.6, 3.2, TEAM_CLOTH[s])
    for x in (-2.4, 2.4):
        torch(on_face(fr0, x, 53.8, '-z'), 0.0, 2.7)
    # braziers either side of the front
    for sx in (-1, 1):
        brazier(F(s, 0, 0), sx * 4.2, 45.0)


def barracks(s):
    """A plastered, half-timbered block on a stone plinth, a pitched slate roof with a chimney."""
    fr0 = F(s, 0, 0)
    for sx in (-1, 1):
        cx, cz, w, d, h = sx * 27.0, 49.0, 7.0, 9.0, 5.0
        block(s, 'castle', cx, cz, w, d, h)
        fr = F(s, cx, cz)
        prism('slates', fr, [(-w / 2 - 0.5, h), (w / 2 + 0.5, h), (0, h + 2.0)], -d / 2 - 0.5, d / 2 + 0.5)
        tube('slates', fr, [(0, h + 2.02, -d / 2 - 0.55), (0, h + 2.02, d / 2 + 0.55)], 0.15, n=8)
        for sg in (-1, 1):
            tube('timber', fr, [(sg * (w / 2 + 0.52), h + 0.04, -d / 2 - 0.55), (sg * (w / 2 + 0.52), h + 0.04, d / 2 + 0.55)], 0.08, n=6)
        # whitewash over the stone above a knee-high plinth, timber over that
        vbox('plaster', fr, 0, 3.05, 0, w + 0.1, 3.9, d + 0.1, skip=('-y', '+y'))
        vbox('cut', fr, 0, 0.55, 0, w + 0.26, 1.1, d + 0.26)
        inw = '-x' if sx > 0 else '+x'
        out = '+x' if sx > 0 else '-x'
        for face, cxx, czz, length in ((inw, cx + (-1 if sx > 0 else 1) * (w / 2 + 0.05), cz, d),
                                       (out, cx + (1 if sx > 0 else -1) * (w / 2 + 0.05), cz, d),
                                       ('-z', cx, cz - d / 2 - 0.05, w)):
            ff = on_face(fr0, cxx, czz, face)
            half_timber(ff, -length / 2, length / 2, 1.1, 4.95)
        # courtyard face: a door under a lintel, and shuttered windows
        ff = on_face(fr0, cx + (-1 if sx > 0 else 1) * (w / 2 + 0.05), cz, inw)
        poly('dark', ff, [(-0.7, 0.0, 0.12), (0.7, 0.0, 0.12), (0.7, 2.3, 0.12), (-0.7, 2.3, 0.12)])
        for sg in (-1, 1):
            vbox('timber', ff, sg * 0.82, 1.2, 0.13, 0.16, 2.5, 0.1, skip=())
        vbox('timber', ff, 0.0, 2.42, 0.13, 1.8, 0.18, 0.1, skip=())
        vbox('cut', ff, 0.0, 0.06, 0.34, 2.0, 0.12, 0.6, skip=())
        torch(ff, 1.4, 2.6, 0.34)
        window(ff, -2.6, 2.45, 0.9, 1.15)
        window(ff, 2.6, 2.45, 0.9, 1.15)
        ff = on_face(fr0, cx, cz - d / 2 - 0.05, '-z')
        window(ff, -1.7, 2.45, 0.9, 1.15)
        window(ff, 1.7, 2.45, 0.9, 1.15)
        ff = on_face(fr0, cx + (1 if sx > 0 else -1) * (w / 2 + 0.05), cz, out)
        window(ff, -2.4, 2.45, 0.9, 1.15)
        window(ff, 2.4, 2.45, 0.9, 1.15)
        # the chimney, through the roof
        vbox('castle', fr, w * 0.2, h + 1.7, -d * 0.18, 0.9, 3.4, 0.9)
        vbox('cut', fr, w * 0.2, h + 3.45, -d * 0.18, 1.15, 0.2, 1.15, skip=())
        vbox('cut', fr, w * 0.2, h + 3.62, -d * 0.18, 0.8, 0.2, 0.8, skip=())


def well(s, x, z):
    """A round well-head, a hop high, with a little roof over a windlass."""
    fr = F(s, x, z)
    ccol(fr, 0, 0, 1.0, 1.0)
    lathe('rock', fr, 0, 0, [(1.0, 0.0), (1.0, 0.93), (0.93, 1.0), (0.64, 1.0), (0.6, 0.94)], n=12, sharp=80.0)
    disc('rock', fr, 0, 0, 0.6, 0.93, n=12, tint=srgb(0x25353f))       # the water, a tinted disc 7 cm under the rim
    lathe('cut', fr, 0, 0, [(1.18, 0.0), (1.18, 0.14), (1.04, 0.2)], n=12, sharp=80.0)
    for sg in (-1, 1):
        tube('timber', fr, [(sg * 0.78, 1.0, 0.0), (sg * 0.78, 3.0, 0.0)], 0.07, n=8)
    tube('timber', fr, [(-0.95, 2.82, 0.0), (0.95, 2.82, 0.0)], 0.07, n=8)
    tube('timber', fr, [(-0.78, 2.1, 0.0), (0.78, 2.1, 0.0)], 0.09, n=8)       # the windlass
    rprism('shingle', fr, [(-1.25, 2.95), (1.25, 2.95), (0.0, 3.75)], -0.95, 0.95)
    tube('timber', fr, [(0.2, 2.1, 0.0), (0.2, 1.35, 0.0)], 0.012, n=4)
    lathe('timber', fr, 0.2, 0.0, [(0.0, 1.0), (0.14, 1.04), (0.17, 1.3), (0.0, 1.3)], n=10)
    tube('timber', fr, [(0.78, 2.1, 0.0), (0.9, 2.1, 0.18), (0.9, 1.8, 0.18)], 0.03, n=6)


def courtyard(s):
    """Cover pushed to the walls, so the middle of the bailey stays open ground to fight and spawn on."""
    for sx in (-1, 1):
        crate(s, sx * 12.4, 53.4, 1.4, 1.0)
        crate(s, sx * 12.4, 53.4, 1.0, 1.0, base=1.0, yaw=0.4)
        crate(s, sx * 21.0, 42.4, 1.2, 1.0, yaw=0.2)
        well(s, sx * 21.6, 53.6)
        prop('barrel', s, sx * 17.5, 53.8)
        prop('barrel', s, sx * 18.6, 53.2)
        prop('barrel', s, sx * 15.4, 53.9)
    # sacks on the stacked crates
    for sx in (-1, 1):
        c = F(s, sx * 12.4, 53.4)
        for ox, oz in ((-0.2, -0.15), (0.25, 0.1)):
            lathe('thatch', c, ox, oz, [(0.0, 2.0), (0.22, 2.02), (0.3, 2.2), (0.18, 2.4), (0.0, 2.44)], n=8, sharp=80.0)


# ------------------------------------------------------------------ the field

def causeway():
    wall(0, -12.0, 0, 12.0, 1.4, 10.0, 'castle', top_key='paving')
    for sx in (-1, 1):                  # a low kerb of dressed stone along each edge, flush with the deck
        vbox('rock', Frame(), sx * 4.8, 1.55, 0.0, 0.4, 0.3, 24.0)
        vbox('cut', Frame(), sx * 5.08, 0.18, 0.0, 0.22, 0.36, 24.0)      # a moulded foot


def field(s):
    ramp(s, 0, 0, 18.4, 0, 1.4, 12.0, 5.0, 'paving', 'castle')
    crate(s, -2.6, 5.5, 1.3, 1.0, base=1.4, key='wood')
    for sx in (-1, 1):
        # the ruined wall: an L of 3.0 m wall, broken at the top
        W(s, sx * 8.0, 26.0, sx * 15.0, 26.0, 3.0, 1.0, 'rock')
        W(s, sx * 15.0, 26.0, sx * 15.0, 30.5, 3.0, 1.0, 'rock')
        vbox('rock', F(s, sx * 9.5, 26.0), 0, 3.1, 0, 1.4, 0.2, 1.0)
        vbox('rock', F(s, sx * 13.0, 26.0), 0, 3.1, 0, 1.0, 0.2, 0.96)
        fr0 = F(s, 0, 0)
        # ivy up the ruin, a heap of fallen stone at its feet, a worn cap of cut stone
        for k, xx in enumerate((8.8, 10.6, 12.2, 14.4)):
            ivy(fr0, sx * xx, 0.1 + 0.9 * (k % 2), 25.4, 0.55 + 0.1 * k, seed=11 + k + (5 if sx > 0 else 0))
        rubble(fr0, sx * 11.5, 24.7, 31 + sx, count=6, spread=2.2, rmax=0.36)
        rubble(fr0, sx * 15.9, 31.3, 41 + sx, count=5, spread=0.9, rmax=0.36)
        vbox('cut', F(s, sx * 11.5, 26.0), 0, 3.02, 0, 1.8, 0.1, 1.2, skip=())
        # low walls: a hop
        W(s, sx * 4.0, 34.0, sx * 11.0, 34.0, 1.0, 0.7, 'rock')
        W(s, sx * 13.5, 14.0, sx * 17.0, 14.0, 1.0, 0.7, 'rock')
        W(s, sx * 13.5, 14.0, sx * 13.5, 10.0, 1.0, 0.7, 'rock')
        for xa, xb, zz in ((4.0, 11.0, 34.0), (13.5, 17.0, 14.0)):
            vbox('cut', F(s, sx * (xa + xb) / 2, zz), 0, 1.04, 0, xb - xa + 0.1, 0.12, 0.86, skip=())
        vbox('cut', F(s, sx * 13.5, 12.0), 0, 1.04, 0, 0.86, 0.12, 4.1, skip=())
        # a boulder, a stump of tower, standing stones
        stone(s, sx * 21.0, 28.0 if sx > 0 else 24.0, 1.5, 2.9)
        round_tower(s, sx * 12.5, 5.0, 2.0, 3.2, seed=7 + sx)
        stone(s, sx * 8.5, 3.5, 1.0, 3.4)
        # a barricade of planks outside the gate, and sharpened stakes leaning out of it
        block(s, 'wood', sx * 8.0, 37.0, 3.0, 0.5, 1.0, yaw=sx * 0.35)
        bf = F(s, sx * 8.0, 37.0, sx * 0.35)
        for xx in lin(-1.3, 1.3, 5):
            tube('timber', bf, [(xx, 0.05, -0.1), (xx + 0.04, 1.55, -0.95)], 0.065, n=6)
            lathe('timber', bf, xx + 0.04, -0.95, [(0.065, 1.5), (0.0, 1.78)], n=6)
        tube('timber', bf, [(-1.45, 0.62, -0.36), (1.45, 0.62, -0.36)], 0.035, n=6)
        # the pine grove beyond the trail
        for i, (x, z) in enumerate(((25.0, 33.0), (27.5, 27.0), (24.5, 21.5), (28.5, 16.0), (25.5, 9.0), (29.0, 3.0),
                                    (26.5, 36.5), (23.8, 13.0))):
            pine(s, sx * x, z, 6.2 + 0.3 * (i % 3), seed=3 + i + (7 if sx > 0 else 0))
        # bushes and fern where the grove meets the trail, and along the low walls
        for k, (bx, bz, br) in enumerate(((23.0, 30.0, 0.7), (22.8, 24.0, 0.55), (23.2, 18.0, 0.8), (22.9, 6.5, 0.6),
                                          (6.0, 36.0, 0.6), (11.8, 35.0, 0.5), (18.0, 12.5, 0.55), (13.0, 8.0, 0.5))):
            ivy(fr0, sx * bx, 0.0, bz, br, seed=60 + k + (9 if sx > 0 else 0), n=9)
    # a couple of fallen blocks on the trail
    for sx in (-1, 1):
        crate(s, sx * 20.3, 19.0, 1.2, 1.0, key='wood', yaw=0.25)


# ------------------------------------------------------------------ beyond the walls

def house_far(x, y, z, yaw, w=6.0, d=8.0, h=3.2):
    fr = Frame(x, y, z, yaw)
    vbox('plaster', fr, 0, h / 2 - 0.3, 0, w, h + 0.6, d)
    prism('shingle', fr, [(-w / 2 - 0.45, h), (w / 2 + 0.45, h), (0, h + 2.5)], -d / 2 - 0.45, d / 2 + 0.45)
    vbox('timber', fr, 0, h - 0.1, 0, w + 0.12, 0.2, d + 0.12, skip=())
    vbox('castle', fr, w * 0.22, h + 2.0, -d * 0.2, 0.8, 2.4, 0.8)


def windmill(x, y, z, yaw):
    fr = Frame(x, y, z, yaw)
    lathe('plaster', fr, 0, 0, [(3.5, -0.6), (3.2, 0.5), (2.2, 9.0), (2.5, 9.2), (0.0, 9.2)], n=14, sharp=70.0)
    lathe('shingle', fr, 0, 0, [(2.8, 9.1), (2.5, 10.2), (1.4, 11.7), (0.0, 12.3)], n=14, sharp=70.0)
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        c, sn = math.cos(a), math.sin(a)

        def rot(px, py):
            return (px * c - py * sn, 9.9 + px * sn + py * c)
        beam = [rot(-0.18, 0.4), rot(0.18, 0.4), rot(0.18, 9.4), rot(-0.18, 9.4)]
        sail = [rot(0.2, 1.8), rot(1.9, 1.8), rot(1.9, 9.0), rot(0.2, 9.0)]
        prism('timber', fr, beam, 3.0, 3.25)
        prism('thatch', fr, sail, 3.05, 3.12)


def backdrop():
    """Rolling hills on every side, dressed with pines, and far ranges. No colliders."""
    M = 8.0

    def height(x, z):
        dx = max(0.0, abs(x) - (HX + M))
        dz = max(0.0, abs(z) - (HZ + M))
        d = math.hypot(dx, dz)
        if d <= 0:
            return 0.0
        k = min(1.0, d / 60.0)
        k = k * k * (3 - 2 * k)
        n = (math.sin(x * 0.05 + 1.1) * math.cos(z * 0.04) + 0.6 * math.sin(x * 0.023 - z * 0.031 + 0.4)
             + 0.35 * math.sin(x * 0.1 + z * 0.08))
        return k * (8.0 + 5.0 * n)

    def lines(edge, reach):
        vs = list(range(-int(reach), -100, 20)) + list(range(-100, 101, 10)) + list(range(120, int(reach) + 1, 20))
        return sorted([v for v in vs if abs(v) > edge + 3] + [-edge, edge])
    xs, zs = lines(HX + 1.5, 260), lines(HZ + 1.5, 280)
    for i in range(len(xs) - 1):
        for j in range(len(zs) - 1):
            x0, x1, z0, z1 = xs[i], xs[i + 1], zs[j], zs[j + 1]
            if max(abs(x0), abs(x1)) <= HX + 1.5 and max(abs(z0), abs(z1)) <= HZ + 1.5:
                continue
            a, b, c, d = height(x0, z1), height(x1, z1), height(x1, z0), height(x0, z0)
            poly('hill', Frame(), [(x0, a, z1), (x1, b, z1), (x1, c, z0)])
            poly('hill', Frame(), [(x0, a, z1), (x1, c, z0), (x0, d, z0)])
    rnd = rnd_gen(41)
    # pines on the hills, none within the flat margin
    placed = 0
    while placed < 110:
        x, z = (rnd() - 0.5) * 300, (rnd() - 0.5) * 340
        if abs(x) < HX + M + 4 and abs(z) < HZ + M + 4:
            continue
        h = 6.0 + rnd() * 5.0
        fr = Frame(x, height(x, z), z)
        vcyl('trunk', fr, 0, 0, 0.35, 0, 2.5, n=6, top=False)
        y = 1.8
        tint = GREENS[int(rnd() * 4)]
        for r in (2.6, 2.1, 1.6, 1.1):
            vcyl('pine', fr, 0, 0, r * h / 8, y, y + h * 0.3, n=6, r1=0.1, tint=tint, top=False)
            y += h * 0.2
        placed += 1
    # a hamlet and a mill on the near hills, a keep on the far one: somewhere the world goes on to
    for i, (hx_, hz_, yw) in enumerate(((78.0, 92.0, 0.3), (92.0, 98.0, -0.4), (84.0, 110.0, 0.9), (100.0, 84.0, 1.2),
                                        (-86.0, -96.0, 0.2), (-98.0, -88.0, 2.1), (-92.0, -108.0, -0.6))):
        house_far(hx_, height(hx_, hz_), hz_, yw, 5.5 + (i % 3), 7.0 + (i % 2) * 2.0)
    windmill(-84.0, height(-84.0, 74.0), 74.0, 0.4)
    windmill(88.0, height(88.0, -70.0), -70.0, 2.6)
    tower_viz(Frame(-120.0, height(-120.0, -40.0), -40.0), 5.0, 18.0, TEAM_CLOTH[-1], seed=9)
    tower_viz(Frame(120.0, height(120.0, 30.0), 30.0), 5.0, 18.0, TEAM_CLOTH[1], seed=10)
    # far ranges
    for ang, dist, w, hgt in ((0.2, 240, 110, 46), (1.3, 255, 130, 38), (2.5, 235, 90, 52), (3.6, 250, 120, 40),
                              (4.5, 240, 100, 48), (5.5, 250, 110, 36)):
        cx, cz = math.cos(ang) * dist, math.sin(ang) * dist
        # a ridge of overlapping peaks rather than one slab: each is a convex trapezoid with a rounded-off top
        for k, (ox, sc, sh) in enumerate(((0.0, 1.0, 1.0), (-0.3, 0.55, 0.72), (0.28, 0.5, 0.82), (-0.12, 0.3, 1.18))):
            mf = Frame(cx + math.cos(ang + math.pi / 2) * ox * w, 0, cz + math.sin(ang + math.pi / 2) * ox * w, ang + math.pi / 2)
            ww, hh = w * sc, hgt * sh
            prism('far', mf, [(-ww / 2, -2), (ww / 2, -2), (ww * 0.18, hh * 0.78), (ww * 0.06, hh), (-ww * 0.1, hh * 0.92),
                              (-ww * 0.2, hh * 0.7)], -4 + k, 4 - k, srgb(0x6f7f8c))


def build_layout():
    ground()
    perimeter()
    causeway()
    for s in (1, -1):
        curtain(s)
        flag_hall(s)
        barracks(s)
        courtyard(s)
        field(s)
    backdrop()
    bastion_detail()
    rk_finalize()


exec(open(os.path.join(REPO, 'scripts', 'blender', 'bastiondetail.py')).read())


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


result = run_round(build_layout)
