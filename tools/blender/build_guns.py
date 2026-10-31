"""
Build assets/guns/guns.glb: one node per weapon id (`ar`), each with `<id>_body` (+ `<id>_mag` where the
source model has a separate magazine) and empties `<id>_muzzle`, `_sight`, `_grip`, `_support`.

Sources are the CC0 Quaternius "Ultimate Gun Pack" FBX files (see assets/LICENSES.md); the frag
grenade is modelled here. Run:
  blender -b --python tools/blender/build_guns.py -- <FBX folder> <out.glb>

Frame of every node: metres, barrel toward -Z (glTF), up +Y, origin just under the sight line above
the firing grip, so the game's hip/aim placement and the bots' hand targets stay per-gun data.
"""
import bpy, bmesh, sys, os, math
from mathutils import Vector, Matrix

args = sys.argv[sys.argv.index('--') + 1:]
SRC, OUT = args[0], args[1]

# id: (fbx, length m, mag island, grip (along, height), support, sight)
# Fractions run from the rear (along) and the underside (height) of the whole model. Islands are
# the loose parts of the source mesh, in the order the file stores them.
GUNS = {
    'pistol':   ('Pistol_5',         0.205, None, (0.22, 0.42), (0.26, 0.40), (0.55, 0.99)),
    'revolver': ('Revolver_2',       0.26,  None, (0.10, 0.34), (0.12, 0.30), (0.78, 0.97)),
    'mp':       ('SubmachineGun_4',  0.30,  None, (0.46, 0.40), (0.30, 0.40), (0.55, 0.99)),
    'smg':      ('SubmachineGun_2',  0.55,  6,    (0.50, 0.45), (0.78, 0.60), (0.62, 0.94)),
    'ar':       ('AssaultRifle2_2',  0.84,  0,    (0.31, 0.40), (0.66, 0.68), (0.55, 0.96)),
    'lmg':      ('Bullpup_1',        0.80,  35,   (0.36, 0.30), (0.60, 0.40), (0.55, 0.96)),
    'shotgun':  ('Shotgun_2',        1.00,  None, (0.31, 0.50), (0.62, 0.62), (0.90, 0.93)),
    'ashotgun': ('Shotgun_1',        0.92,  None, (0.30, 0.50), (0.60, 0.60), (0.90, 0.93)),
    'sniper':   ('SniperRifle_1',    1.15,  None, (0.30, 0.45), (0.62, 0.62), (0.40, 0.88)),
    'dmr':      ('SniperRifle_4',    1.00,  None, (0.28, 0.45), (0.62, 0.60), (0.38, 0.88)),
}

bpy.ops.wm.read_factory_settings(use_empty=True)
root = bpy.context.scene.collection


def islands(bm):
    seen, out = {}, []
    for v in bm.verts:
        if v.index in seen:
            continue
        stack, vs = [v], [v]
        seen[v.index] = len(out)
        while stack:
            x = stack.pop()
            for e in x.link_edges:
                y = e.other_vert(x)
                if y.index not in seen:
                    seen[y.index] = len(out)
                    stack.append(y)
                    vs.append(y)
        out.append(vs)
    return out


def keep_verts(src_obj, name, keep):
    """A copy of src_obj holding only the vertices whose index is in `keep`."""
    o = src_obj.copy()
    o.data = src_obj.data.copy()
    o.name = name
    root.objects.link(o)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.index not in keep], context='VERTS')
    bm.to_mesh(o.data)
    bm.free()
    return o


def material(name, rgb, rough, metal):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    return m


# Source material name -> stock look. The game repaints by name, so the names matter most.
COLOURS = {
    'Black': ((0.03, 0.03, 0.035), 0.7, 0.1), 'Black2': ((0.03, 0.03, 0.035), 0.7, 0.1),
    'DarkMetal': ((0.06, 0.065, 0.07), 0.45, 0.8), 'Metal': ((0.2, 0.21, 0.23), 0.4, 0.85),
    'LightMetal': ((0.36, 0.37, 0.4), 0.35, 0.9), 'Grey': ((0.22, 0.23, 0.24), 0.6, 0.3),
    'Wood': ((0.28, 0.16, 0.08), 0.6, 0.0), 'DarkWood': ((0.16, 0.09, 0.05), 0.6, 0.0),
    'Green': ((0.17, 0.2, 0.12), 0.8, 0.0), 'Glass': ((0.45, 0.62, 0.75), 0.05, 0.1),
    'Main': ((0.2, 0.21, 0.23), 0.45, 0.7), 'MainDark': ((0.05, 0.055, 0.06), 0.5, 0.6),
    'MainLight': ((0.34, 0.35, 0.37), 0.4, 0.7),
}


def empties(parent, points):
    for n, p in points:
        e = bpy.data.objects.new(parent.name + '_' + n, None)
        e.empty_display_size = 0.01
        e.location = p
        e.parent = parent
        root.objects.link(e)


