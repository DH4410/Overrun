"""
Helpers for build_items.py: low-poly-but-rounded props built with bmesh, exported as small GLBs.

Everything is authored in GAME axes (+X right, +Y up, +Z towards the viewer) and converted to
Blender's Z-up frame once, in Geo.finish(); the glTF exporter's Y-up conversion maps it straight
back, so what you type here is what three.js sees.

A Geo collects primitives (rounded boxes, lathes, sweeps, prisms) into one mesh with one material.
Parts that code animates get their pivot at the joint: finish(pivot=...) moves the object origin
there, which glTF keeps as the node transform.

Shading: faces are smooth, and each corner's normal is the AREA-weighted average of the faces that
meet there within `crease` degrees. Big flat faces stay flat right up to a bevel, bevels read as
round, and hard steps stay hard. (Plain smooth shading smears a gradient across every flat face.)
"""
import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector

# game -> Blender: (x, y, z) -> (x, -z, y)
C_G2B = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def gv(x, y, z):
    """A game-axes point as a Blender vector."""
    return Vector((x, -z, y))


def lin(hexv, k=1.0):
    out = []
    for sh in (16, 8, 0):
        c = ((hexv >> sh) & 255) / 255.0
        c = c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
        out.append(min(1.0, c * k))
    return tuple(out)


MATS = {}


def mat(name, hexv, rough=0.6, metal=0.0, emit=None, emit_k=0.0):
    """A flat Principled material. Emission is a colour and a strength; nothing is textured."""
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (*lin(hexv), 1.0)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if emit is not None and emit_k > 0:
        b.inputs['Emission Color'].default_value = (*lin(emit), 1.0)
        b.inputs['Emission Strength'].default_value = emit_k
    m.diffuse_color = (*lin(hexv), 1.0)
    MATS[name] = m
    return m


def rot_to(axis):
    """Rotation taking +Y (the axis primitives are built along) onto 'x', 'y' or 'z' (game axes)."""
    if axis == 'x':
        return Matrix.Rotation(-math.pi / 2, 4, 'Z')
    if axis == 'z':
        return Matrix.Rotation(math.pi / 2, 4, 'X')
    return Matrix.Identity(4)


def place(pos=(0, 0, 0), rx=0.0, ry=0.0, rz=0.0, s=1.0):
    """Translate * rotate (z, y, x order) * scale, game axes."""
    m = Matrix.Translation(Vector(pos)) @ Matrix.Rotation(rz, 4, 'Z') @ Matrix.Rotation(ry, 4, 'Y') @ Matrix.Rotation(rx, 4, 'X')
    if s != 1.0:
        m = m @ Matrix.Scale(s, 4)
    return m


