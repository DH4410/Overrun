"""
PORT, generated in Blender.

Run inside Blender 4.2+ (Scripting tab, or through the Blender MCP):

    OVERRUN_REPO = r"C:/path/to/repo"
    exec(open(OVERRUN_REPO + "/scripts/blender/build_port.py").read())

It rebuilds the PORT collection from scratch and writes two files:

    assets/maps/port.glb   visual meshes, one per material, world-scaled UVs, no textures
    assets/maps/port.json  colliders: oriented boxes and ramps, in game coordinates

Every piece function below emits its mesh AND its collider in the same call, so what the
player sees is exactly what they stand on, hide behind and slide along. Floor paint, lamp
heads and the backdrop beyond the perimeter wall are the only geometry with no collider.

Materials are named by key ('asphalt', 'paint', ...). The game swaps each for a Poly Haven PBR
material (src/mapPort.js), so the texture choice lives in one place and the GLB stays small.
UVs are in metres divided by that key's tile size, so one texture tile covers TILE metres.

Coordinates are game metres: +X east, +Y up, +Z south. They are converted to Blender's Z-up
frame once, in Bucket.face(); the glTF exporter's Y-up conversion maps them straight back.
"""
import bpy
import bmesh
import json
import math
import os

REPO = globals().get('OVERRUN_REPO')
assert REPO, 'set OVERRUN_REPO to the repository root before exec()'
OUT_GLB = os.path.join(REPO, 'assets', 'maps', 'port.glb')
OUT_JSON = os.path.join(REPO, 'assets', 'maps', 'port.json')
COLLECTION = 'PORT'

HX, HZ = 50.0, 38.0      # playable half extents
WALL_H = 7.0             # perimeter wall
CEIL_Y = 6.0             # underside of the lowest roof: spawn and nav casts start below it

# key: (preview colour, metres per texture tile)
MATERIALS = {
    'asphalt':  ((0.30, 0.31, 0.32), 4.0),
    'apron':    ((0.56, 0.55, 0.52), 1.5),    # concrete: dock top and ramps
    'wall':     ((0.62, 0.60, 0.56), 3.0),    # perimeter block wall
    'barrier':  ((0.68, 0.66, 0.62), 1.6),
    'cladding': ((0.56, 0.61, 0.65), 3.0),    # shed and warehouse walls
    'roof':     ((0.23, 0.25, 0.27), 4.0),
    'paint':    ((1.00, 1.00, 1.00), 2.0),    # container paint, tinted per piece
    'steel':    ((0.17, 0.18, 0.19), 1.0),
    'yellow':   ((0.86, 0.64, 0.12), 2.0),    # crane, rack uprights, bollards, hazard bands
    'wood':     ((0.62, 0.47, 0.30), 1.2),
    'slab':     ((0.60, 0.59, 0.56), 3.0),    # concrete laid flat on the asphalt: decal
    'lines':    ((0.88, 0.70, 0.18), 1.0),    # floor paint: decal, no collider
    'linesW':   ((0.88, 0.89, 0.86), 1.0),
    'lamp':     ((1.00, 0.95, 0.82), 1.0),    # emissive
    'far':      ((1.00, 1.00, 1.00), 8.0),    # backdrop beyond the wall, tinted per piece
    'water':    ((0.16, 0.24, 0.28), 8.0),
}
TINTED = {'paint', 'far'}

WHITE = (1.0, 1.0, 1.0)


def srgb(hexv, k=1.0):
    """Linear colour from an sRGB hex, optionally darkened by k."""
    out = []
    for sh in (16, 8, 0):
        c = ((hexv >> sh) & 255) / 255.0
        c = c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        out.append(c * k)
    return tuple(out)


CONTAINER_COLOURS = [srgb(h) for h in (
    0x8a3b2c, 0x2e4d6e, 0x3e5f4c, 0xb9b3a5, 0xa2602b, 0x4a4f56, 0x74303a, 0x2c5d66,
    0x6d6a2f, 0x9aa3a8,
)]

BOXES = []    # [cx, cy, cz, hx, hy, hz, yaw, block]
RAMPS = []    # [x0, y0, z0, x1, y1, z1, width]
STATS = {'faces': 0}


class Bucket:
    """One output mesh: every face that shares a material, merged into a single draw call."""

    def __init__(self, key):
        self.key = key
        self.tile = MATERIALS[key][1]
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new('UVMap')
        self.col = self.bm.loops.layers.float_color.new('Col') if key in TINTED else None

    def face(self, pts, uvs, tint):
        # game (x, y, z) -> Blender (x, -z, y)
        vs = [self.bm.verts.new((p[0], -p[2], p[1])) for p in pts]
        f = self.bm.faces.new(vs)
        for loop, (u, v) in zip(f.loops, uvs):
            # glTF export flips V; pre-flipping keeps V pointing up the wall in three.js,
            # whose TextureLoader textures keep flipY = true.
            loop[self.uv].uv = (u / self.tile, -v / self.tile)
            if self.col is not None:
                loop[self.col] = (tint[0], tint[1], tint[2], 1.0)
        STATS['faces'] += 1


BUCKETS = {}


def bucket(key):
    if key not in BUCKETS:
        BUCKETS[key] = Bucket(key)
    return BUCKETS[key]


