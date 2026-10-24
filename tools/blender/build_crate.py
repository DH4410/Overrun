# Builds assets/models/crate/supply-crate.glb. Run:
#   blender --background --python tools/blender/build_crate.py
# Blender is Z-up; the glTF export turns that into Y-up. Front of the crate (-Y here) is +Z in game.
import bpy, bmesh, math, os
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
TEX = os.path.join(ROOT, 'assets', 'textures', 'crate')
OUT = os.path.join(ROOT, 'assets', 'models', 'crate', 'supply-crate.glb')
os.makedirs(os.path.dirname(OUT), exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.fps = 30

def principled(name, color, rough, metal, image=None, emit=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    n = next(x for x in m.node_tree.nodes if x.type == 'BSDF_PRINCIPLED')
    n.inputs['Base Color'].default_value = color
    n.inputs['Roughness'].default_value = rough
    n.inputs['Metallic'].default_value = metal
    if image:
        t = m.node_tree.nodes.new('ShaderNodeTexImage')
        t.image = bpy.data.images.load(os.path.join(TEX, image))
        m.node_tree.links.new(t.outputs['Color'], n.inputs['Base Color'])
    if emit:
        n.inputs['Emission Color'].default_value = emit
        n.inputs['Emission Strength'].default_value = 1.0
    return m

MATS = {
    'hull': principled('hull', (0.035, 0.05, 0.075, 1), 0.5, 0.65),
    'frame': principled('frame', (0.33, 0.37, 0.43, 1), 0.32, 0.95),
    'decal_face': principled('decal_face', (1, 1, 1, 1), 0.52, 0.7, 'panel.jpg'),
    'decal_end': principled('decal_end', (1, 1, 1, 1), 0.52, 0.7, 'end.jpg'),
    'seam': principled('seam', (1, 1, 1, 1), 0.5, 0.0, emit=(1, 1, 1, 1)),
    'rubber': principled('rubber', (0.02, 0.02, 0.02, 1), 0.9, 0.0),
}
ORDER = list(MATS)

class Part:
    """Geometry collected in one bmesh, one material slot per MATS entry."""
    def __init__(self): self.bm = bmesh.new(); self.uv = self.bm.loops.layers.uv.new('UVMap')
    def box(self, c, s, mat, bevel=0.0):
        r = bmesh.ops.create_cube(self.bm, size=1.0)
        v = r['verts']
        bmesh.ops.scale(self.bm, vec=s, verts=v)
        bmesh.ops.translate(self.bm, vec=c, verts=v)
        faces = list({f for vv in v for f in vv.link_faces})
        if bevel:
            e = list({e for f in faces for e in f.edges})
            res = bmesh.ops.bevel(self.bm, geom=e, offset=bevel, segments=2, affect='EDGES')
            faces = [g for g in res['faces']] + faces
            faces = [f for f in faces if f.is_valid]
        for f in faces: f.material_index = ORDER.index(mat)
    def ring(self, c, major, minor, axis, mat, rot=0.0):
        bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=18, minor_segments=6)
        o = bpy.context.active_object
        o.rotation_euler = axis
        o.location = c
        bpy.ops.object.transform_apply(location=True, rotation=True)
        mesh = o.data
        vm = {}
        for v in mesh.vertices: vm[v.index] = self.bm.verts.new(v.co)
        for p in mesh.polygons:
            f = self.bm.faces.new([vm[i] for i in p.vertices]); f.material_index = ORDER.index(mat)
        bpy.data.objects.remove(o); bpy.data.meshes.remove(mesh)
    def quad(self, pts, mat, uv=((0, 0), (1, 0), (1, 1), (0, 1))):
        f = self.bm.faces.new([self.bm.verts.new(p) for p in pts])
        f.material_index = ORDER.index(mat)
        for l, u in zip(f.loops, uv): l[self.uv].uv = u
    def build(self, name):
        me = bpy.data.meshes.new(name)
        self.bm.normal_update()
        self.bm.to_mesh(me); self.bm.free()
        for k in ORDER: me.materials.append(MATS[k])
        for p in me.polygons: p.use_smooth = False
        ob = bpy.data.objects.new(name, me)
        sc.collection.objects.link(ob)
        return ob

# ---------------------------------------------------------------- body
b = Part()
b.box((0, 0, 0.44), (1.46, 1.02, 0.80), 'hull', 0.03)
# stencilled side panels (long faces) and end panels
w, z0, z1 = 0.67, 0.12, 0.79
b.quad([(-w, -0.5275, z0), (w, -0.5275, z0), (w, -0.5275, z1), (-w, -0.5275, z1)], 'decal_face')
b.quad([(w, 0.5275, z0), (-w, 0.5275, z0), (-w, 0.5275, z1), (w, 0.5275, z1)], 'decal_face')
d = 0.45
b.quad([(0.7525, -d, z0), (0.7525, d, z0), (0.7525, d, z1), (0.7525, -d, z1)], 'decal_end')
b.quad([(-0.7525, d, z0), (-0.7525, -d, z0), (-0.7525, -d, z1), (-0.7525, d, z1)], 'decal_end')
# corner castings, feet, skid rails
for sx in (-0.76, 0.76):
    for sy in (-0.53, 0.53):
        b.box((sx, sy, 0.45), (0.1, 0.1, 0.9), 'frame', 0.012)
        b.box((sx, sy, 0.03), (0.15, 0.15, 0.06), 'frame', 0.01)
for sy in (-0.36, 0.36):
    b.box((0, sy, -0.0), (1.32, 0.1, 0.05), 'frame', 0.008)
# rivet rows
for sy in (0.54, -0.54):
    for z in (0.1, 0.79):
        for i in range(17):
            r = bmesh.ops.create_uvsphere(b.bm, u_segments=6, v_segments=4, radius=0.018)
            bmesh.ops.translate(b.bm, vec=(-0.64 + i * 1.28 / 16, sy, z), verts=r['verts'])
            for f in {f for v in r['verts'] for f in v.link_faces}: f.material_index = ORDER.index('frame')
# end handles, vent
for sx, ry in ((1, math.pi / 2), (-1, math.pi / 2)):
    b.ring((sx * 0.775, 0, 0.45), 0.15, 0.022, (0, ry, 0), 'frame')
for i in range(6):
    b.box((0.765, 0, 0.16 + i * 0.026), (0.02, 0.3, 0.012), 'frame')
# status strips on the long faces
for sy in (0.532, -0.532):
    b.box((0, sy * 1.0, 0.075), (1.0, 0.012, 0.016), 'seam')
# gasket and the seam light strip between body and lid
b.box((0, 0, 0.845), (1.50, 1.04, 0.03), 'rubber')
b.box((0, 0, 0.862), (1.46, 1.01, 0.02), 'seam')
body = b.build('body')

# ---------------------------------------------------------------- lid
l = Part()
l.box((0, 0, 0.945), (1.58, 1.13, 0.15), 'frame', 0.035)
l.box((0, 0, 1.03), (1.2, 0.74, 0.03), 'hull', 0.01)
for x in (-0.5, 0.5): l.box((x, 0, 1.04), (0.03, 0.9, 0.02), 'frame')
l.ring((0, 0, 1.05), 0.2, 0.032, (math.pi / 2, 0, 0), 'frame')
for x in (-0.45, 0.45):
    l.box((x, -0.585, 0.86), (0.14, 0.05, 0.2), 'hull', 0.008)
    l.box((x, -0.62, 0.88), (0.04, 0.09, 0.04), 'frame')
lid = l.build('lid')
# lid origin at its centre so it can fly away
bpy.ops.object.select_all(action='DESELECT')
lid.select_set(True); bpy.context.view_layer.objects.active = lid
bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')

crate = bpy.data.objects.new('crate', None)
sc.collection.objects.link(crate)
body.parent = crate; lid.parent = crate

# ---------------------------------------------------------------- animation
def key(ob, frame, **kw):
    for prop, val in kw.items():
        setattr(ob, prop, val)
        ob.keyframe_insert(prop, frame=frame)

def clip(name, fn):
    """fn(crate, lid) keys both objects; then each object's action goes to an NLA track called `name`."""
    for ob in (crate, lid):
        if ob.animation_data: ob.animation_data.action = None
        ob.location = (0, 0, 0) if ob is crate else lid_rest
        ob.rotation_euler = (0, 0, 0); ob.scale = (1, 1, 1)
    fn()
    for ob in (crate, lid):
        ad = ob.animation_data
        if ad and ad.action:
            act = ad.action; act.name = f'{name}_{ob.name}'
            tr = ad.nla_tracks.new(); tr.name = name
            st = tr.strips.new(name, int(act.frame_range[0]), act)
            st.name = name
            ad.action = None
        ob.location = (0, 0, 0) if ob is crate else lid_rest
        ob.rotation_euler = (0, 0, 0); ob.scale = (1, 1, 1)

lid_rest = Vector(lid.location)