class Geo:
    def __init__(self):
        self.bm = bmesh.new()

    # ---------------------------------------------------------------- merging

    def _merge(self, t, m):
        if m is not None:
            bmesh.ops.transform(t, matrix=m, verts=t.verts)
        me = bpy.data.meshes.new('tmp')
        t.to_mesh(me)
        t.free()
        self.bm.from_mesh(me)
        bpy.data.meshes.remove(me)

    # ---------------------------------------------------------------- primitives

    def rbox(self, size, r=0.01, seg=2, m=None, edges='all'):
        """Rounded box centred on the origin (then moved by m). size = (x, y, z)."""
        t = bmesh.new()
        bmesh.ops.create_cube(t, size=1.0)
        for v in t.verts:
            v.co.x *= size[0]
            v.co.y *= size[1]
            v.co.z *= size[2]
        if r > 0:
            geo = list(t.edges)
            bmesh.ops.bevel(t, geom=geo, offset=min(r, min(size) * 0.49), offset_type='OFFSET',
                            segments=seg, profile=0.5, affect='EDGES')
        self._merge(t, m)
        return self

    def lathe(self, profile, segs=20, m=None, closed=False):
        """Spin a (radius, y) profile round the Y axis. An open profile that starts and ends on
        the axis makes a closed solid; closed=True joins the last point back to the first."""
        t = bmesh.new()
        vs = [t.verts.new((p[0], p[1], 0.0)) for p in profile]
        es = [t.edges.new((vs[i], vs[i + 1])) for i in range(len(vs) - 1)]
        if closed:
            es.append(t.edges.new((vs[-1], vs[0])))
        bmesh.ops.spin(t, geom=vs + es, cent=(0, 0, 0), axis=(0, 1, 0), dvec=(0, 0, 0),
                       angle=2 * math.pi, steps=segs, use_merge=False, use_duplicate=False)
        bmesh.ops.remove_doubles(t, verts=t.verts, dist=1e-5)
        bmesh.ops.recalc_face_normals(t, faces=t.faces)
        self._merge(t, m)
        return self

    def cyl(self, r, h, segs=20, r2=None, axis='y', pos=(0, 0, 0), bevel=0.0, m=None):
        """A capped cylinder or cone along an axis, centred on pos."""
        t = bmesh.new()
        bmesh.ops.create_cone(t, cap_ends=True, cap_tris=False, segments=segs, radius1=r,
                              radius2=r if r2 is None else r2, depth=h)
        # create_cone builds along Z; turn it to Y
        bmesh.ops.transform(t, matrix=Matrix.Rotation(-math.pi / 2, 4, 'X'), verts=t.verts)
        if bevel > 0:
            ring = set()
            for f in t.faces:
                if len(f.verts) == segs:
                    ring.update(f.edges)
            bmesh.ops.bevel(t, geom=list(ring), offset=bevel, offset_type='OFFSET', segments=2,
                            profile=0.5, affect='EDGES')
        mm = Matrix.Translation(Vector(pos)) @ rot_to(axis)
        self._merge(t, mm if m is None else m @ mm)
        return self

    def sphere(self, r, pos=(0, 0, 0), scale=(1, 1, 1), segs=16, rings=10, m=None):
        t = bmesh.new()
        bmesh.ops.create_uvsphere(t, u_segments=segs, v_segments=rings, radius=r)
        bmesh.ops.transform(t, matrix=Matrix.Rotation(-math.pi / 2, 4, 'X'), verts=t.verts)
        bmesh.ops.transform(t, matrix=Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0)), verts=t.verts)
        self._merge(t, Matrix.Translation(Vector(pos)) if m is None else m @ Matrix.Translation(Vector(pos)))
        return self

    def prism(self, pts, z0, z1, bevel=0.0, m=None):
        """A polygon in XY extruded from z0 to z1. Concave polygons are fine."""
        t = bmesh.new()
        a = [t.verts.new((p[0], p[1], z0)) for p in pts]
        b = [t.verts.new((p[0], p[1], z1)) for p in pts]
        n = len(pts)
        t.faces.new(list(reversed(a)))
        t.faces.new(b)
        for i in range(n):
            j = (i + 1) % n
            t.faces.new((a[i], a[j], b[j], b[i]))
        bmesh.ops.recalc_face_normals(t, faces=t.faces)
        if bevel > 0:
            bmesh.ops.bevel(t, geom=list(t.edges), offset=bevel, offset_type='OFFSET', segments=1,
                            profile=0.5, affect='EDGES')
        self._merge(t, m)
        return self

    def sweep(self, frames, hw, ht, caps=True, m=None):
        """A rectangular section dragged along frames [(pos, right, up), ...]: a strap, a ribbon,
        a handle. hw and ht are half width (along right) and half thickness (along up)."""
        t = bmesh.new()
        rings = []
        for pos, right, up in frames:
            pos, right, up = Vector(pos), Vector(right).normalized(), Vector(up).normalized()
            rings.append([
                t.verts.new(pos - right * hw - up * ht), t.verts.new(pos + right * hw - up * ht),
                t.verts.new(pos + right * hw + up * ht), t.verts.new(pos - right * hw + up * ht),
            ])
        for i in range(len(rings) - 1):
            a, b = rings[i], rings[i + 1]
            for k in range(4):
                t.faces.new((a[k], a[(k + 1) % 4], b[(k + 1) % 4], b[k]))
        if caps:
            t.faces.new(list(reversed(rings[0])))
            t.faces.new(rings[-1])
        bmesh.ops.recalc_face_normals(t, faces=t.faces)
        self._merge(t, m)
        return self

    def merge_geo(self, other, m=None):
        """Fold another Geo (consumed) into this one."""
        t = other.bm
        other.bm = None
        self._merge(t, m)
        return self

    # ---------------------------------------------------------------- output

    def finish(self, name, material, pivot=(0, 0, 0), crease=50.0, coll=None):
        bm = self.bm
        self.bm = None
        # the part's origin goes to its joint
        bmesh.ops.transform(bm, matrix=C_G2B @ Matrix.Translation(-Vector(pivot)), verts=bm.verts)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.normal_update()
        cosc = math.cos(math.radians(crease))
        fn = {f.index: f.normal.copy() for f in bm.faces} if False else None
        bm.faces.ensure_lookup_table()
        bm.verts.ensure_lookup_table()
        fnorm = [f.normal.copy() for f in bm.faces]
        farea = [max(f.calc_area(), 1e-9) for f in bm.faces]
        normals = []
        for f in bm.faces:
            for loop in f.loops:
                n = Vector((0, 0, 0))
                for g in loop.vert.link_faces:
                    if fnorm[g.index].dot(fnorm[f.index]) >= cosc:
                        n += fnorm[g.index] * farea[g.index]
                normals.append(n.normalized() if n.length > 1e-12 else fnorm[f.index])
        for f in bm.faces:
            f.smooth = True
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        try:
            me.normals_split_custom_set(normals)
        except Exception as e:  # keep the mesh, lose the polish
            print('custom normals failed', name, e)
        me.materials.append(material)
        ob = bpy.data.objects.new(name, me)
        ob.location = C_G2B @ Vector(pivot)
        (coll or bpy.context.scene.collection).objects.link(ob)
        return ob