class Frame:
    """A local frame: origin plus a yaw about +Y (three.js rotation.y convention)."""

    def __init__(self, x=0.0, y=0.0, z=0.0, yaw=0.0):
        self.o = (x, y, z)
        self.c, self.s = math.cos(yaw), math.sin(yaw)
        self.yaw = yaw

    def world(self, p):
        x, y, z = p
        return (self.o[0] + x * self.c + z * self.s, self.o[1] + y, self.o[2] - x * self.s + z * self.c)

    def uvbase(self, p):
        # UVs come from the unrotated position, so a rotated piece keeps its texture square
        # to its own edges, and neighbouring axis-aligned pieces continue each other's texture.
        return (self.o[0] + p[0], self.o[1] + p[1], self.o[2] + p[2])


def newell(pts):
    nx = ny = nz = 0.0
    for i, a in enumerate(pts):
        b = pts[(i + 1) % len(pts)]
        nx += (a[1] - b[1]) * (a[2] + b[2])
        ny += (a[2] - b[2]) * (a[0] + b[0])
        nz += (a[0] - b[0]) * (a[1] + b[1])
    return nx, ny, nz


def poly(key, frame, pts, tint=WHITE):
    """One planar polygon, local points CCW seen from outside. Box-projected UVs."""
    nx, ny, nz = newell(pts)
    ax, ay, az = abs(nx), abs(ny), abs(nz)
    uvs = []
    for p in pts:
        x, y, z = frame.uvbase(p)
        if ay >= ax and ay >= az:
            uvs.append((x, -z) if ny > 0 else (x, z))
        elif ax >= az:
            uvs.append((-z, y) if nx > 0 else (z, y))
        else:
            uvs.append((x, y) if nz > 0 else (-x, y))
    bucket(key).face([frame.world(p) for p in pts], uvs, tint)


BOX_FACES = {
    '+x': ((1, -1, 1), (1, -1, -1), (1, 1, -1), (1, 1, 1)),
    '-x': ((-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)),
    '+z': ((-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)),
    '-z': ((1, -1, -1), (-1, -1, -1), (-1, 1, -1), (1, 1, -1)),
    '+y': ((-1, 1, 1), (1, 1, 1), (1, 1, -1), (-1, 1, -1)),
    '-y': ((-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)),
}


def vbox(key, frame, cx, cy, cz, w, h, d, tint=WHITE, skip=('-y',)):
    """Visual-only box centred at local (cx, cy, cz)."""
    hw, hh, hd = w / 2, h / 2, d / 2
    for name, corners in BOX_FACES.items():
        if name in skip:
            continue
        poly(key, frame, [(cx + sx * hw, cy + sy * hh, cz + sz * hd) for sx, sy, sz in corners], tint)


def collider(frame, cx, cy, cz, w, h, d, block=1):
    x, y, z = frame.world((cx, cy, cz))
    BOXES.append([round(x, 4), round(y, 4), round(z, 4),
                  round(w / 2, 4), round(h / 2, 4), round(d / 2, 4), round(frame.yaw, 5), block])


def solid(key, frame, cx, cy, cz, w, h, d, tint=WHITE, skip=('-y',), block=1):
    vbox(key, frame, cx, cy, cz, w, h, d, tint, skip)
    collider(frame, cx, cy, cz, w, h, d, block)


def prism(key, frame, profile, z0, z1, tint=WHITE, caps=True):
    """Extrude a CCW profile in local XY from z0 to z1."""
    n = len(profile)
    for i in range(n):
        (xa, ya), (xb, yb) = profile[i], profile[(i + 1) % n]
        poly(key, frame, [(xa, ya, z0), (xb, yb, z0), (xb, yb, z1), (xa, ya, z1)], tint)
    if caps:
        poly(key, frame, [(x, y, z1) for x, y in profile], tint)
        poly(key, frame, [(x, y, z0) for x, y in reversed(profile)], tint)


def strip(key, frame, pts, y0, y1, tint=WHITE):
    """A vertical ribbon through local (x, z) points; faces the traversal's right-hand side."""
    for (xa, za), (xb, zb) in zip(pts, pts[1:]):
        poly(key, frame, [(xa, y0, za), (xb, y0, zb), (xb, y1, zb), (xa, y1, za)], tint)


def corrugation(a, b, depth, pitch=0.28):
    """Offsets along a panel from a to b: flat ridge, slope, flat valley, slope."""
    n = max(1, round((b - a) / pitch))
    p = (b - a) / n
    pts = []
    for i in range(n):
        t = a + i * p
        pts += [(t, 0.0), (t + p * 0.26, 0.0), (t + p * 0.5, depth), (t + p * 0.76, depth)]
    pts.append((b, 0.0))
    return pts


def both(emit):
    """Emit a piece in the south half and again turned half a turn into the north half."""
    emit(1)
    emit(-1)


def F(s, x, z, yaw=0.0, y=0.0):
    """A frame at (s*x, y, s*z) whose yaw is turned half a turn for the mirrored copy."""
    return Frame(s * x, y, s * z, yaw + (0.0 if s > 0 else math.pi))


# ------------------------------------------------------------------ pieces

