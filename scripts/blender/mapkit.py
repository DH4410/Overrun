"""
The piece kit behind the Blender maps (build_desert.py, build_snow.py). build_port.py predates
it and carries its own copy of the same ideas.

A map script sets its configuration as globals, execs this file into the same namespace, lays
out its pieces, and calls run():

    MAP = 'desert'                 # assets/maps/<MAP>.glb and .json
    HX, HZ = 42.0, 32.0            # playable half extents
    CEIL_Y = 4.2                   # spawn and nav casts start just below this
    MATERIALS = {key: (preview rgb, metres per texture tile), ...}
    TINTED = {keys with per-vertex colour}
    SMOOTH = {keys welded and smooth shaded}      # optional; terrain, not buildings
    PROPS = {name: (Poly Haven slug, max triangles, collider 'box' | 'cyl' | None, approx (w, h, d))}
    exec(open(REPO + '/scripts/blender/mapkit.py').read())
    ... layout ...
    result = run(build_layout)

Every piece emits its mesh AND its collider in the same call, so what the player sees is what
they stand on, hide behind and slide along.

Coordinates are game metres: +X east, +Y up, +Z south, yaw about +Y as three.js rotation.y.
They are converted to Blender's Z-up frame once, in Bucket.face(); the glTF exporter's Y-up
conversion maps them straight back.

Outside Blender (plain Python) the same layout runs in plan mode: no meshes, just the collider
tables, so a layout can be checked and drawn without opening Blender.
"""
import json
import math
import os

try:
    import bpy
    import bmesh
    from mathutils import Matrix
    IN_BLENDER = True
except ImportError:
    IN_BLENDER = False

REPO = globals().get('OVERRUN_REPO')
assert REPO, 'set OVERRUN_REPO to the repository root before exec()'
OUT_GLB = os.path.join(REPO, 'assets', 'maps', MAP + '.glb')
OUT_JSON = os.path.join(REPO, 'assets', 'maps', MAP + '.json')
COLLECTION = MAP.upper()
# Poly Haven downloads, kept between runs. Outside the repo: the GLB carries what is used.
CACHE = globals().get('OVERRUN_CACHE') or os.path.join(os.path.expanduser('~'), '.cache', 'overrun-polyhaven')
PROP_TEX = 512           # prop textures are resized to this before they are embedded
SMOOTH = globals().get('SMOOTH', set())

WHITE = (1.0, 1.0, 1.0)

BOXES = []       # [cx, cy, cz, hx, hy, hz, yaw, block, prop?]
RAMPS = []       # [x0, y0, z0, x1, y1, z1, width]
CYLINDERS = []   # [x, y, z, r, h, block, prop?]
PLACED = []      # [prop name, x, y, z, yaw, scale]
STATS = {'faces': 0}


def srgb(hexv, k=1.0):
    """Linear colour from an sRGB hex, optionally darkened by k."""
    out = []
    for sh in (16, 8, 0):
        c = ((hexv >> sh) & 255) / 255.0
        c = c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        out.append(c * k)
    return tuple(out)


class Bucket:
    """One output mesh: every face that shares a material, merged into a single draw call."""

    def __init__(self, key):
        self.key = key
        self.tile = MATERIALS[key][1]
        self.bm = bmesh.new() if IN_BLENDER else None
        if self.bm is not None:
            self.uv = self.bm.loops.layers.uv.new('UVMap')
            self.col = self.bm.loops.layers.float_color.new('Col') if key in TINTED else None
        else:
            self.col = None

    def face(self, pts, uvs, tint):
        STATS['faces'] += 1
        if self.bm is None:
            return
        # game (x, y, z) -> Blender (x, -z, y)
        vs = [self.bm.verts.new((p[0], -p[2], p[1])) for p in pts]
        f = self.bm.faces.new(vs)
        for loop, (u, v) in zip(f.loops, uvs):
            # glTF export flips V; pre-flipping keeps V pointing up the wall in three.js,
            # whose TextureLoader textures keep flipY = true.
            loop[self.uv].uv = (u / self.tile, -v / self.tile)
            if self.col is not None:
                loop[self.col] = (tint[0], tint[1], tint[2], 1.0)


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