def empty(name, pos, rx=0.0, ry=0.0, rz=0.0, coll=None):
    """An anchor node: glTF keeps it, code reads its position/rotation. Rotation is in game axes."""
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = 'ARROWS'
    ob.empty_display_size = 0.03
    m = C_G2B @ place(pos, rx, ry, rz) @ C_G2B.inverted()
    ob.matrix_world = m
    (coll or bpy.context.scene.collection).objects.link(ob)
    return ob


# ------------------------------------------------------------------ profiles


def arc(cx, cy, r, a0, a1, n=6):
    """Points on a (radius, y) arc, angles in degrees measured from +r towards +y."""
    return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * i / n)),
             cy + r * math.sin(math.radians(a0 + (a1 - a0) * i / n))) for i in range(n + 1)]


def cross_pts(arm, w):
    """A plus sign, `arm` the half length of each bar and `w` the bar width."""
    h = w / 2
    return [(-h, arm), (h, arm), (h, h), (arm, h), (arm, -h), (h, -h), (h, -arm), (-h, -arm),
            (-h, -h), (-arm, -h), (-arm, h), (-h, h)]


def shield_pts(w, h):
    """A heater shield, point down, centred on the origin."""
    hw = w / 2
    pts = [(-hw, h / 2), (hw, h / 2), (hw, h * 0.05)]
    pts += [(hw * math.cos(math.radians(a)) * 0.0 + hw * (1 - (a / 90.0) ** 1.6), h * 0.05 - (h * 0.55) * math.sin(math.radians(a))) for a in (20, 45, 70)]
    pts += [(0, -h / 2)]
    pts += [(-p[0], p[1]) for p in reversed(pts[3:6])]
    pts += [(-hw, h * 0.05)]
    return pts


# ------------------------------------------------------------------ export


def export_glb(path, objs):
    bpy.ops.object.select_all(action='DESELECT')
    for ob in objs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
              export_apply=True, export_extras=False, export_cameras=False, export_lights=False,
              export_animations=False, export_materials='EXPORT', export_normals=True,
              export_texcoords=False, export_tangents=False)
    props = bpy.ops.export_scene.gltf.get_rna_type().properties
    if 'export_vertex_color' in props:
        kw['export_vertex_color'] = 'NONE'
    if 'export_attributes' in props:
        kw['export_attributes'] = False
    bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in props})
    print('WROTE', path, os.path.getsize(path), 'bytes', len(objs), 'nodes')


# ------------------------------------------------------------------ preview


def preview(objs, path, eye, target=(0, 0, 0), res=640, lens=60, bg=0x22262c):
    """Render the given objects (game-axes camera position and target) with Eevee."""
    sc = bpy.context.scene
    keep = {o.name: o.hide_render for o in bpy.data.objects}
    want = set(o.name for o in objs)
    for o in bpy.data.objects:
        if o.type in {'MESH', 'EMPTY'}:
            o.hide_render = (o.name not in want) or o.name.startswith('glass')
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x = sc.render.resolution_y = res
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = 'PNG'
    sc.render.filepath = path
    w = sc.world or bpy.data.worlds.new('w')
    sc.world = w
    w.use_nodes = True
    bgn = next(n for n in w.node_tree.nodes if n.type == 'BACKGROUND')
    bgn.inputs['Color'].default_value = (*lin(bg), 1.0)
    bgn.inputs['Strength'].default_value = 0.55
    cam = bpy.data.objects.get('PrevCam')
    if cam is None:
        cam = bpy.data.objects.new('PrevCam', bpy.data.cameras.new('PrevCam'))
        sc.collection.objects.link(cam)
    cam.data.lens = lens
    cam.location = C_G2B @ Vector(eye)
    d = (C_G2B @ Vector(target)) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    for nm, loc, k in (('KeyL', (1.2, 1.5, 1.6), 600), ('FillL', (-1.4, 0.4, 1.0), 250), ('RimL', (0.2, 1.0, -1.6), 400)):
        L = bpy.data.objects.get(nm)
        if L is None:
            L = bpy.data.objects.new(nm, bpy.data.lights.new(nm, 'POINT'))
            sc.collection.objects.link(L)
        L.data.energy = k
        L.data.color = (1, 0.96, 0.9) if nm != 'RimL' else (0.7, 0.8, 1.0)
        L.location = C_G2B @ Vector(loc)
        L.hide_render = False
    bpy.ops.render.render(write_still=True)
    for o in bpy.data.objects:
        if o.name in keep:
            o.hide_render = keep[o.name]
    print('PREVIEW', path)