C_L, C_W, C_H = 6.06, 2.44, 2.59
_container_n = [0]


def container(s, x, z, along_x, stacked=False, colour=None):
    """ISO 20 ft container, optionally two high. Corrugated sides, doors at local +X."""
    for level in range(2 if stacked else 1):
        base = level * C_H
        fr = F(s, x, z, 0.0 if along_x else math.pi / 2, base)
        if colour is None:
            tint = CONTAINER_COLOURS[(_container_n[0] * 7) % len(CONTAINER_COLOURS)]
            _container_n[0] += 1
        else:
            tint = colour
        dark = tuple(c * 0.78 for c in tint)
        L, W, H = C_L, C_W, C_H
        collider(fr, 0, H / 2, 0, L, H, W)
        R = 0.16                               # rail and post size
        # posts
        for sx in (-1, 1):
            for sz in (-1, 1):
                vbox('paint', fr, sx * (L / 2 - R / 2), H / 2, sz * (W / 2 - R / 2), R, H, R, dark)
        # long rails, bottom and top
        for sz in (-1, 1):
            vbox('paint', fr, 0, R / 2, sz * (W / 2 - 0.05), L - 2 * R, R, 0.1, dark)
            vbox('paint', fr, 0, H - 0.065, sz * (W / 2 - 0.05), L - 2 * R, 0.13, 0.1, dark)
        # end rails
        for sx in (-1, 1):
            vbox('paint', fr, sx * (L / 2 - 0.05), R / 2, 0, 0.1, R, W - 2 * R, dark)
            vbox('paint', fr, sx * (L / 2 - 0.05), H - 0.1, 0, 0.1, 0.2, W - 2 * R, dark)
        # corrugated long sides
        y0, y1 = R, H - 0.13
        span = corrugation(-L / 2 + R, L / 2 - R, 0.036)
        strip('paint', fr, [(t, W / 2 - dz) for t, dz in span], y0, y1, tint)
        strip('paint', fr, [(-t, -W / 2 + dz) for t, dz in span], y0, y1, tint)
        # blind end (local -X), corrugated across its width
        end = corrugation(-W / 2 + R, W / 2 - R, 0.036, 0.3)
        strip('paint', fr, [(-L / 2 + dz, t) for t, dz in end], y0, H - 0.2, tint)
        # door end (local +X): two leaves, a seam, four locking bars
        xd = L / 2 - 0.02
        poly('paint', fr, [(xd, y0, W / 2 - R), (xd, y0, -W / 2 + R), (xd, H - 0.2, -W / 2 + R),
                           (xd, H - 0.2, W / 2 - R)], tint)
        vbox('steel', fr, xd, H / 2, 0, 0.012, H - 0.4, 0.02, skip=('-y', '+y'))
        for zb in (-0.86, -0.34, 0.34, 0.86):
            vbox('steel', fr, L / 2 - 0.02, H / 2, zb, 0.035, H - 0.3, 0.035, skip=('-y',))
            for yb in (0.55, H - 0.55):
                vbox('steel', fr, L / 2 - 0.03, yb, zb, 0.05, 0.08, 0.09, skip=())
        # roof panel, meeting the rails on all four sides so the top has no gaps
        rx, rz = L / 2 - 0.1, W / 2 - 0.1
        poly('paint', fr, [(-rx, H - 0.02, rz), (rx, H - 0.02, rz), (rx, H - 0.02, -rz), (-rx, H - 0.02, -rz)], tint)


def crate(s, x, z, size=1.4, h=1.0, base=0.0):
    """Wooden crate. 1.0 m tall by default, which a jump clears."""
    fr = F(s, x, z, 0.0, base)
    collider(fr, 0, h / 2, 0, size, h, size)
    b = 0.075                                   # frame board
    frame_tint = WHITE
    hs = size / 2
    # core, inset so the frame stands proud of it
    vbox('wood', fr, 0, h / 2, 0, size - 0.03, h - 0.03, size - 0.03)
    # vertical corner boards
    for sx in (-1, 1):
        for sz in (-1, 1):
            vbox('wood', fr, sx * (hs - b / 2), h / 2, sz * (hs - b / 2), b, h, b, frame_tint)
    # top and bottom rim boards
    for yb in (b / 2, h - b / 2):
        for sz in (-1, 1):
            vbox('wood', fr, 0, yb, sz * (hs - b / 2), size - 2 * b, b, b, frame_tint, skip=())
        for sx in (-1, 1):
            vbox('wood', fr, sx * (hs - b / 2), yb, 0, b, b, size - 2 * b, frame_tint, skip=())
    # a diagonal brace on each side
    run = size - 2 * b
    rise = h - 2 * b
    ang = math.atan2(rise, run)
    t = b * 0.9
    for side in range(4):
        sf = Frame(fr.o[0], fr.o[1], fr.o[2], side * math.pi / 2)
        zf = hs - 0.012
        # board centreline from (-run/2, b) to (run/2, h-b), thickness t across it
        ox, oy = -math.sin(ang) * t / 2, math.cos(ang) * t / 2
        a0 = (-run / 2, b)
        a1 = (run / 2, h - b)
        quad = [(a0[0] - ox, a0[1] - oy), (a1[0] - ox, a1[1] - oy), (a1[0] + ox, a1[1] + oy), (a0[0] + ox, a0[1] + oy)]
        poly('wood', sf, [(u, v, zf) for u, v in quad])