def collider(frame, cx, cy, cz, w, h, d, block=1, prop=0):
    x, y, z = frame.world((cx, cy, cz))
    row = [round(x, 4), round(y, 4), round(z, 4),
           round(w / 2, 4), round(h / 2, 4), round(d / 2, 4), round(frame.yaw, 5), block]
    if prop:
        row.append(1)
    BOXES.append(row)


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


# ------------------------------------------------------------------ generic pieces

def ring(r, n, phase=0.0):
    """n points on a circle in local (x, z), clockwise seen from above. With phase 0 and n = 12
    these are exactly the vertices of cannon-es' Cylinder: (-r sin t, r cos t), t = 2 pi k / n."""
    return [(-r * math.sin(2 * math.pi * k / n + phase), r * math.cos(2 * math.pi * k / n + phase)) for k in range(n)]


def vcyl(key, frame, cx, cz, r, y0, y1, n=12, tint=WHITE, top=True, r1=None):
    """Visual upright cylinder (or a cone frustum with r1) between heights y0 and y1."""
    r1 = r if r1 is None else r1
    lo, hi = ring(r, n), ring(r1, n)
    for i in range(n):
        j = (i + 1) % n
        # CCW seen from outside, against the ring's clockwise order
        poly(key, frame, [(cx + lo[j][0], y0, cz + lo[j][1]), (cx + lo[i][0], y0, cz + lo[i][1]),
                          (cx + hi[i][0], y1, cz + hi[i][1]), (cx + hi[j][0], y1, cz + hi[j][1])], tint)
    if top and r1 > 0.001:
        poly(key, frame, [(cx + x, y1, cz + z) for x, z in reversed(hi)], tint)


def cyl(key, frame, cx, cz, r, h, y0=0.0, block=1, tint=WHITE, prop=0):
    """Upright cylinder with its collider, a 12-sided cannon Cylinder with the same vertices."""
    vcyl(key, frame, cx, cz, r, y0, y0 + h, 12, tint)
    x, y, z = frame.world((cx, y0 + h / 2, cz))
    row = [round(x, 4), round(y, 4), round(z, 4), round(r, 4), round(h, 4), block]
    if prop:
        row.append(1)
    CYLINDERS.append(row)


def wall(x0, z0, x1, z1, h, t, key, block=1, y=0.0, top_key=None):
    """Axis-aligned wall run from (x0, z0) to (x1, z1). top_key gives the top face its own material."""
    along_x = abs(x1 - x0) > abs(z1 - z0)
    length = abs(x1 - x0) if along_x else abs(z1 - z0)
    if length < 0.05:
        return
    w, d = (length, t) if along_x else (t, length)
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    if top_key:
        vbox(key, Frame(), cx, y + h / 2, cz, w, h, d, skip=('-y', '+y'))
        vbox(top_key, Frame(), cx, y + h / 2, cz, w, h, d, skip=('-y', '+x', '-x', '+z', '-z'))
        collider(Frame(), cx, y + h / 2, cz, w, h, d, block)
    else:
        solid(key, Frame(), cx, y + h / 2, cz, w, h, d, block=block)


def slab(key, x0, z0, x1, z1, y, t=0.3, block=0, skip=()):
    """A horizontal slab between two corners, its top at y + t: a roof or a platform."""
    w, d = abs(x1 - x0), abs(z1 - z0)
    solid(key, Frame(), (x0 + x1) / 2, y + t / 2, (z0 + z1) / 2, w, t, d, skip=skip, block=block)


def flat(key, x0, z0, x1, z1, y):
    """An upward-facing rectangle between two corners."""
    xa, xb = sorted((x0, x1))
    za, zb = sorted((z0, z1))
    poly(key, Frame(), [(xa, y, zb), (xb, y, zb), (xb, y, za), (xa, y, za)])


