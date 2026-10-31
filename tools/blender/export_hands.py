"""
Exports assets/player/hands.glb: the two skinned gloved arms and their rig, no clips. The game
(src/handRig.js) poses the arms itself: a two-bone solve from shoulder to wrist plus finger curls.

  blender --background --factory-startup --python tools/blender/export_hands.py
"""
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.argv = sys.argv[:1]
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(ROOT, 'assets', 'player', 'hands.glb')

import build_hands as bh  # noqa: E402

bpy.ops.wm.read_factory_settings(use_empty=True)
arm, meshes = bh.build_rig_and_meshes()
for name, ob in list(meshes.items()):
    if name.startswith('prop_'):
        bpy.data.objects.remove(ob)
arm.name = 'Rig'
bpy.ops.object.select_all(action='DESELECT')
for ob in bpy.data.objects:
    ob.select_set(True)
bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_yup=True, export_skins=True,
                          export_animations=False, export_apply=False, export_materials='EXPORT',
                          export_cameras=False, export_lights=False, use_selection=True)
print('EXPORTED', OUT, os.path.getsize(OUT))