JERSEY = [(-0.3, 0.0), (0.3, 0.0), (0.3, 0.08), (0.12, 0.3), (0.09, 0.85), (-0.09, 0.85), (-0.12, 0.3), (-0.3, 0.08)]


def barrier(s, x, z, along_x, length=3.0):
    """Concrete jersey barrier, 0.85 m: stand to shoot over it, crouch to hide."""
    fr = F(s, x, z, math.pi / 2 if along_x else 0.0)
    prism('barrier', fr, JERSEY, -length / 2, length / 2)
    collider(fr, 0, 0.15, 0, 0.5, 0.3, length)
    collider(fr, 0, 0.575, 0, 0.22, 0.55, length)


def wall(x0, z0, x1, z1, h, t, key, block=1, y=0.0):
    """Axis-aligned wall run from (x0, z0) to (x1, z1)."""
    along_x = abs(x1 - x0) > abs(z1 - z0)
    length = abs(x1 - x0) if along_x else abs(z1 - z0)
    if length < 0.05:
        return
    w, d = (length, t) if along_x else (t, length)
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    solid(key, Frame(), cx, y + h / 2, cz, w, h, d, block=block)
    if key == 'cladding':
        frame_trim(cx, cz, length, h, t, along_x, y)


def frame_trim(cx, cz, length, h, t, along_x, y0=0.0):
    """Steel columns every 6 m and a fascia band along the top, on both faces of a clad wall.
    3 mm proud of the face: they read as the building's frame without adding anything to walk
    into, so the wall's collider stays exactly its box."""
    PROUD, COL, BAND = 0.003, 0.26, 0.4
    n = max(1, round(length / 6.0))
    stations = [-length / 2 + COL / 2] + [-length / 2 + length * i / n for i in range(1, n)] + [length / 2 - COL / 2]
    # the wall's local frame: local +x along the wall, local +z out of one face
    fr = Frame(cx, y0, cz, 0.0 if along_x else math.pi / 2)
    for side in (-1, 1):
        zf = side * (t / 2 + PROUD)

        def face(u0, u1, v0, v1, key):
            quad = [(u0, v0, zf), (u1, v0, zf), (u1, v1, zf), (u0, v1, zf)]
            poly(key, fr, quad if side > 0 else quad[::-1])
        for u in stations:
            face(u - COL / 2, u + COL / 2, 0.0, h - BAND, 'steel')
        face(-length / 2, length / 2, h - BAND, h, 'steel')


def roof(x0, z0, x1, z1, y, t=0.3):
    w, d = abs(x1 - x0), abs(z1 - z0)
    solid('roof', Frame(), (x0 + x1) / 2, y + t / 2, (z0 + z1) / 2, w, t, d, skip=(), block=0)


def flat(key, x0, z0, x1, z1, y):
    """An upward-facing rectangle between two corners."""
    xa, xb = sorted((x0, x1))
    za, zb = sorted((z0, z1))
    poly(key, Frame(), [(xa, y, zb), (xb, y, zb), (xb, y, za), (xa, y, za)])


def stripe(x, z, w, d, key='lines'):
    """Floor paint: 8 mm above the ground, no collider."""
    flat(key, x - w / 2, z - d / 2, x + w / 2, z + d / 2, 0.008)


def ramp(s, x0, y0, z0, x1, y1, z1, width):
    """Solid concrete ramp. Its collider is the game's addRamp (slab plus fill), from RAMPS."""
    x0, z0, x1, z1 = s * x0, s * z0, s * x1, s * z1
    RAMPS.append([round(v, 4) for v in (x0, y0, z0, x1, y1, z1, width)])
    dx, dz = x1 - x0, z1 - z0
    run = math.hypot(dx, dz)
    rise = y1 - y0
    fr = Frame(x0, y0, z0, math.atan2(dx, dz))
    hw = width / 2
    # profile in local (z, y): wedge rising along +z; emit faces directly
    A0, A1 = (-hw, 0, 0), (hw, 0, 0)
    B0, B1 = (-hw, 0, run), (hw, 0, run)
    C0, C1 = (-hw, rise, run), (hw, rise, run)
    poly('apron', fr, [A0, C0, C1, A1])          # walking surface
    poly('apron', fr, [B0, B1, C1, C0])          # high end, against the dock
    poly('apron', fr, [A0, B0, C0])              # sides
    poly('apron', fr, [A1, C1, B1])
    # yellow edge lines along both sides of the slope
    ly = 0.008
    for sx in (-1, 1):
        xa, xb = sx * (hw - 0.05) - 0.05, sx * (hw - 0.05) + 0.05
        poly('lines', fr, [(xa, rise + ly, run), (xb, rise + ly, run), (xb, ly, 0), (xa, ly, 0)])