def ramp(s, x0, y0, z0, x1, y1, z1, width, key, side_key=None):
    """Solid ramp. Its collider is the game's addRamp (slab plus fill), from RAMPS."""
    x0, z0, x1, z1 = s * x0, s * z0, s * x1, s * z1
    RAMPS.append([round(v, 4) for v in (x0, y0, z0, x1, y1, z1, width)])
    dx, dz = x1 - x0, z1 - z0
    run = math.hypot(dx, dz)
    rise = y1 - y0
    fr = Frame(x0, y0, z0, math.atan2(dx, dz))
    hw = width / 2
    side = side_key or key
    A0, A1 = (-hw, 0, 0), (hw, 0, 0)
    B0, B1 = (-hw, 0, run), (hw, 0, run)
    C0, C1 = (-hw, rise, run), (hw, rise, run)
    poly(key, fr, [A0, C0, C1, A1])          # walking surface
    poly(side, fr, [B0, B1, C1, C0])         # high end
    poly(side, fr, [A0, B0, C0])             # sides
    poly(side, fr, [A1, C1, B1])


def crate(s, x, z, size=1.4, h=1.0, base=0.0, key='wood', yaw=0.0):
    """Framed wooden crate. 1.0 m tall by default, which a jump clears."""
    fr = F(s, x, z, yaw, base)
    collider(fr, 0, h / 2, 0, size, h, size)
    b = 0.075
    hs = size / 2
    vbox(key, fr, 0, h / 2, 0, size - 0.03, h - 0.03, size - 0.03)
    for sx in (-1, 1):
        for sz in (-1, 1):
            vbox(key, fr, sx * (hs - b / 2), h / 2, sz * (hs - b / 2), b, h, b)
    for yb in (b / 2, h - b / 2):
        for sz in (-1, 1):
            vbox(key, fr, 0, yb, sz * (hs - b / 2), size - 2 * b, b, b, skip=())
        for sx in (-1, 1):
            vbox(key, fr, sx * (hs - b / 2), yb, 0, b, b, size - 2 * b, skip=())
    run_ = size - 2 * b
    rise = h - 2 * b
    ang = math.atan2(rise, run_)
    t = b * 0.9
    for side in range(4):
        sf = Frame(fr.o[0], fr.o[1], fr.o[2], fr.yaw + side * math.pi / 2)
        zf = hs - 0.012
        ox, oy = -math.sin(ang) * t / 2, math.cos(ang) * t / 2
        a0, a1 = (-run_ / 2, b), (run_ / 2, h - b)
        quad = [(a0[0] - ox, a0[1] - oy), (a1[0] - ox, a1[1] - oy), (a1[0] + ox, a1[1] + oy), (a0[0] + ox, a0[1] + oy)]
        poly(key, sf, [(u, v, zf) for u, v in quad])


# ------------------------------------------------------------------ Poly Haven props

def prop(name, s, x, z, yaw=0.0, y=0.0, scale=1.0):
    """Place a Poly Haven model (see PROPS) at (s*x, y, s*z), turned with the half.

    Its collider comes from the model's own bounds once it is imported, so in plan mode it
    uses the approximate size from PROPS instead."""
    PLACED.append([name, s * x, y, s * z, yaw + (0.0 if s > 0 else math.pi), scale])


def prop_colliders(bounds):
    """Colliders for every placed prop. bounds[name] = (min, max) in game axes at scale 1,
    relative to the model's origin."""
    for name, x, y, z, yaw, scale in PLACED:
        kind = PROPS[name][2]
        if kind is None:
            continue
        (x0, y0, z0), (x1, y1, z1) = bounds[name]
        w, h, d = (x1 - x0) * scale, (y1 - y0) * scale, (z1 - z0) * scale
        cx, cy, cz = (x0 + x1) / 2 * scale, (y0 + y1) / 2 * scale, (z0 + z1) / 2 * scale
        fr = Frame(x, y, z, yaw)
        if kind == 'cyl':
            # A round model: the cylinder that the 12-gon inscribes, from the wider of its sides
            r = max(w, d) / 2
            wx, wy, wz = fr.world((cx, cy, cz))
            CYLINDERS.append([round(wx, 4), round(wy, 4), round(wz, 4), round(r, 4), round(h, 4), 1, 1])
        else:
            collider(fr, cx, cy, cz, w, h, d, block=1, prop=1)


def approx_bounds():
    out = {}
    for name, (_slug, _tris, _kind, (w, h, d)) in PROPS.items():
        out[name] = ((-w / 2, 0.0, -d / 2), (w / 2, h, d / 2))
    return out


