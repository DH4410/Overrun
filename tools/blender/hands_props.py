"""
The props the viewmodel hands hold: the healing items (bandage roll with its wrap, medkit, mini-shield vial,
shield flask) and the reload props (a loose magazine, a shotgun shell) that guns without a magazine mesh of
their own borrow. Each prop is a mesh skinned to its own bone(s) of the rig (hands_rig.PROP_BONES), so a
clip moves it by keying that bone, and hides it by scaling the bone to nothing.

Everything is built from a few primitives with a bevel and vertex colours, in metres, at the size it is held
(a first-person model, not the pickup's). Three materials: `prop` (the vertex colour), `glow` (emissive
liquid) and `glass`.
"""
import math

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

import hands_rig as hr
from hands_mesh import lin

# name: (parent bone, rest head). The pivot of each prop sits at the head, and the prop is modelled around it.
PROP_BONES = {
    'p_roll': ('hand_r', (0.09, 0.50, -0.125)),     # the bandage roll, held in the right hand (so the hand carries it)
    'p_band1': ('forearm_l', (-0.31, 0.415, -0.07)),  # wrap bands round the left forearm, just behind the wrist
    'p_band2': ('forearm_l', (-0.31, 0.38, -0.07)),
    'p_band3': ('forearm_l', (-0.31, 0.345, -0.07)),
    'p_band4': ('forearm_l', (-0.31, 0.31, -0.07)),
    'p_kit': (None, (0.8, 0, 0)),           # medkit case
    'p_lid': ('p_kit', (0.8, 0.0375, 0.024)),   # hinged along the far top edge
    'p_ia': ('p_kit', (0.745, 0.0, 0.034)),     # what lifts out of the case
    'p_ib': ('p_kit', (0.8, 0.0, 0.034)),
    'p_ic': ('p_kit', (0.855, 0.0, 0.034)),
    'p_vial': ('hand_r', (0.08, 0.545, -0.1)),   # held across the fingers, cap toward the thumb (-X)
    'p_vcap': ('p_vial', (0.0325, 0.545, -0.1)),
    'p_vliq': ('p_vial', (0.116, 0.545, -0.1)),
    'p_flask': ('hand_r', (0.124, 0.545, -0.1)),   # by the neck, the ball out past the little finger
    'p_cork': ('p_flask', (0.0605, 0.545, -0.1)),
    'p_fliq': ('p_flask', (0.178, 0.545, -0.1)),
    'p_pmag': (None, (1.4, 0, 0)),          # a loose magazine
    'p_pmag2': (None, (1.5, 0, 0)),         # the one that has just come out
    'p_shell': (None, (1.6, 0, 0)),         # a shotgun shell
}
hr.PROP_BONES.update(PROP_BONES)

C = {
    'case': lin(0x2f4a2f), 'case2': lin(0x233a24), 'cross': lin(0xe8e4dc), 'latch': lin(0xb8b4a8), 'strap': lin(0x1c1c1c),
    'gauze': lin(0xe9e2d0), 'gauze2': lin(0xd2c8b0), 'core': lin(0xb89a66), 'tape': lin(0xefe8d8), 'red': lin(0xc03028),
    'glass': lin(0xb7d4de), 'cap': lin(0x1d6bff), 'cork': lin(0x9a6a3a), 'steel': lin(0xa8acb2), 'dark': lin(0x1b1d20),
    'pmag': lin(0x1f2226), 'brass': lin(0xc9a24a), 'shell': lin(0xb33a2a), 'white': lin(0xdddddd), 'amber': lin(0xd9902b),
    'blue': lin(0x38a6ff), 'liq1': lin(0x35c8ff), 'liq2': lin(0x6ee66e),
}