def build(gid):
    fbx, length, mag_i, grip_f, sup_f, sight_f = GUNS[gid]
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=f'{SRC}/{fbx}.fbx')
    new = set(bpy.data.objects) - before
    src = next(o for o in new if o.type == 'MESH')
    for o in new - {src}:
        bpy.data.objects.remove(o)
    me = src.data
    me.transform(src.matrix_world)
    src.matrix_world = Matrix.Identity(4)
    for slot in me.materials:
        if slot.name in COLOURS:
            material(slot.name, *COLOURS[slot.name])
    # Quaternius: muzzle +X, up +Z. Turn it so the muzzle is +Y (glTF -Z after export).
    me.transform(Matrix.Rotation(math.radians(90), 4, 'Z'))
    co = [v.co.copy() for v in me.vertices]
    x0, x1 = min(c.x for c in co), max(c.x for c in co)
    y0, y1 = min(c.y for c in co), max(c.y for c in co)
    z0, z1 = min(c.z for c in co), max(c.z for c in co)
    k = length / (y1 - y0)
    at = lambda f: Vector(((x0 + x1) / 2, y0 + (y1 - y0) * f[0], z0 + (z1 - z0) * f[1]))
    grip, sup, sight = at(grip_f), at(sup_f), at(sight_f)
    # Origin: on the centre line, along the barrel at the firing grip, a little under the sight line.
    org = Vector(((x0 + x1) / 2, grip.y, sight.z - 0.045 / k))
    me.transform(Matrix.Translation(-org))
    me.transform(Matrix.Scale(k, 4))
    pts = {}
    for n, p in (('grip', grip), ('support', sup), ('sight', sight)):
        q = (p - org) * k
        q.x = 0.0
        pts[n] = q
    front = [c for c in co if c.y > y1 - 0.02 / k]
    mz = Vector((0.0, (y1 - org.y) * k, (sum(c.z for c in front) / len(front) - org.z) * k))
    src.name = gid + '_src'

    parent = bpy.data.objects.new(gid, None)
    root.objects.link(parent)
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    isl = islands(bm)
    mag_idx = {v.index for v in isl[mag_i]} if mag_i is not None else set()
    allv = {v.index for v in bm.verts}
    bm.free()
    body = keep_verts(src, gid + '_body', allv - mag_idx)
    body.parent = parent
    if mag_idx:
        mag = keep_verts(src, gid + '_mag', mag_idx)
        mag.parent = parent
    bpy.data.objects.remove(src)
    empties(parent, [('muzzle', mz), ('sight', pts['sight']), ('grip', pts['grip']), ('support', pts['support'])])
    return parent


def build_frag():
    """A pineapple grenade: each facet of an icosphere inset and sunk, a fuse neck, spoon and pin ring."""
    parent = bpy.data.objects.new('frag', None)
    root.objects.link(parent)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=0.034, location=(0, 0, 0))
    b = bpy.context.active_object
    b.scale = (1, 1, 1.18)
    bpy.ops.object.transform_apply(scale=True)
    bm = bmesh.new()
    bm.from_mesh(b.data)
    bmesh.ops.inset_individual(bm, faces=bm.faces[:], thickness=0.0028, depth=-0.0022)
    bm.to_mesh(b.data)
    bm.free()
    b.data.materials.append(material('olive', (0.16, 0.19, 0.1), 0.55, 0.1))
    steel = material('steel', (0.4, 0.4, 0.42), 0.3, 0.9)
    parts = []
    bpy.ops.mesh.primitive_cylinder_add(vertices=20, radius=0.0125, depth=0.016, location=(0, 0, 0.044))
    parts.append(bpy.context.active_object)
    bpy.ops.mesh.primitive_cylinder_add(vertices=20, radius=0.009, depth=0.012, location=(0, 0, 0.056))
    parts.append(bpy.context.active_object)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0.0345, 0, 0.012))
    sp = bpy.context.active_object
    sp.scale = (0.0035, 0.011, 0.056)
    parts.append(sp)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.011, minor_radius=0.0016, location=(0.017, 0, 0.06),
                                     rotation=(math.radians(90), 0, 0))
    parts.append(bpy.context.active_object)
    for p in parts:
        p.data.materials.append(steel)
    bpy.ops.object.select_all(action='DESELECT')
    for p in parts:
        p.select_set(True)
    b.select_set(True)
    bpy.context.view_layer.objects.active = b
    bpy.ops.object.join()
    b = bpy.context.active_object
    b.name = 'frag_body'
    # Blender Z (fuse up) is the glTF Y after export, so the grenade stands upright as it is.
    b.parent = parent
    empties(parent, [('muzzle', (0, 0.1, 0)), ('sight', (0, 0, 0.03)), ('grip', (0, 0, -0.02)), ('support', (-0.03, 0.01, -0.03))])
    return parent


for g in GUNS:
    build(g)
build_frag()
for o in bpy.data.objects:
    if o.type == 'MESH':
        for poly in o.data.polygons:
            poly.use_smooth = False
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_apply=True, export_yup=True,
                          export_materials='EXPORT', export_cameras=False, export_lights=False)
print('EXPORTED', OUT, os.path.getsize(OUT))