def lamp_post(s, x, z, yaw=0.0, h=11.0):
    """Floodlight mast. The mast collides; the head is out of reach."""
    fr = F(s, x, z, yaw)
    solid('steel', fr, 0, h / 2, 0, 0.3, h, 0.3)
    vbox('steel', fr, 0, 0.35, 0, 0.6, 0.7, 0.6)          # base plinth (inside the mast's
    collider(fr, 0, 0.35, 0, 0.6, 0.7, 0.6)               # own footprint, plus its collider)
    vbox('steel', fr, 0, h + 0.1, 0.5, 0.2, 0.2, 1.2, skip=())
    for sx in (-0.45, 0.45):
        vbox('steel', fr, sx, h - 0.05, 1.0, 0.7, 0.45, 0.25, skip=())
        poly('lamp', fr, [(sx - 0.3, h - 0.28, 1.13), (sx + 0.3, h - 0.28, 1.13), (sx + 0.3, h + 0.12, 1.13), (sx - 0.3, h + 0.12, 1.13)])


def bollard(s, x, z):
    fr = F(s, x, z)
    solid('yellow', fr, 0, 0.5, 0, 0.22, 1.0, 0.22)


def rack(s, x, z, length, along_z=True, h=3.0, depth=1.1):
    """Pallet racking, fully loaded so it reads as the solid block it collides as."""
    fr = F(s, x, z, 0.0 if along_z else math.pi / 2)
    collider(fr, 0, h / 2, 0, depth, h, length)
    bays = max(1, round(length / 2.7))
    bay = length / bays
    # uprights at every bay line, both faces
    for i in range(bays + 1):
        zc = -length / 2 + i * bay
        zc = max(-length / 2 + 0.05, min(length / 2 - 0.05, zc))
        for sx in (-1, 1):
            vbox('yellow', fr, sx * (depth / 2 - 0.05), h / 2, zc, 0.1, h, 0.1)
    # beams at three levels
    for yb in (0.12, 1.1, 2.1):
        for sx in (-1, 1):
            vbox('steel', fr, sx * (depth / 2 - 0.04), yb, 0, 0.08, 0.12, length - 0.1, skip=())
    # a mesh screen down the middle: the rack is opaque, like the solid block it collides as
    vbox('steel', fr, 0, (h - 0.01) / 2, 0, 0.03, h - 0.01, length - 0.1)
    # loads: a pallet of cartons per bay per level, the top row just under the rack's top
    levels = (0.18, 1.18, 2.18)
    for i in range(bays):
        zc = -length / 2 + (i + 0.5) * bay
        for li, yb in enumerate(levels):
            lh = 0.8 if li < 2 else 0.74
            vbox('wood', fr, 0, yb + 0.06, zc, depth - 0.14, 0.12, bay - 0.2)
            vbox('far', fr, 0, yb + 0.12 + lh / 2, zc, depth - 0.18, lh - 0.1, bay - 0.3,
                 tint=srgb(0xb58f5e) if (i + li) % 3 else srgb(0x9c7a4f))


def shed_light(x, y, z):
    fr = Frame(x, y, z)
    vbox('steel', fr, 0, 0.1, 0, 1.4, 0.12, 0.35, skip=())
    poly('lamp', fr, [(-0.65, 0.035, 0.15), (0.65, 0.035, 0.15), (0.65, 0.035, -0.15), (-0.65, 0.035, -0.15)][::-1])


# ------------------------------------------------------------------ layout

def ground():
    # The playable slab plus a wide apron under the backdrop. One collider for the playable part.
    G = 260.0
    poly('asphalt', Frame(), [(-G, 0, G), (G, 0, G), (G, 0, -G), (-G, 0, -G)])
    # exactly the walled area: no floor outside the wall for a nav sample to land on
    collider(Frame(), 0, -0.5, 0, 2 * HX + 3, 1.0, 2 * HZ + 3, block=0)
    # concrete aprons in front of and under the sheds
    for s in (1, -1):
        flat('slab', -17, s * 23.5, 17, s * HZ, 0.006)


def perimeter():
    t = 1.5
    for sx in (-1, 1):
        wall(sx * (HX + t / 2), -HZ - t, sx * (HX + t / 2), HZ + t, WALL_H, t, 'wall', block=0)
    for sz in (-1, 1):
        wall(-HX - t, sz * (HZ + t / 2), HX + t, sz * (HZ + t / 2), WALL_H, t, 'wall', block=0)
    # coping along the top, dark, flush with the wall faces
    for sx in (-1, 1):
        vbox('steel', Frame(), sx * (HX + t / 2), WALL_H + 0.1, 0, t + 0.1, 0.2, 2 * HZ + 2 * t, skip=())
    for sz in (-1, 1):
        vbox('steel', Frame(), 0, WALL_H + 0.1, sz * (HZ + t / 2), 2 * HX + 2 * t, 0.2, t + 0.1, skip=())