def fetch(url, path):
    import urllib.request
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    req = urllib.request.Request(url, headers={'User-Agent': 'overrun-map-build'})
    with urllib.request.urlopen(req, timeout=120) as r, open(path, 'wb') as f:
        f.write(r.read())
    return path


def download_model(slug):
    """The model's 1k glTF and its files, into the cache. Returns the .gltf path."""
    import urllib.request
    base = os.path.join(CACHE, slug)
    info_path = os.path.join(base, 'files.json')
    if not os.path.exists(info_path):
        os.makedirs(base, exist_ok=True)
        req = urllib.request.Request('https://api.polyhaven.com/files/' + slug, headers={'User-Agent': 'overrun-map-build'})
        with urllib.request.urlopen(req, timeout=60) as r:
            open(info_path, 'wb').write(r.read())
    g = json.load(open(info_path, encoding='utf-8'))['gltf']['1k']['gltf']
    gltf = fetch(g['url'], os.path.join(base, g['url'].rsplit('/', 1)[1]))
    for rel, f in g['include'].items():
        fetch(f['url'], os.path.join(base, rel))
    return gltf


def import_prop(name, coll):
    """Import one Poly Haven model, joined into a single mesh object, decimated to its triangle
    budget, its textures shrunk to PROP_TEX. Returns (object, bounds in game axes)."""
    slug, max_tris, _kind, approx = PROPS[name]
    path = download_model(slug)
    before = set(bpy.data.objects)
    before_meshes = set(bpy.data.meshes)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    new_names = [o.name for o in new]
    meshes = [o for o in new if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    # Bake parent transforms into the meshes, then merge them
    bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    if len(meshes) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    # the join removed the other meshes; what is left besides ob is empties from the file
    for n in new_names:
        o = bpy.data.objects.get(n)
        if o is not None and o.name != ob.name:
            bpy.data.objects.remove(o, do_unlink=True)
    # and the joined parts' meshes are orphans now, still holding their materials
    for m in [m for m in bpy.data.meshes if m not in before_meshes]:
        if m.users == 0:
            bpy.data.meshes.remove(m)
    ob.name = 'prop_' + name
    ob.data.name = 'prop_' + name
    # A few Poly Haven glTFs are in the wrong unit: steel_frame_shelves_01 is in decimetres, 21 m
    # tall where the site lists 2.14 m. PROPS has the listed size, so a model off it by a power
    # of ten is rescaled by exactly that power; anything closer is a real size and left alone.
    zs = [v.co.z for v in ob.data.vertices]
    k = approx[1] / max(1e-6, max(zs) - min(zs))
    if abs(math.log10(k)) > 0.5:
        ob.data.transform(Matrix.Scale(10 ** round(math.log10(k)), 4))
    tris =sum(len(p.vertices) - 2 for p in ob.data.polygons)
    if tris > max_tris:
        mod = ob.modifiers.new('decimate', 'DECIMATE')
        mod.ratio = max_tris / tris
        bpy.ops.object.modifier_apply(modifier=mod.name)
    for slot in ob.material_slots:
        mat = slot.material
        if mat is None or not mat.use_nodes:
            continue
        mat.name = 'ph_' + name + '_' + mat.name        # never one of the map's material keys
        for node in mat.node_tree.nodes:
            img = getattr(node, 'image', None)
            if img is not None and max(img.size) > PROP_TEX:
                img.scale(PROP_TEX, PROP_TEX)
    for c in ob.users_collection:
        c.objects.unlink(ob)
    coll.objects.link(ob)
    # Bounds in game axes: Blender (x, y, z) -> game (x, z, -y)
    xs = [v.co.x for v in ob.data.vertices]
    ys = [v.co.z for v in ob.data.vertices]
    zs = [-v.co.y for v in ob.data.vertices]
    return ob, ((min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs)))


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
    for mat in list(bpy.data.materials):
        if mat.name.startswith('ph_') and mat.users == 0:
            bpy.data.materials.remove(mat)
    for img in list(bpy.data.images):
        if img.users == 0:
            bpy.data.images.remove(img)
    return coll


