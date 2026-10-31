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

## First-person arms (assets/player/hands.glb)

Modelled and rigged by the project in Blender (tools/blender/build_hands.py, export_hands.py); no third-party assets. Gun tuning and the hold/reload poses are in src/viewHands.js.

## Sound pack (assets/audio/, optional)

Everything under assets/audio/ is cut and re-encoded from the recordings below by `tools/audio/build_pack.py` (mono 44.1 kHz Ogg
Vorbis for sound effects, trimmed to the sound, faded and peak-normalised; music re-encoded to stereo Ogg Vorbis, otherwise
unchanged). Which recording a game sound comes from is in that script. The game fetches none of it unless the player switches on
"Recorded sound pack" or "Lobby and shop music" in settings. Pages are on https://opengameart.org/content/<name>.

CC0 1.0 (no attribution needed; credited anyway):
- `100-cc0-sfx`: "100 CC0 SFX" (rubberduck). Crate, door, metal, tool, bell and gong sounds.
- `100-cc0-sfx-2`: "100 CC0 SFX #2" (rubberduck). Air, glass, items, metal, stones, footsteps on wood and wet ground.
- `interface-sounds`: "Interface Sounds" (Kenney). Menu clicks, ticks, selects, confirmations, kill and streak chimes.
- `51-ui-sound-effects-buttons-switches-and-clicks`: "51 UI sound effects" (Kenney, packaged by gopherapps). Switches and rollovers.
- `5-hit-sounds-dying`: "5 Hit Sounds + Dying" (TinyWorlds). Hit markers and the death sound.
- `37-hitspunches`: "37 hits/punches" (qubodup / independent.nu ljudbank). Damage grunts and thuds.
- `the-free-firearm-sound-library`: "The Free Firearm Sound Library" (bart). One recording per gun for every gunshot, near and far.
- `gunshot-sounds`: "Gunshot Sounds" (Tabasco). Shotgun, Mosin and SKS shots and the bolt.
- `shotgun-reload-sound-effects`: "Shotgun Reload Sound effects" (zer0_sol). Shells and the pump.
- `gun-reload-sound-effects`: "Gun Reload Sound Effects" (BMacZero). Magazine and single-round sounds.
- `gun-reload-sounds`: "Gun reload sounds" (Joaken / SpringySpringo). Slide, charging handle and shotgun cock.
- `heavenly-loop`: "Heavenly Loop" (isaiah658 / Flixberry Entertainment). Shop music.
- `just-smore-fun`: "Just S'more Fun" (RD). Lobby music.
- `main-menu-music-loop`: "Main Menu Music (Loop)" (Pro Sensory). Lobby music.
- `menu-music-1`: "Menu Music" (wipics), menu_3.ogg. Lobby music.

Creative Commons Attribution 3.0 (credit required; given here):
- `shotgun-shoot-reload`: Mike Koenig, https://soundbible.com/, via qubodup. Dry fire, chambering, magazine out and in, pump, the 10-gauge shot.
- `footsteps-on-different-surfaces` (congusbongus; https://opengameart.org/content/footsteps-on-different-surfaces), each folder derived from
  Freesound recordings: concrete/boots, tile, grass and wood from swuing (freesound.org/people/swuing/sounds/38873, 38874, 38876);
  tile also from ceberation (sounds/235524); metal from Eelke (sounds/462598); water from EminYILDIRIM (sounds/608663) and swuing;
  gravel from Ali_6868 (CC0, freesound.org/people/Ali_6868/packs/21608).
- "Local Forecast - Elevator" by Kevin MacLeod (https://incompetech.com/), Creative Commons Attribution. Shop music. The licence
  version (3.0 or 4.0) was not checked against the site; both require this credit.

No one has listened to the selection end to end: clips were chosen by name, length and spectral content, so some may need swapping.