def dock():
    DH = 1.4
    fr = Frame()
    collider(fr, 0, DH / 2, 0, 16, DH, 10, block=0)     # walkable: spawns and pickups may use it
    poly('apron', fr, [(-8, DH, 5), (8, DH, 5), (8, DH, -5), (-8, DH, -5)])
    for name in ('+x', '-x', '+z', '-z'):
        poly('wall', fr, [(sx * 8, DH / 2 + sy * DH / 2, sz * 5) for sx, sy, sz in BOX_FACES[name]])
    # hazard band along the top of each face: alternating yellow and black, 5 mm proud
    seg = 0.4
    for (ax, az, bx, bz, nx, nz) in ((-8, 5, 8, 5, 0, 1), (8, -5, -8, -5, 0, -1), (8, 5, 8, -5, 1, 0), (-8, -5, -8, 5, -1, 0)):
        length = math.hypot(bx - ax, bz - az)
        n = int(round(length / seg))
        for i in range(n):
            t0, t1 = i / n, (i + 1) / n
            key = 'yellow' if i % 2 == 0 else 'steel'
            p0 = (ax + (bx - ax) * t0 + nx * 0.005, az + (bz - az) * t0 + nz * 0.005)
            p1 = (ax + (bx - ax) * t1 + nx * 0.005, az + (bz - az) * t1 + nz * 0.005)
            poly(key, fr, [(p0[0], DH - 0.22, p0[1]), (p1[0], DH - 0.22, p1[1]), (p1[0], DH, p1[1]), (p0[0], DH, p0[1])])

    def per_side(s):
        ramp(s, 4.5, 0, 11.5, 4.5, DH, 5.0, 4.4)
        crate(s, -9.3, 2.0)                                  # step up onto the dock
        # a low steel parapet on the dock, away from the ramp, and crates to fight round
        fr2 = F(s, -3.6, 4.5, 0.0, DH)
        solid('yellow', fr2, 0, 0.5, 0, 8.5, 1.0, 0.5)
        vbox('steel', fr2, 0, 1.0 + 0.01, 0, 8.5, 0.02, 0.5, skip=('-y',))
        crate(s, 5.2, -1.8, 1.4, 1.0, DH)
        crate(s, -1.0, -2.6, 1.2, 1.0, DH)
    both(per_side)


def spawn_sheds():
    def per_side(s):
        z0, z1, SH = 27.0, HZ, 6.0
        t = 0.6

        def w(x0, za, x1, zb):
            wall(s * x0, s * za, s * x1, s * zb, SH, t, 'cladding')
        w(-15, z0, -15, z1)
        w(15, z0, 15, z1)
        w(-15, z0, -11, z0)
        w(-6, z0, 6, z0)
        w(11, z0, 15, z0)
        for cx in (-8.5, 8.5):
            fr = F(s, cx, z0)
            solid('cladding', fr, 0, SH - 0.8, 0, 5.2, 1.6, t, skip=(), block=0)
            # rolled-up shutter drum inside the lintel
            solid('steel', fr, 0, SH - 1.85, 0.55, 5.0, 0.5, 0.5, skip=(), block=0)
        za, zb = sorted((s * (z0 - 0.3), s * z1))
        roof(-15.3, za, 15.3, zb, SH)
        crate(s, -9, 33, 1.6, 1.0)
        crate(s, 9.5, 31.5, 1.6, 1.0)
        stripe(0, s * 29.2, 26, 0.18)
        for lx in (-7, 7):
            shed_light(s * lx, SH - 0.25, s * 32.5)
        # steel columns on the outside corners
        for cx in (-15.35, 15.35):
            solid('steel', Frame(), s * cx, SH / 2, s * (z0 - 0.05), 0.3, SH, 0.3)
    both(per_side)


def approach():
    def per_side(s):
        container(s, -5, 19.5, True)
        container(s, 9, 17.2, False)
        barrier(s, 0.5, 14, True)
        barrier(s, -12.5, 15, False)
        crate(s, 2.4, 22.4)
        crate(s, -1.4, 23.0, 1.2, 1.0)
        crate(s, 13, 23.5, 1.4, 1.0)
        crate(s, 13, 23.5, 1.0, 1.0, 1.0)            # stacked: 2 m, a climb from the one beside it
        crate(s, 14.6, 22.6, 1.2, 1.0)
    both(per_side)


def plaza():
    def per_side(s):
        barrier(s, -13, 6, False)
        barrier(s, 12.5, 9.5, True)
        crate(s, -11.5, -1.5, 1.4, 1.0)
        crate(s, 13.5, 1.0, 1.6, 1.0)
        stripe(0, s * 12.5, 24, 0.18, 'linesW')
        bollard(s, 7.1, 12.0)
        bollard(s, 1.9, 12.0)
    both(per_side)


def container_yard():
    def per_side(s):
        container(s, 22, 6, False)
        container(s, 22, 18.5, False, True)
        container(s, 29.5, 11.5, True)
        container(s, 36, 4.5, False, True)
        container(s, 36.5, 18, False)
        container(s, 44, 10.5, False)
        container(s, 44.5, 24, True, True)
        container(s, 29, 24.5, True)
        container(s, 24, 32.5, True)
        container(s, 40, 32.5, True, True)
        crate(s, 25.5, 14.2)
        crate(s, 40.2, 14.5, 1.4, 1.0)
        crate(s, 32.8, 30.2, 1.4, 1.0)
        stripe(s * 26, s * 0.2, 0.18, 30)
        stripe(s * 33, s * 21.5, 0.18, 12)
        gantry(s)
    both(per_side)