class Part:
    """A mesh assembled from primitives, each coloured and assigned a vertex group and a material slot."""

    def __init__(self):
        self.bm = bmesh.new()
        self.rec = []                  # (vertex list, colour, group, material index)

    def _add(self, geom, col, grp, mat):
        verts = [g for g in geom if isinstance(g, bmesh.types.BMVert)]
        self.rec.append((verts, col, grp, mat))
        return verts

    def box(self, pos, size, col, grp, mat=0, rot=(0, 0, 0)):
        r = bmesh.ops.create_cube(self.bm, size=1.0)
        v = r['verts']
        m = (Matrix.Translation(Vector(pos)) @ Euler(rot, 'XYZ').to_matrix().to_4x4()
             @ Matrix.Diagonal(Vector((size[0], size[1], size[2], 1))))
        bmesh.ops.transform(self.bm, matrix=m, verts=v)
        self._add(v, col, grp, mat)

    def cyl(self, pos, r0, r1, depth, col, grp, mat=0, axis='Z', segs=16, rot=(0, 0, 0), flat=1.0, caps=True):
        r = bmesh.ops.create_cone(self.bm, cap_ends=caps, cap_tris=False, segments=segs, radius1=r0, radius2=r1, depth=depth)
        v = r['verts']
        base = {'Z': Matrix.Identity(4), 'Y': Matrix.Rotation(math.radians(-90), 4, 'X'), 'X': Matrix.Rotation(math.radians(90), 4, 'Y')}[axis]
        m = Matrix.Translation(Vector(pos)) @ Euler(rot, 'XYZ').to_matrix().to_4x4() @ base @ Matrix.Diagonal(Vector((1, flat, 1, 1)))
        bmesh.ops.transform(self.bm, matrix=m, verts=v)
        self._add(v, col, grp, mat)

    def sph(self, pos, r, col, grp, mat=0, scale=(1, 1, 1), segs=14):
        res = bmesh.ops.create_uvsphere(self.bm, u_segments=segs, v_segments=segs // 2 + 1, radius=r)
        v = res['verts']
        m = Matrix.Translation(Vector(pos)) @ Matrix.Diagonal(Vector((scale[0], scale[1], scale[2], 1)))
        bmesh.ops.transform(self.bm, matrix=m, verts=v)
        self._add(v, col, grp, mat)

    def build(self, name, mats, turn=None):
        """`turn` = (pivot, 3x3 rotation): the whole prop turned about a point, to lie along a hand's axes."""
        me = bpy.data.meshes.new(name)
        if turn:
            m = Matrix.Translation(turn[0]) @ turn[1].to_4x4() @ Matrix.Translation(-turn[0])
            bmesh.ops.transform(self.bm, matrix=m, verts=self.bm.verts)
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        self.bm.to_mesh(me)
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        # colours, groups and materials were recorded against bmesh verts; the mesh keeps their order
        self.bm.verts.ensure_lookup_table()
        idx = {v: v.index for v in self.bm.verts}
        for m in mats:
            me.materials.append(m)
        attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
        groups = {}
        mat_of_vert = {}
        for verts, col, grp, mat in self.rec:
            for v in verts:
                if not v.is_valid:
                    continue
                i = idx[v]
                attr.data[i].color = (col.x, col.y, col.z, 1.0)
                groups.setdefault(grp, []).append(i)
                mat_of_vert[i] = mat
        for g, ids in groups.items():
            vg = ob.vertex_groups.new(name=g)
            vg.add(ids, 1.0, 'REPLACE')
        for p in me.polygons:
            p.material_index = max(mat_of_vert.get(v, 0) for v in p.vertices)
            p.use_smooth = True
        self.bm.free()
        return ob


def prop_materials():
    out = []
    for nm, rough, em, alpha in (('prop', 0.55, 0.0, 1.0), ('glow', 0.25, 2.2, 1.0), ('glass', 0.08, 0.0, 1.0)):
        m = bpy.data.materials.new(nm)
        m.use_nodes = True
        nt = m.node_tree
        b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
        b.inputs['Roughness'].default_value = rough
        if nm == 'glow':
            c = nt.nodes.new('ShaderNodeVertexColor')
            c.layer_name = 'Col'
            nt.links.new(c.outputs['Color'], b.inputs['Emission Color'])
            nt.links.new(c.outputs['Color'], b.inputs['Base Color'])
            b.inputs['Emission Strength'].default_value = em
        else:
            c = nt.nodes.new('ShaderNodeVertexColor')
            c.layer_name = 'Col'
            nt.links.new(c.outputs['Color'], b.inputs['Base Color'])
        if nm == 'glass':
            b.inputs['Metallic'].default_value = 0.1
            b.inputs['Alpha'].default_value = 0.4
            m.surface_render_method = 'BLENDED'
        out.append(m)
    return out


def finish(ob, arm_ob):
    """Round the edges a little, then skin the prop to the rig (it already has a vertex group per bone it uses)."""
    bpy.context.view_layer.objects.active = ob
    for o in bpy.context.view_layer.objects:
        o.select_set(o is ob)
    bv = ob.modifiers.new('Bevel', 'BEVEL')
    bv.width = 0.0016
    bv.segments = 2
    bv.limit_method = 'ANGLE'
    bv.angle_limit = math.radians(35)
    bpy.ops.object.modifier_apply(modifier='Bevel')
    mod = ob.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm_ob
    ob.parent = arm_ob
    return ob


def at(name):
    """Local-to-pivot helper: props are modelled around their bone's pivot, so offset by the bone head."""
    return Vector(PROP_BONES[name][1])


def build_props(arm_ob):
    mats = prop_materials()
    out = {}

    # ---- bandage roll: a core ring, a thick wound band of gauze, a tail of tape; axis along X (across the fingers)
    P = Part()
    o = at('p_roll')
    P.cyl(o, 0.036, 0.036, 0.05, C['gauze'], 'p_roll', axis='X', segs=20)
    P.cyl(o, 0.037, 0.037, 0.0505, C['gauze2'], 'p_roll', axis='X', segs=20, flat=0.97)
    for sgn in (-1, 1):
        P.cyl(o + Vector((sgn * 0.0262, 0, 0)), 0.0375, 0.0375, 0.0035, C['gauze2'], 'p_roll', axis='X', segs=20)
    P.cyl(o, 0.0125, 0.0125, 0.0555, C['core'], 'p_roll', axis='X', segs=12)
    P.cyl(o, 0.0378, 0.0378, 0.012, C['red'], 'p_roll', axis='X', segs=20)     # a printed band round the middle
    P.box(o + Vector((0, -0.03, -0.022)), (0.044, 0.035, 0.003), C['tape'], 'p_roll', rot=(0.5, 0, 0))        # the loose end
    out['prop_roll'] = finish(P.build('prop_roll', mats), arm_ob)

    # ---- wrap bands: short gauze sleeves laid round the forearm one after another
    P = Part()
    for i in range(4):
        n = f'p_band{i + 1}'
        o = at(n)
        P.cyl(o, 0.0495, 0.0495, 0.036, C['gauze'] if i % 2 == 0 else C['gauze2'], n, axis='Y', segs=24, caps=False)
        P.cyl(o, 0.0505, 0.0505, 0.007, C['gauze2'], n, axis='Y', segs=24, caps=False)
    ob = P.build('prop_bands', mats)
    ob.modifiers.new('Solid', 'SOLIDIFY').thickness = 0.0025
    out['prop_bands'] = finish(ob, arm_ob)

    # ---- medkit: green case with a lid on a hinge, steel latch, handle, white cross; tray with three things in it
    P = Part()
    o = at('p_kit')
    P.box(o + Vector((0, 0, -0.012)), (0.19, 0.075, 0.072), C['case'], 'p_kit')
    P.box(o + Vector((0, 0, 0.0245)), (0.178, 0.067, 0.003), C['dark'], 'p_kit')                  # the tray, dark
    P.box(o + Vector((0, 0, -0.049)), (0.2, 0.082, 0.004), C['dark'], 'p_kit')                    # base strip
    for x in (-0.07, 0.07):
        P.box(o + Vector((x, -0.0375, -0.012)), (0.012, 0.004, 0.076), C['strap'], 'p_kit')       # side straps
    P.box(o + Vector((0, -0.0395, 0.018)), (0.024, 0.006, 0.018), C['latch'], 'p_kit')            # the catch
    # the tray: three compartments' contents are separate bones so the left hand can lift them out
    ia, ib, ic = at('p_ia'), at('p_ib'), at('p_ic')
    P.cyl(ia + Vector((0, 0.0, 0)), 0.014, 0.014, 0.05, C['white'], 'p_ia', axis='Y', segs=12)    # a tube / syringe barrel
    P.cyl(ia + Vector((0, 0.0, 0.0)), 0.0145, 0.0145, 0.014, C['red'], 'p_ia', axis='Y', segs=12)
    P.cyl(ia + Vector((0, 0.035, 0.0)), 0.004, 0.004, 0.025, C['steel'], 'p_ia', axis='Y', segs=6)
    P.cyl(ib, 0.017, 0.017, 0.055, C['amber'], 'p_ib', axis='Y', segs=14)                        # a pill bottle
    P.cyl(ib + Vector((0, -0.032, 0)), 0.0165, 0.0165, 0.012, C['white'], 'p_ib', axis='Y', segs=14)
    P.cyl(ic, 0.02, 0.02, 0.04, C['gauze'], 'p_ic', axis='Y', segs=16)                           # a spare bandage roll
    P.cyl(ic, 0.0205, 0.0205, 0.012, C['red'], 'p_ic', axis='Y', segs=16)
    # lid: slab + cross + handle; p_lid's head is the hinge on the far top edge, so the lid reaches back (-Y) from it
    lid = at('p_lid')
    lc = lid + Vector((0, -0.0375, 0.008))
    P.box(lc, (0.19, 0.075, 0.016), C['case'], 'p_lid')
    P.box(lc + Vector((0, 0, 0.0085)), (0.085, 0.024, 0.0025), C['cross'], 'p_lid')
    P.box(lc + Vector((0, 0, 0.0085)), (0.024, 0.062, 0.0025), C['cross'], 'p_lid')
    P.box(lc + Vector((-0.045, 0, 0.016)), (0.014, 0.04, 0.012), C['strap'], 'p_lid')       # handle: two posts and a bar
    P.box(lc + Vector((0.045, 0, 0.016)), (0.014, 0.04, 0.012), C['strap'], 'p_lid')
    P.box(lc + Vector((0, 0, 0.0235)), (0.11, 0.022, 0.008), C['strap'], 'p_lid')
    P.box(lc + Vector((0, -0.0395, -0.002)), (0.026, 0.006, 0.014), C['latch'], 'p_lid')
    out['prop_kit'] = finish(P.build('prop_kit', mats), arm_ob)

    # ---- mini shield: a slim glass vial with a glowing liquid and a screw cap
    P = Part()
    o = at('p_vial')
    P.cyl(o + Vector((0, 0, 0.0)), 0.0125, 0.0125, 0.082, C['glass'], 'p_vial', mat=2, axis='Z', segs=16)
    P.sph(o + Vector((0, 0, -0.041)), 0.0125, C['glass'], 'p_vial', mat=2, scale=(1, 1, 0.8), segs=16)
    P.cyl(o + Vector((0, 0, -0.002)), 0.0105, 0.0105, 0.07, C['liq1'], 'p_vliq', mat=1, axis='Z', segs=14)
    P.cyl(o + Vector((0, 0, 0.0475)), 0.0105, 0.0105, 0.014, C['dark'], 'p_vcap', axis='Z', segs=14)
    P.cyl(o + Vector((0, 0, 0.0575)), 0.0135, 0.0135, 0.008, C['blue'], 'p_vcap', mat=1, axis='Z', segs=14)
    P.cyl(o + Vector((0, 0, 0.0355)), 0.0135, 0.0135, 0.006, C['steel'], 'p_vial', axis='Z', segs=14)    # collar
    out['prop_vial'] = finish(P.build('prop_vial', mats, turn=(o, Matrix.Rotation(math.radians(-90), 3, 'Y'))), arm_ob)

    # ---- shield flask: round body, tapering neck, cork; glowing green-blue liquid
    P = Part()
    o = at('p_flask')
    P.sph(o + Vector((0, 0, -0.018)), 0.036, C['glass'], 'p_flask', mat=2, scale=(1, 1, 0.9), segs=20)
    P.cyl(o + Vector((0, 0, 0.034)), 0.012, 0.0135, 0.052, C['glass'], 'p_flask', mat=2, segs=16)
    P.sph(o + Vector((0, 0, -0.02)), 0.033, C['liq2'], 'p_fliq', mat=1, scale=(1, 1, 0.88), segs=18)
    P.cyl(o + Vector((0, 0, 0.03)), 0.0095, 0.0105, 0.044, C['liq2'], 'p_fliq', mat=1, segs=12)
    P.cyl(o + Vector((0, 0, 0.0565)), 0.0125, 0.0135, 0.005, C['steel'], 'p_flask', segs=16)
    P.cyl(o + Vector((0, 0, 0.0635)), 0.0105, 0.0125, 0.02, C['cork'], 'p_cork', segs=14)
    P.cyl(o + Vector((0, 0, 0.0765)), 0.0125, 0.0105, 0.008, C['cork'], 'p_cork', segs=14)
    P.cyl(o + Vector((0, -0.0245, -0.018)), 0.013, 0.013, 0.003, C['liq1'], 'p_flask', mat=1, axis='Y', segs=16, flat=1.0)    # a badge
    out['prop_flask'] = finish(P.build('prop_flask', mats, turn=(o, Matrix.Rotation(math.radians(-90), 3, 'Y'))), arm_ob)

    # ---- loose magazine (pistol, sniper): polymer box with a curved front, feed lips with rounds; pivot at its centre
    P = Part()
    o = at('p_pmag')
    P.box(o + Vector((0, 0, 0.0)), (0.024, 0.032, 0.09), C['pmag'], 'p_pmag')
    P.box(o + Vector((0, 0, 0.0475)), (0.027, 0.035, 0.007), C['steel'], 'p_pmag')
    P.box(o + Vector((0, 0, -0.0455)), (0.027, 0.035, 0.007), C['dark'], 'p_pmag')
    P.cyl(o + Vector((0, 0.003, 0.055)), 0.0055, 0.0055, 0.01, C['brass'], 'p_pmag', segs=8)
    P.box(o + Vector((0.0125, 0, 0.0)), (0.002, 0.02, 0.06), C['dark'], 'p_pmag')
    out['prop_mag'] = finish(P.build('prop_mag', mats), arm_ob)

    P = Part()
    o = at('p_pmag2')
    P.box(o + Vector((0, 0, 0.0)), (0.024, 0.032, 0.09), C['pmag'], 'p_pmag2')
    P.box(o + Vector((0, 0, 0.0475)), (0.027, 0.035, 0.007), C['steel'], 'p_pmag2')
    P.box(o + Vector((0, 0, -0.0455)), (0.027, 0.035, 0.007), C['dark'], 'p_pmag2')
    P.cyl(o + Vector((0, 0.003, 0.055)), 0.0055, 0.0055, 0.01, C['brass'], 'p_pmag2', segs=8)
    P.box(o + Vector((0.0125, 0, 0.0)), (0.002, 0.02, 0.06), C['dark'], 'p_pmag2')
    out['prop_mag2'] = finish(P.build('prop_mag2', mats), arm_ob)

    # ---- a shell: brass base, coloured hull
    P = Part()
    o = at('p_shell')
    P.cyl(o + Vector((0, 0.012, 0)), 0.0105, 0.0105, 0.05, C['shell'], 'p_shell', axis='Y', segs=12)
    P.cyl(o + Vector((0, -0.017, 0)), 0.011, 0.011, 0.016, C['brass'], 'p_shell', axis='Y', segs=12)
    P.cyl(o + Vector((0, -0.0255, 0)), 0.0085, 0.0085, 0.002, C['steel'], 'p_shell', axis='Y', segs=10)
    out['prop_shell'] = finish(P.build('prop_shell', mats), arm_ob)
    return out