def material(key):
    mat = bpy.data.materials.get(key)
    if mat is None:
        mat = bpy.data.materials.new(key)
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
    mat.diffuse_color = (*rgb, 1.0)
    return mat


def reset_tables():
    BOXES.clear()
    RAMPS.clear()
    CYLINDERS.clear()
    PLACED.clear()
    BUCKETS.clear()
    STATS['faces'] = 0


def build(layout):
    reset_tables()
    layout()
    if not IN_BLENDER:
        prop_colliders(approx_bounds())
        return None, [], 0
    coll = reset_collection()
    objs = []
    for key, b in BUCKETS.items():
        mesh = bpy.data.meshes.new(MAP + '_' + key)
        if key in SMOOTH:
            # shared corners and shared normals: rolling ground instead of facets, at a
            # fraction of the vertices (every face otherwise carries its own)
            bmesh.ops.remove_doubles(b.bm, verts=b.bm.verts[:], dist=1e-4)
            for f in b.bm.faces:
                f.smooth = True
        b.bm.to_mesh(mesh)
        b.bm.free()
        if b.col is not None and mesh.color_attributes.get('Col'):
            mesh.color_attributes.active_color = mesh.color_attributes['Col']
            mesh.color_attributes.render_color_index = mesh.color_attributes.active_color_index
        mesh.materials.append(material(key))
        ob = bpy.data.objects.new(MAP + '_' + key, mesh)
        coll.objects.link(ob)
        objs.append(ob)
    # Props: one imported source per model, placed as linked duplicates, so the GLB stores each
    # model's mesh once however many times it is used.
    bounds = {}
    sources = {}
    for name in sorted({p[0] for p in PLACED}):
        sources[name], bounds[name] = import_prop(name, coll)
    for i, (name, x, y, z, yaw, scale) in enumerate(PLACED):
        src = sources[name]
        ob = bpy.data.objects.new('%s_%s_%d' % (MAP, name, i), src.data)
        ob.location = (x, -z, y)
        ob.rotation_euler = (0.0, 0.0, yaw)
        ob.scale = (scale, scale, scale)
        coll.objects.link(ob)
        objs.append(ob)
    # The sources stay in the collection, hidden and not exported, so the next run clears them.
    for src in sources.values():
        src.hide_set(True)
        src.hide_render = True
    prop_colliders(bounds)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)
    return coll, objs, tris


def export(objs):
    os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
    # Not select_all: it leaves hidden objects selected, and use_selection would export them,
    # which is how another map's build got into this one's GLB.
    for ob in bpy.context.view_layer.objects:
        ob.select_set(False)
    for ob in objs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB, export_format='GLB', use_selection=True,
        export_yup=True, export_apply=True, export_extras=False,
        # The kit's own materials carry no images (the game swaps in Poly Haven textures by
        # material name); the props' textures are embedded, already shrunk to PROP_TEX.
        export_materials='EXPORT', export_image_format='JPEG',
        # Exactly one colour set, by name. 'ACTIVE' also wrote a second, all-white COLOR_0
        # ahead of the real one, and three reads COLOR_0.
        export_vertex_color='NAME', export_vertex_color_name='Col', export_all_vertex_colors=False,
        export_texcoords=True, export_normals=True,
        export_tangents=False, export_cameras=False, export_lights=False,
        export_animations=False, export_skins=False, export_morph=False,
    )
    write_json()


def write_json():
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, 'w') as f:
        json.dump({
            'version': 1,
            'half': [HX, HZ],
            'ceilY': CEIL_Y,
            'boxes': BOXES,
            'ramps': RAMPS,
            'cylinders': CYLINDERS,
        }, f, separators=(',', ':'))


def run(layout):
    _coll, objs, tris = build(layout)
    if IN_BLENDER and globals().get('OVERRUN_EXPORT', True):
        export(objs)
    return {
        'objects': len(objs), 'tris': tris, 'faces': STATS['faces'],
        'boxes': len(BOXES), 'ramps': len(RAMPS), 'cylinders': len(CYLINDERS), 'props': len(PLACED),
        'glb_kb': round(os.path.getsize(OUT_GLB) / 1024) if IN_BLENDER and os.path.exists(OUT_GLB) else None,
    }