def gantry(s):
    """Rubber-tyred gantry crane straddling the yard. Legs and bogies collide."""
    TOP = 13.0
    for lz in (1.0, 28.5):
        for lx in (32.5, 47.0):
            fr = F(s, lx, lz)
            solid('yellow', fr, 0, TOP / 2, 0, 1.0, TOP, 1.0)
            # bogie: a wheeled sill along Z at the foot of each leg
            solid('yellow', fr, 0, 0.55, 0, 1.3, 0.5, 3.6)
            for wz in (-1.2, 1.2):
                solid('steel', fr, 0, 0.3, wz, 0.9, 0.6, 0.6, skip=())
        # portal beam across the top of each pair of legs (out of reach: visual only)
        vbox('yellow', F(s, 39.75, lz), 0, TOP + 0.6, 0, 15.5, 1.2, 1.2, skip=())
        # diagonal braces up the legs, visual
    girder = F(s, 32.5, 14.75)
    vbox('yellow', girder, 0, TOP + 1.9, 0, 1.4, 1.4, 28.5, skip=())
    vbox('yellow', F(s, 47.0, 14.75), 0, TOP + 1.9, 0, 1.4, 1.4, 28.5, skip=())
    # trolley and cab
    cab = F(s, 39.75, 12.0)
    vbox('yellow', cab, 0, TOP + 2.9, 0, 15.0, 0.6, 3.0, skip=())
    vbox('steel', cab, 3.0, TOP - 0.6, 0, 2.2, 2.2, 2.4, skip=())
    poly('lamp', cab, [(1.89, TOP - 1.2, -1.0), (1.89, TOP - 1.2, 1.0), (1.89, TOP - 0.2, 1.0), (1.89, TOP - 0.2, -1.0)])


def warehouse():
    def per_side(s):
        x0, x1, z0, z1, H, T = -46.0, -20.0, 6.0, 24.0, 6.0, 0.5

        def w(xa, za, xb, zb):
            wall(s * xa, s * za, s * xb, s * zb, H, T, 'cladding')
        w(x0, z0, -36, z0)
        w(-32, z0, x1, z0)
        w(x0, z1, -42, z1)
        w(-38, z1, x1, z1)
        w(x1, z0, x1, 13)
        w(x1, 17, x1, z1)
        w(x0, z0, x0, 10)
        w(x0, 13.5, x0, z1)
        for lx, lz, along_x in ((-34, z0, True), (-40, z1, True), (x1, 15, False), (x0, 11.75, False)):
            wd, dd = (4.2, T) if along_x else (T, 4.2)
            solid('cladding', Frame(), s * lx, H - 0.9, s * lz, wd, 1.8, dd, skip=(), block=0)
        xa, xb = sorted((s * (x0 - 0.25), s * (x1 + 0.25)))
        za, zb = sorted((s * (z0 - 0.25), s * (z1 + 0.25)))
        roof(xa, za, xb, zb, H)
        rack(s, -38, 15, 8.0)
        rack(s, -28, 11.5, 6.0)
        crate(s, -24.5, 20.5, 1.6, 1.0)
        crate(s, -33, 20.0, 1.4, 1.0)
        crate(s, -42.5, 16.5, 1.6, 1.0)
        for lx, lz in ((-39, 11), (-27, 18), (-33, 21.5), (-43, 21)):
            shed_light(s * lx, H - 0.25, s * lz)
    both(per_side)


def back_lot():
    def per_side(s):
        container(s, -27, 31.5, True, True)
        container(s, -40.5, 33, True)
        barrier(s, -21, 29.5, False)
        crate(s, -33.5, 28.0)
        lamp_post(s, -17.5, 24.0, math.pi)
        lamp_post(s, 17.5, 2.0, 0.0)
    both(per_side)


