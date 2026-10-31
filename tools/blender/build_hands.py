"""
Builds assets/player/hands.glb: the first-person gloved arms, their rig and every viewmodel clip
(idle grips, draw, holster, reloads, healing), plus the heal props.

  blender --background --factory-startup --python tools/blender/build_hands.py
  blender --background --factory-startup --python tools/blender/build_hands.py -- --preview

`--preview` writes contact sheets of every clip to $HANDS_PREVIEW (default: a `hands-preview` folder
beside the output) instead of exporting. The rig, the keyed controls and the maths that turns them
into arm poses are described in hands_rig.py; the clips are authored in hands_anim.py; the props in
hands_props.py. Blender is Z up with the gun pointing along +Y; the exporter's Y-up conversion turns
that into the game's -Z forward.
"""
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'assets', 'player', 'hands.glb')

import hands_mesh as hm  # noqa: E402
import hands_props as hp  # noqa: E402  (registers the prop bones with the rig)
import hands_rig as hr  # noqa: E402


def fabric_material():
    m = bpy.data.materials.new('fabric')
    m.use_nodes = True
    nt = m.node_tree
    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Roughness'].default_value = 0.86
    b.inputs['Metallic'].default_value = 0.0
    c = nt.nodes.new('ShaderNodeVertexColor')
    c.layer_name = 'Col'
    nt.links.new(c.outputs['Color'], b.inputs['Base Color'])
    return m


def mirror_object(ob):
    me = ob.data
    for v in me.vertices:
        v.co.x = -v.co.x
    me.flip_normals()
    me.update()


def build_arm_meshes(arm_ob, mat):
    """One skinned mesh per hand: glove + sleeve, weighted to the rig."""
    out = {}
    base = hm.build_glove('glove_base', 5200)
    hm.paint_glove(base)
    sleeve_base = hm.build_sleeve('sleeve_base')
    hm.paint_sleeve(sleeve_base)
    for s in ('r', 'l'):
        glove = base.copy()
        glove.data = base.data.copy()
        glove.name = f'glove_{s}'
        bpy.context.scene.collection.objects.link(glove)
        sleeve = sleeve_base.copy()
        sleeve.data = sleeve_base.data.copy()
        sleeve.name = f'sleeve_{s}'
        bpy.context.scene.collection.objects.link(sleeve)
        for o in (glove, sleeve):
            if s == 'l':
                mirror_object(o)
            o.location = hr.WRIST[s]
            o.data.materials.append(mat)
        bpy.context.view_layer.update()
        hr.auto_weights(glove, arm_ob)
        hr.sleeve_weights(sleeve, s)
        mod = sleeve.modifiers.new('Armature', 'ARMATURE')
        mod.object = arm_ob
        sleeve.parent = arm_ob
        # join both into the glove object, which keeps its armature modifier
        for o in bpy.context.view_layer.objects:
            o.select_set(False)
        sleeve.select_set(True)
        glove.select_set(True)
        bpy.context.view_layer.objects.active = glove
        bpy.ops.object.join()
        glove.name = f'arm_{s}'
        glove.data.name = f'arm_{s}'
        hr.limit_weights(glove)
        out[s] = glove
    bpy.data.objects.remove(base)
    bpy.data.objects.remove(sleeve_base)
    return out


def build_rig_and_meshes():
    arm = hr.make_armature('Rig')
    meshes = build_arm_meshes(arm, fabric_material())
    meshes.update(hp.build_props(arm))
    return arm, meshes
