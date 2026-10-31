# Asset licences

## assets/models/crate/supply-crate.glb
Modelled from scratch in Blender (tools/blender/build_crate.py rebuilds it). Its stencil texture is the
game's own baked assets/textures/crate/panel.jpg and end.jpg. No third-party asset was used.

## assets/textures/guns/ (gun-skin patterns)
Resized to 512 px JPG from ambientCG 1K colour maps, licence CC0 1.0 (https://ambientcg.com/):
- carbon.jpg: Fabric004 (https://ambientcg.com/view?id=Fabric004)
- brushed.jpg: Metal009 (https://ambientcg.com/view?id=Metal009)
- magma.jpg: Lava004 (https://ambientcg.com/view?id=Lava004)
- marble.jpg: Marble012 (https://ambientcg.com/view?id=Marble012)

The other 13 patterns stay procedural (tools/gunTextureDraw.js). Metal063 (rust) and Leather037 were
tried and rejected: the first is grey, the second is a flat brown.

## assets/bots/ (new operators)
Peasant (Peasant Girl), Boss (The Boss), Amy and Jolleen are Mixamo characters (https://www.mixamo.com/),
free to use in games under Adobe's Mixamo terms. FBX with skin, T-pose, converted with scripts/fbx-to-glb.mjs
(max texture 512). Sizes: peasant 1.0 MB, boss 2.8 MB, amy 2.5 MB, jolleen 2.7 MB.

## assets/guns/guns.glb (weapon models)
Built by `tools/blender/build_guns.py` from the "Ultimate Gun Pack" by Quaternius (CC0 1.0,
https://opengameart.org/content/low-poly-guns-pack): pistol, revolver, machine pistol, SMG, assault rifle, LMG,
both shotguns, DMR and sniper rifle are those meshes, rescaled, with the magazines split out and sight, muzzle and
grip points added. The frag grenade is modelled in the same script. Optics are built in `src/gunmodels.js`.