def backdrop():
    """Beyond the wall: container stacks, sheds, ship-to-shore cranes, a quay and the water.
    No colliders; fog softens it. Sized so the tops read over a 7 m wall from mid-map."""
    fr = Frame()
    rng = [7]

    def rnd():
        rng[0] = (rng[0] * 1103515245 + 12345) & 0x7fffffff
        return rng[0] / 0x7fffffff
    # stacked container blocks north and south
    for sz in (-1, 1):
        for row in range(3):
            zc = sz * (HZ + 14 + row * 9)
            for i in range(-9, 10):
                xc = i * 6.6
                hgt = 1 + int(rnd() * 4)
                for level in range(hgt):
                    tint = CONTAINER_COLOURS[int(rnd() * len(CONTAINER_COLOURS))]
                    vbox('far', fr, xc, level * C_H + C_H / 2, zc, 6.06, C_H, 2.44 * 3, tint=tint)
    # warehouses to the west
    for i, (zc, w, d, h) in enumerate(((-40, 40, 26, 16), (0, 40, 30, 19), (38, 40, 24, 15))):
        vbox('far', fr, -HX - 30, h / 2, zc, w, h, d, tint=srgb(0x8d949a))
        vbox('far', fr, -HX - 30, h + 0.4, zc, w + 1, 0.8, d + 1, tint=srgb(0x4a4f55))
    # the quay and the sea to the east
    qx = HX + 22
    flat('slab', HX + 2, -200, qx, 200, 0.02)
    poly('water', fr, [(qx, -1.6, 250), (300, -1.6, 250), (300, -1.6, -250), (qx, -1.6, -250)])
    vbox('far', fr, qx - 0.2, -0.8, 0, 0.4, 1.6, 400, tint=srgb(0x7a766e), skip=())
    # a ship alongside, with a deck load
    hull_x = qx + 16
    vbox('far', fr, hull_x, 5, -10, 30, 13, 190, tint=srgb(0x2b3a4a), skip=('-y',))
    for i in range(-7, 8):
        for j in range(-1, 2):
            hgt = 2 + int(rnd() * 3)
            for level in range(hgt):
                tint = CONTAINER_COLOURS[int(rnd() * len(CONTAINER_COLOURS))]
                vbox('far', fr, hull_x + j * 8.5, 11.5 + level * C_H + C_H / 2, -10 + i * 12, 2.44 * 3, C_H, 6.06 * 1.8, tint=tint)
    vbox('far', fr, hull_x, 22, 78, 26, 20, 16, tint=srgb(0xd8dadc))        # superstructure
    # ship-to-shore cranes on the quay
    for zc in (-50, 5, 60):
        crane = Frame(qx + 4, 0, zc)
        for dz in (-8, 8):
            for dx in (-8, 8):
                vbox('far', crane, dx, 21, dz, 1.6, 42, 1.6, tint=srgb(0xc3462f))
        vbox('far', crane, 0, 43, -8, 18, 2.2, 2.2, tint=srgb(0xc3462f))
        vbox('far', crane, 0, 43, 8, 18, 2.2, 2.2, tint=srgb(0xc3462f))
        vbox('far', crane, 18, 46, 0, 80, 2.6, 5, tint=srgb(0xc3462f))      # boom out over the ship
        vbox('far', crane, -4, 55, 0, 3, 18, 3, tint=srgb(0xc3462f))         # A-frame
        vbox('far', crane, 0, 40, 0, 6, 4, 5, tint=srgb(0xd9d4c8))           # machinery house


def build_layout():
    ground()
    perimeter()
    dock()
    spawn_sheds()
    approach()
    plaza()
    container_yard()
    warehouse()
    back_lot()
    backdrop()


# ------------------------------------------------------------------ Blender plumbing

def reset_collection():
    coll = bpy.data.collections.get(COLLECTION)
    if coll is None:
        coll = bpy.data.collections.new(COLLECTION)
        bpy.context.scene.collection.children.link(coll)
    for ob in list(coll.objects):
        mesh = ob.data
        bpy.data.objects.remove(ob, do_unlink=True)
        if mesh is not None and mesh.users == 0:
            bpy.data.meshes.remove(mesh)
    return coll


def material(key):
    name = key
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    rgb = MATERIALS[key][0]
    bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
    bsdf.inputs['Roughness'].default_value = 0.85
    if key in TINTED:
        attr = nt.nodes.new('ShaderNodeVertexColor')
        attr.layer_name = 'Col'
        nt.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
    if key == 'lamp':
        bsdf.inputs['Emission Color'].default_value = (*rgb, 1.0)
        bsdf.inputs['Emission Strength'].default_value = 4.0
    mat.diffuse_color = (*rgb, 1.0)
    return mat


def build():
    BOXES.clear()
    RAMPS.clear()
    BUCKETS.clear()
    _container_n[0] = 0
    STATS['faces'] = 0
    build_layout()

    coll = reset_collection()
    objs = []
    for key, b in BUCKETS.items():
        mesh = bpy.data.meshes.new('port_' + key)
        b.bm.to_mesh(mesh)
        b.bm.free()
        if b.col is not None and mesh.color_attributes.get('Col'):
            mesh.color_attributes.active_color = mesh.color_attributes['Col']
            mesh.color_attributes.render_color_index = mesh.color_attributes.active_color_index
        mesh.materials.append(material(key))
        ob = bpy.data.objects.new('port_' + key, mesh)
        coll.objects.link(ob)
        objs.append(ob)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)
    return coll, objs, tris


def export(objs):
    os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for ob in objs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB, export_format='GLB', use_selection=True,
        export_yup=True, export_apply=True, export_extras=False,
        export_materials='EXPORT', export_image_format='NONE',
        # Exactly one colour set, by name. 'ACTIVE' also wrote a second, all-white COLOR_0
        # ahead of the real one, and three reads COLOR_0.
        export_vertex_color='NAME', export_vertex_color_name='Col', export_all_vertex_colors=False,
        export_texcoords=True, export_normals=True,
        export_tangents=False, export_cameras=False, export_lights=False,
        export_animations=False, export_skins=False, export_morph=False,
    )
    with open(OUT_JSON, 'w') as f:
        json.dump({
            'version': 1,
            'half': [HX, HZ],
            'ceilY': CEIL_Y,
            'boxes': BOXES,
            'ramps': RAMPS,
        }, f, separators=(',', ':'))


_coll, _objs, _tris = build()
if globals().get('OVERRUN_EXPORT', True):
    export(_objs)
result = {
    'objects': len(_objs), 'tris': _tris, 'faces': STATS['faces'],
    'boxes': len(BOXES), 'ramps': len(RAMPS),
    'glb_kb': round(os.path.getsize(OUT_GLB) / 1024) if os.path.exists(OUT_GLB) else None,
}
