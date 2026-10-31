"""
Builds the optional sound pack: assets/audio/sfx/*.ogg, assets/audio/music/*.ogg and manifest.json.

  python tools/audio/build_pack.py <source folder>

The source folder is the downloaded, extracted packs (see assets/LICENSES.md for where each one comes
from); the layout it expects is the SRC table below. Every clip is cut from a real recording: a gun
shot is the first shot in the recording, a footstep is one step, and so on. Clips are mono, 44.1 kHz,
normalised to the same peak and written as Ogg Vorbis. Nothing here is synthesised.

The game only fetches the manifest, and then the clips, when the Sound pack setting is on.
"""
import json
import os
import sys

import numpy as np
import soundfile as sf
from scipy.signal import butter, resample_poly, sosfilt

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'assets', 'audio')
SR = 44100
SRCROOT = sys.argv[1] if len(sys.argv) > 1 else '.'

FIRE = 'x/FIRE/Prepared SFX Library'
C100 = 'x/A_100-CC0-SFX_0'
S100 = 'x/A_sfx_100_v2'
KEN = 'x/B_kenney_if/Audio'
UI = 'x/B_ui_sfx'
FOOT = 'x/A_footsteps_0/footsteps'
HIT5 = 'x/A_5Hit_Sounds/ogg'
HITS = 'x/HITS/hits'
KOE = 'x/KOENIG/mike_koenig-shotgun'
SG = 'x/A_shotgunsounds/ShotgunSounds'
SND = 'x/A_sounds/sounds'
DL = 'dl'
DL2 = 'dl2'
SHOTS = 'x2/shots/shots'


def load(rel):
    p = os.path.join(SRCROOT, rel)
    x, sr = sf.read(p, always_2d=True, dtype='float32')
    x = x.mean(1)
    if sr != SR:
        g = np.gcd(sr, SR)
        x = resample_poly(x, SR // g, sr // g).astype('float32')
    return x


def env(x, win=0.005):
    n = int(SR * win)
    m = len(x) // n
    return np.abs(x[:m * n]).reshape(m, n).max(1)


def events(x, gap=0.08, th=0.12):
    """Split a recording into its separate sounds: (start, end, peak, centroid Hz) for each, in order."""
    n = int(SR * 0.005)
    m = len(x) // n
    e = np.abs(x[:m * n]).reshape(m, n).max(1)
    on = e > th * e.max()
    out, i = [], 0
    while i < m:
        if not on[i]:
            i += 1
            continue
        j = last = i
        while j < m and (j - last) * 0.005 < gap:
            if on[j]:
                last = j
            j += 1
        seg = x[i * n:(last + 9) * n]
        sp = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
        fr = np.fft.rfftfreq(len(seg), 1 / SR)
        out.append((i * 0.005, (last + 1) * 0.005, float(e[i:last + 1].max()), float((sp * fr).sum() / (sp.sum() + 1e-9))))
        i = last + 1
    return out


def process(x, seg=None, shot=None, maxlen=None, fade=0.04, skip=0.0, ev=None, rate=None, lp=None, hp=None, raw=False, tail=0.12, level=0.9):
    """seg=(a, b) seconds; ev=k: the k-th separate sound in the recording; shot=length: start at the first loud
    onset; maxlen caps the length; rate resamples (pitch and speed); lp/hp filter; raw leaves a loop untouched."""
    if ev is not None:
        a, b, _, _ = events(x)[ev]
        seg = (max(0, a - 0.01), b + tail)
    if seg:
        x = x[int(seg[0] * SR):int(seg[1] * SR)]
    if raw:
        return (x * (level / (np.abs(x).max() + 1e-9))).astype('float32')
    if skip:
        x = x[int(skip * SR):]
    pk = np.abs(x).max() + 1e-9
    if shot:
        look = np.abs(x[:int(SR * 4)])
        i = int(np.argmax(look > 0.25 * look.max()))
        x = x[max(0, i - int(0.004 * SR)):]
        x = x[:int(shot * SR)]
    else:
        i = int(np.argmax(np.abs(x) > 0.02 * pk))
        x = x[max(0, i - int(0.003 * SR)):]
    if maxlen:
        x = x[:int(maxlen * SR)]
    if rate and abs(rate - 1) > 1e-3:
        x = resample_poly(x, int(round(100 / rate)), 100).astype('float32')
    if lp:
        x = sosfilt(butter(2, lp, 'low', fs=SR, output='sos'), x).astype('float32')
    if hp:
        x = sosfilt(butter(2, hp, 'high', fs=SR, output='sos'), x).astype('float32')
    # trim a silent tail
    e = env(x)
    nz = np.nonzero(e > 0.01 * (e.max() + 1e-9))[0]
    if len(nz):
        x = x[:int((nz[-1] + 2) * 0.005 * SR)]
    f = min(int(fade * SR), len(x) // 3)
    if f:
        x = x.copy()
        x[-f:] *= np.linspace(1, 0, f) ** 1.5
    x = x * (level / (np.abs(x).max() + 1e-9))
    return x.astype('float32')


def write(path, x, stereo=None, quality=0.5):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # libsndfile's Vorbis encoder overflows its stack on one long write, so feed it a second at a time
    with sf.SoundFile(path, 'w', samplerate=SR, channels=1 if x.ndim == 1 else x.shape[1], format='OGG', subtype='VORBIS', compression_level=quality) as f:
        for i in range(0, len(x), SR):
            f.write(x[i:i + SR])


# name -> list of (source, options). Options are those of process(); 'g' is a per-clip volume hint.
S = {}


def add(name, *specs):
    S.setdefault(name, []).extend(specs)


def shots():
    # (id, [near files], far file, length)
    table = [
        ('pistol', ['Walther PPQ/X_39P.wav', '1911/A_42P.wav'], 'Walther PPQ/X_31P.wav', 1.0),
        ('revolver', ['Smith & Wesson 642/V_27P.wav', 'Ruger Single Six/S_14P.wav'], 'Smith & Wesson 642/V_22P.wav', 1.1),
        ('mp', ['Bersa/F_47P.wav', 'Ruger Mark III/R_35P.wav'], 'Bersa/F_41P.wav', 0.8),
        ('smg', ['PPSh/P_30P.wav', 'Carl Gustav M45/G_31P.wav'], 'PPSh/P_16P.wav', 0.8),
        ('ar', ['AR-15/D_32P.wav'], 'AR-15/D_24P.wav', 1.3),
        ('lmg', ['AK-47/C_28P.wav'], 'AK-47/C_31P.wav', 1.4),
        ('shotgun', ['Nova/O_21P.wav', 'CD/H_21P.wav'], 'Nova/O_17P.wav', 1.6),
        ('ashotgun', ['Model 12/K_22P.wav', 'Mossberg/N_30P.wav'], 'Model 12/K_17P.wav', 1.5),
        ('sniper', ['Tikka/W_29P.wav', 'Mosin Nagant/M_21P.wav'], 'Tikka/W_24P.wav', 2.0),
        ('dmr', ['SKS/U_14P.wav', 'Marlin 336/I_22P.wav'], 'SKS/U_19P.wav', 1.4),
    ]
    for gid, near, far, ln in table:
        for f in near:
            add(f'gun_{gid}', (f'{FIRE}/{f}', dict(shot=ln)))
        add(f'gunfar_{gid}', (f'{FIRE}/{far}', dict(shot=ln + 0.4)))


shots()
add('gun_shotgun', (f'{SND}/shotty.wav', dict(shot=0.7)))
add('gun_sniper', (f'{SND}/mosin.wav', dict(seg=(0.3, 2.0), shot=1.5)))
add('gun_dmr', (f'{SND}/sks.wav', dict(seg=(0.2, 2.0), shot=1.2)))
add('gun_ashotgun', (f'{KOE}/10 Guage Shotgun-SoundBible.com-74120584.wav', dict(shot=1.2)))
add('gun_revolver', (f'{KOE}/Shotgun-SoundBible.com-862990674.wav', dict(shot=0.1, maxlen=0.1)))  # placeholder removed below
del S['gun_revolver'][-1]

# gun handling
add('empty', (f'{KOE}/Dry Fire Gun-SoundBible.com-2053652037.wav', dict(maxlen=0.4)), (f'{C100}/switch_01.ogg', {}), (f'{S100}/sfx100v2_switch_02.ogg', {}))
add('foley_magOut', (f'{KOE}/Ejecting Magazine-SoundBible.com-1801520333.wav', dict(maxlen=0.6)), (f'{DL}/clipload2.wav', {}))
add('foley_magIn', (f'{KOE}/Pop Clip In-SoundBible.com-583746573.wav', dict(maxlen=0.7)), (f'{DL}/clipload1.wav', {}), (f'{DL}/clipload2.wav', {}))
add('foley_charge', (f'{KOE}/Chambering A Round-SoundBible.com-854171848.wav', dict(maxlen=0.8)), (f'{DL}/shotguncock_0.wav', {}))
add('foley_slide', (f'{DL}/gunreload1.wav', dict(seg=(1.1, 1.58), maxlen=0.4)), (f'{DL}/assaultriflereload1_0.wav', dict(seg=(0.9, 1.56), maxlen=0.4)))
add('foley_shell', (f'{DL}/singlebullet1.wav', {}), (f'{SG}/Subsequent Shells.mp3', dict(seg=(0.6, 1.4))), (f'{SG}/First Shell.mp3', dict(seg=(0.3, 1.1))))
add('foley_pump', (f'{KOE}/Pump Shotgun-SoundBible.com-1653268682.wav', dict(maxlen=1.0)), (f'{SG}/Rack.mp3', dict(seg=(0.5, 1.1))), (f'{DL}/shotguncock_0.wav', {}))
add('foley_boltUp', (f'{SND}/mosin.wav', dict(seg=(1.85, 2.7), maxlen=0.7)), (f'{C100}/metal_03.ogg', {}))
add('foley_boltDown', (f'{SND}/mosin.wav', dict(seg=(2.8, 3.6), maxlen=0.7)), (f'{C100}/metal_02.ogg', {}))
add('equip', (f'{S100}/sfx100v2_metal_02.ogg', dict(maxlen=0.3)), (f'{S100}/sfx100v2_metal_03.ogg', dict(maxlen=0.3)), (f'{C100}/tools_02.ogg', dict(maxlen=0.4)))
add('lowammo', (f'{KEN}/tick_001.ogg', {}), (f'{KEN}/tick_002.ogg', {}))
add('reloadclick', (f'{KEN}/click_003.ogg', {}), (f'{KEN}/click_004.ogg', {}))

# footsteps on the surfaces the maps are made of
for surf, d, n in [('concrete', 'boots', 5), ('tile', 'tile', 4), ('metal', 'metal', 4), ('grass', 'grass', 4),
                   ('gravel', 'gravel', 5), ('wood', 'wood', 4), ('water', 'water', 4)]:
    for i in range(n):
        add(f'step_{surf}', (f'{FOOT}/{d}/{i}.ogg', dict(maxlen=0.4, fade=0.05)))
add('step_wood', (f'{S100}/sfx100v2_footstep_wood_02.ogg', dict(maxlen=0.3)), (f'{S100}/sfx100v2_footstep_wood_04.ogg', dict(maxlen=0.35)))
add('step_water', (f'{S100}/sfx100v2_footstep_wet_01.ogg', {}), (f'{S100}/sfx100v2_footstep_wet_02.ogg', {}), (f'{S100}/sfx100v2_footstep_wet_03.ogg', {}))
add('step_concrete', (f'{S100}/sfx100v2_footstep_01.ogg', dict(maxlen=0.35)), (f'{S100}/sfx100v2_footstep_02.ogg', dict(maxlen=0.35)))
add('step_sand', (f'{FOOT}/gravel/1.ogg', dict(maxlen=0.2)), (f'{FOOT}/grass/2.ogg', dict(maxlen=0.25)), (f'{S100}/sfx100v2_stones_01.ogg', dict(maxlen=0.4)), (f'{S100}/sfx100v2_stones_02.ogg', dict(maxlen=0.4)))
add('step_snow', (f'{FOOT}/grass/0.ogg', dict(maxlen=0.25)), (f'{FOOT}/grass/1.ogg', dict(maxlen=0.25)), (f'{FOOT}/grass/3.ogg', dict(maxlen=0.25)))
add('land', (f'{C100}/slam_04.ogg', dict(maxlen=0.3)), (f'{C100}/slam_06.ogg', dict(maxlen=0.35)), (f'{S100}/sfx100v2_wood_hit_01.ogg', dict(maxlen=0.3)))
add('jump', (f'{S100}/sfx100v2_air_03.ogg', {}), (f'{C100}/paper_01.ogg', dict(maxlen=0.2)))
add('slide', (f'{S100}/sfx100v2_air_02.ogg', dict(maxlen=0.7)), (f'{FOOT}/gravel/2.ogg', {}))

# being hit, hitting, killing
add('hit', *[(f'{HIT5}/hit{i}.ogg', dict(maxlen=0.25)) for i in range(1, 6)])
add('headshot', (f'{S100}/sfx100v2_metal_hit_02.ogg', {}), (f'{S100}/sfx100v2_metal_hit_01.ogg', dict(maxlen=0.5)), (f'{C100}/hit_01.ogg', {}))
add('hurt', *[(f'{HITS}/hit{i:02d}.mp3.flac', dict(maxlen=0.45)) for i in (3, 8, 14, 19, 25, 31)])
add('die', (f'{HIT5}/die1.ogg', {}))
add('kill', (f'{KEN}/confirmation_001.ogg', {}), (f'{KEN}/confirmation_002.ogg', {}), (f'{KEN}/confirmation_003.ogg', {}), (f'{KEN}/confirmation_004.ogg', {}))
add('killhs', (f'{KEN}/glass_001.ogg', {}), (f'{S100}/sfx100v2_glass_04.ogg', {}))
add('streak', (f'{KEN}/maximize_006.ogg', {}), (f'{KEN}/maximize_008.ogg', {}), (f'{KEN}/pluck_001.ogg', {}))
add('revenge', (f'{KEN}/bong_001.ogg', {}), (f'{C100}/gong_01.ogg', dict(maxlen=1.0)))
add('shieldhit', (f'{KEN}/glass_002.ogg', {}), (f'{KEN}/glass_003.ogg', {}), (f'{KEN}/glass_005.ogg', {}))
add('shieldbreak', (f'{C100}/glass_04.ogg', {}), (f'{C100}/glass_05.ogg', {}), (f'{S100}/sfx100v2_glass_03.ogg', {}))
add('heartbeat', (f'{C100}/pot_01.ogg', dict(maxlen=0.35)))
add('pickup', (f'{KEN}/pluck_002.ogg', {}), (f'{C100}/key_open_02.ogg', {}), (f'{S100}/sfx100v2_items_01.ogg', {}))

# healing items
add('use_bandage', (f'{C100}/paper_02.ogg', {}), (f'{C100}/paper_04.ogg', {}))
add('done_bandage', (f'{C100}/paper_03.ogg', dict(maxlen=0.4)), (f'{KEN}/confirmation_002.ogg', {}))
add('use_medkit', (f'{C100}/key_open_01.ogg', {}), (f'{S100}/sfx100v2_lock_open_01.ogg', {}))
add('done_medkit', (f'{C100}/door_close_03.ogg', {}), (f'{KEN}/confirmation_004.ogg', {}))
add('use_drink', (f'{C100}/plop_01.ogg', {}), (f'{C100}/splash_01.ogg', dict(maxlen=0.5)))
add('done_drink', (f'{C100}/plop_02.ogg', {}), (f'{KEN}/confirmation_001.ogg', {}))
add('use_shield', (f'{S100}/sfx100v2_items_02.ogg', {}), (f'{KEN}/glitch_001.ogg', {}))
add('done_shield', (f'{KEN}/glitch_002.ogg', {}), (f'{KEN}/maximize_003.ogg', {}))
add('use_cancel', (f'{KEN}/back_002.ogg', {}))

# grenades
add('nade_pin', (f'{C100}/key_open_01.ogg', dict(maxlen=0.3)), (f'{S100}/sfx100v2_switch_01.ogg', {}))
add('nade_throw', (f'{S100}/sfx100v2_air_01.ogg', dict(seg=(0, 0.7))), (f'{S100}/sfx100v2_air_02.ogg', dict(maxlen=0.6)))
add('nade_bounce', (f'{S100}/sfx100v2_metal_hit_02.ogg', {}), (f'{C100}/metal_02.ogg', {}), (f'{C100}/metal_11.ogg', {}))
add('nade_boom', (f'{C100}/explosion.ogg', {}), (f'{S100}/sfx100v2_thunder_01.ogg', dict(maxlen=3.0, fade=0.5)), (f'{C100}/slam_03.ogg', {}))
add('smoke_pop', (f'{S100}/sfx100v2_air_03.ogg', {}), (f'{S100}/sfx100v2_air_02.ogg', {}), (f'{C100}/noise_02.ogg', {}))

# supply crates and the reveal
add('crate_fall', (f'{S100}/sfx100v2_air_01.ogg', dict(maxlen=2.2, fade=0.5)), (f'{C100}/weird_04.ogg', {}))
add('crate_thud', (f'{C100}/slam_03.ogg', {}), (f'{C100}/slam_07.ogg', {}), (f'{C100}/slam_02.ogg', {}))
add('crate_lock', (f'{C100}/key_open_01.ogg', {}), (f'{C100}/door_close_02.ogg', {}))
add('crate_burst', (f'{C100}/wooded_box_open.ogg', {}), (f'{C100}/door_open.ogg', {}), (f'{C100}/explosion.ogg', dict(maxlen=0.5)))
add('reveal_common', (f'{C100}/bell_02.ogg', {}), (f'{KEN}/confirmation_001.ogg', {}))
add('reveal_rare', (f'{C100}/bell_01.ogg', {}), (f'{KEN}/confirmation_003.ogg', {}))
add('reveal_epic', (f'{C100}/bell_03.ogg', {}), (f'{C100}/gong_01.ogg', {}))
add('reveal_legendary', (f'{C100}/gong_02.ogg', {}), (f'{C100}/gong_01.ogg', {}), (f'{KEN}/maximize_009.ogg', {}))

# menus, the shop, the locker
add('ui_click', *[(f'{KEN}/click_00{i}.ogg', {}) for i in (1, 2, 5)], (f'{UI}/click1.wav', {}), (f'{UI}/click3.wav', {}))
add('ui_hover', (f'{KEN}/tick_001.ogg', {}), (f'{KEN}/tick_002.ogg', {}), (f'{UI}/rollover1.wav', {}), (f'{UI}/rollover2.wav', {}), (f'{UI}/rollover3.wav', {}))
add('ui_select', *[(f'{KEN}/select_00{i}.ogg', {}) for i in (1, 2, 3, 4, 6)])
add('ui_back', (f'{KEN}/back_001.ogg', {}), (f'{KEN}/back_003.ogg', {}), (f'{KEN}/back_004.ogg', {}))
add('ui_open', (f'{KEN}/open_001.ogg', {}), (f'{KEN}/open_002.ogg', {}), (f'{KEN}/open_003.ogg', {}), (f'{KEN}/maximize_001.ogg', {}))
add('ui_close', (f'{KEN}/close_001.ogg', {}), (f'{KEN}/close_002.ogg', {}), (f'{KEN}/close_003.ogg', {}), (f'{KEN}/minimize_001.ogg', {}))
add('ui_toggle', *[(f'{KEN}/toggle_00{i}.ogg', {}) for i in (1, 2, 3, 4)])
add('ui_switch', (f'{UI}/switch3.wav', {}), (f'{UI}/switch9.wav', {}), (f'{UI}/switch14.wav', {}), (f'{UI}/switch22.wav', {}), (f'{UI}/switch31.wav', {}))
add('ui_scroll', *[(f'{KEN}/scroll_00{i}.ogg', {}) for i in (1, 2, 3)])
add('ui_confirm', (f'{KEN}/confirmation_001.ogg', {}), (f'{KEN}/confirmation_002.ogg', {}))
add('ui_error', (f'{KEN}/error_001.ogg', {}), (f'{KEN}/error_004.ogg', {}), (f'{KEN}/error_006.ogg', {}))
add('ui_buy', (f'{KEN}/pluck_001.ogg', {}), (f'{C100}/bell_02.ogg', {}), (f'{KEN}/drop_002.ogg', {}))
add('ui_equip', (f'{S100}/sfx100v2_metal_04.ogg', dict(maxlen=0.5)), (f'{C100}/tools_01.ogg', dict(maxlen=0.4)), (f'{KEN}/switch_003.ogg', {}))
add('ui_skin', (f'{C100}/spring_03.ogg', dict(maxlen=0.5)), (f'{KEN}/maximize_004.ogg', {}), (f'{KEN}/glass_004.ogg', {}))
add('ui_tab', (f'{KEN}/switch_001.ogg', {}), (f'{KEN}/switch_005.ogg', {}), (f'{UI}/switch1.wav', {}))
add('ui_locked', (f'{KEN}/error_002.ogg', {}), (f'{KEN}/question_001.ogg', {}))

# the match
add('countdown', (f'{KEN}/bong_001.ogg', dict(maxlen=0.5)), (f'{KEN}/tick_004.ogg', {}))
add('go', (f'{C100}/gong_01.ogg', {}), (f'{KEN}/maximize_007.ogg', {}))
add('win', (f'{C100}/bell_03.ogg', {}), (f'{KEN}/confirmation_004.ogg', {}), (f'{C100}/gong_02.ogg', {}))
add('loss', (f'{KEN}/error_008.ogg', {}), (f'{KEN}/error_007.ogg', {}))
add('draw', (f'{KEN}/question_002.ogg', {}), (f'{C100}/bell_01.ogg', dict(maxlen=0.6)))
add('level_up', (f'{KEN}/maximize_005.ogg', {}), (f'{KEN}/pluck_001.ogg', {}), (f'{KEN}/confirmation_003.ogg', {}))
add('objective', (f'{C100}/gong_02.ogg', dict(maxlen=1.0)), (f'{KEN}/open_004.ogg', {}))
add('zone_tick', (f'{KEN}/tick_001.ogg', {}))

# ---------------------------------------------------------------------------------------------------
# Every gun gets its own handling sounds. The same real recordings (clicks, magazines, bolts, pumps) are
# ranked from bright and light to dull and heavy by their spectral centroid, each gun is dealt a slice
# of that ranking by weight, and its pitch is shifted a little toward its weight as well: the pistol's
# dry-fire is a high tick, the LMG's a heavy clack.
# ---------------------------------------------------------------------------------------------------
GUNS = ['pistol', 'mp', 'smg', 'revolver', 'ar', 'dmr', 'ashotgun', 'shotgun', 'lmg', 'sniper']   # light to heavy
GUN_RATE = {g: 1.14 - 0.034 * i for i, g in enumerate(GUNS)}                                      # 1.14 ... 0.83
_cache = {}


def centroid(x):
    n = min(len(x), SR)
    sp = np.abs(np.fft.rfft(x[:n] * np.hanning(n)))
    fr = np.fft.rfftfreq(n, 1 / SR)
    return float((sp * fr).sum() / (sp.sum() + 1e-9))


def ranked(pool):
    """pool: list of (source, options). Returns it brightest first."""
    scored = []
    for src, opt in pool:
        key = (src, tuple(sorted(opt.items())))
        if key not in _cache:
            _cache[key] = centroid(process(load(src), **opt))
        scored.append((_cache[key], src, opt))
    scored.sort(key=lambda t: -t[0])
    return [(src, opt) for _, src, opt in scored]


def deal(pool, gun, takes=2, shift=0):
    """The slice of a ranked pool that belongs to `gun`."""
    r = GUNS.index(gun) / (len(GUNS) - 1)
    n = len(pool)
    start = int(round(r * (n - 1))) + shift
    return [pool[(start + k) % n] for k in range(min(takes, n))]


def with_rate(specs, gun, extra=None):
    out = []
    for src, opt in specs:
        o = dict(opt)
        o['rate'] = GUN_RATE[gun]
        if extra:
            o.update(extra)
        out.append((src, o))
    return out


EQC = f'{DL2}/equipment_clicks3.wav'
EQ1 = f'{DL2}/equipmentclicks.wav'
_clicks3 = events(load(EQC))
CLICKS = [(EQC, dict(ev=k, maxlen=0.3, fade=0.03)) for k, e in enumerate(_clicks3) if e[2] >= 0.5 and e[1] - e[0] <= 0.35 and 800 < e[3] < 9000]
CLICKS += [(EQ1, dict(ev=k, maxlen=0.3, fade=0.03)) for k in (0, 2, 4, 5)]
CLICKS += [(f'{DL2}/gun_reload_lock_or_click_sound.mp3', dict(maxlen=0.35)), (f'{C100}/switch_01.ogg', {}), (f'{C100}/switch_02.ogg', {})]
CLICKS = ranked(CLICKS)

# dry fire, equip, start-of-reload and low-ammo clicks: a different slice of the ranking for each
for g in GUNS:
    add(f'empty_{g}', *with_rate(deal(CLICKS, g, 3, 0), g))
    add(f'equip_{g}', *with_rate(deal(CLICKS, g, 2, 5), g))
    add(f'reloadclick_{g}', *with_rate(deal(CLICKS, g, 2, 9), g))
    add(f'lowammo_{g}', *with_rate(deal(CLICKS, g, 2, 13), g, dict(maxlen=0.18)))

# magazines, charging handles, shells, pumps, bolts: the pools the reload steps draw from
POOL = {
    'magOut': [(f'{DL}/clipload1.wav', {}), (f'{DL}/clipload2.wav', {}), (f'{KOE}/Ejecting Magazine-SoundBible.com-1801520333.wav', dict(maxlen=0.6)),
               (f'{DL2}/reload.wav', dict(ev=0, tail=0.15, maxlen=0.4)), (f'{DL}/gunreload1.wav', dict(ev=0, maxlen=0.4)),
               (f'{DL}/assaultriflereload1_0.wav', dict(ev=0, maxlen=0.4)), (f'{DL2}/gun_reload_lock_or_click_sound.mp3', dict(maxlen=0.35))],
    'magIn': [(f'{DL}/clipload1.wav', {}), (f'{DL}/clipload2.wav', {}), (f'{KOE}/Pop Clip In-SoundBible.com-583746573.wav', dict(maxlen=0.7)),
              (f'{DL2}/reload.wav', dict(ev=1, tail=0.15, maxlen=0.4)), (f'{DL}/assaultriflereload1_0.wav', dict(ev=1, maxlen=0.4)),
              (f'{DL}/gunreload1.wav', dict(ev=3, maxlen=0.45))],
    'charge': [(f'{DL}/shotguncock_0.wav', dict(maxlen=0.5)), (f'{DL}/gunreload1.wav', dict(ev=3, maxlen=0.45)),
               (f'{DL}/assaultriflereload1_0.wav', dict(ev=2, maxlen=0.45)), (f'{DL2}/reload.wav', dict(ev=2, maxlen=0.5)),
               (f'{KOE}/Chambering A Round-SoundBible.com-854171848.wav', dict(maxlen=0.8))],
    'slide': [(f'{DL}/gunreload1.wav', dict(ev=3, maxlen=0.4)), (f'{DL2}/reload.wav', dict(ev=2, maxlen=0.4)),
              (f'{DL2}/gun_reload_lock_or_click_sound.mp3', dict(maxlen=0.35)), (f'{DL}/assaultriflereload1_0.wav', dict(ev=2, maxlen=0.4))],
    'shell': [(f'{DL}/singlebullet1.wav', {}), (f'{SG}/Subsequent Shells.mp3', dict(ev=0, maxlen=0.4)), (f'{SG}/Subsequent Shells.mp3', dict(ev=1, maxlen=0.4)),
              (f'{SG}/First Shell.mp3', dict(ev=0, maxlen=0.4)), (f'{SG}/First Shell.mp3', dict(ev=1, maxlen=0.4))],
    'pump': [(f'{KOE}/Pump Shotgun-SoundBible.com-1653268682.wav', dict(maxlen=1.0)), (f'{SG}/Rack.mp3', dict(seg=(0.5, 1.1))), (f'{DL}/shotguncock_0.wav', {})],
    'boltUp': [(f'{SND}/mosin.wav', dict(ev=e, maxlen=0.6, tail=0.1)) for e in (0, 9, 22)] + [(f'{C100}/metal_03.ogg', {})],
    'boltDown': [(f'{SND}/mosin.wav', dict(ev=e, maxlen=0.6, tail=0.1)) for e in (1, 15, 29)] + [(f'{C100}/metal_02.ogg', {})],
}
POOL = {k: ranked(v) for k, v in POOL.items()}
# the steps of each gun's reload, as in RELOAD_STEPS in src/audio.js
KINDS = {
    'pistol': ['magOut', 'magIn', 'slide'], 'ar': ['magOut', 'magIn', 'charge'], 'smg': ['magOut', 'magIn', 'charge'],
    'shotgun': ['shell', 'pump'], 'sniper': ['boltUp', 'magOut', 'magIn', 'boltDown'],
    'revolver': ['magOut', 'shell', 'slide'], 'mp': ['magOut', 'magIn', 'slide'],
    'lmg': ['boltUp', 'magOut', 'magIn', 'charge'], 'ashotgun': ['magOut', 'magIn', 'charge'], 'dmr': ['magOut', 'magIn', 'charge'],
}
for g, kinds in KINDS.items():
    for k, kind in enumerate(kinds):
        add(f'foley_{g}_{kind}', *with_rate(deal(POOL[kind], g, 2, k), g))

# more takes of the shots themselves
add('gun_pistol', (f'{SHOTS}/pistol.wav', dict(shot=0.9)))
add('gun_ar', (f'{SHOTS}/rifle.wav', dict(shot=1.3)), (f'{FIRE}/Savage 10 .300 Blackout/T_27P.wav', dict(shot=1.3)))
add('gun_shotgun', (f'{SHOTS}/shotgun.wav', dict(shot=1.2)))
add('gun_lmg', (f'{SHOTS}/cg1.wav', dict(shot=0.55)), (f'{FIRE}/AK-47/C_29P.wav', dict(shot=0.6)))
add('gun_sniper', (f'{FIRE}/1917/B_24P.wav', dict(shot=2.0)), (f'{FIRE}/Arisaka/E_25P.wav', dict(shot=2.0)))
add('gun_dmr', (f'{FIRE}/Model 1894/L_23P.wav', dict(shot=1.4)))
add('gunfar_sniper', (f'{FIRE}/1917/B_16P.wav', dict(shot=2.4)))
add('gunfar_dmr', (f'{FIRE}/Model 1894/L_17P.wav', dict(shot=1.8)))
add('gunfar_ar', (f'{FIRE}/Savage 10 .300 Blackout/T_17P.wav', dict(shot=1.7)))

# spent brass and shells landing, a short while after your own shots
BRASS = ranked([(EQC, dict(ev=k, maxlen=0.25, fade=0.03)) for k, e in enumerate(_clicks3) if e[2] >= 0.5 and e[3] > 5500 and e[1] - e[0] <= 0.2])
add('casing_brass', *BRASS[:4])
add('casing_shell', (f'{DL}/singlebullet1.wav', dict(rate=0.8)), (f'{S100}/sfx100v2_wood_hit_02.ogg', dict(maxlen=0.2)), (f'{S100}/sfx100v2_wood_hit_03.ogg', dict(maxlen=0.2)))

# aiming down sights, crouching, standing: cloth and straps
add('ads_in', (f'{C100}/paper_01.ogg', dict(maxlen=0.22)), (f'{C100}/paper_03.ogg', dict(maxlen=0.22)), (f'{S100}/sfx100v2_air_03.ogg', dict(maxlen=0.2)))
add('ads_out', (f'{C100}/paper_02.ogg', dict(maxlen=0.22)), (f'{C100}/paper_04.ogg', dict(maxlen=0.22)), (f'{S100}/sfx100v2_air_02.ogg', dict(maxlen=0.2)))
add('crouch', (f'{C100}/paper_02.ogg', dict(maxlen=0.3, rate=0.8)), (f'{S100}/sfx100v2_air_02.ogg', dict(maxlen=0.3, rate=0.9)), (f'{C100}/tools_03.ogg', dict(maxlen=0.25)))
add('stand', (f'{C100}/paper_04.ogg', dict(maxlen=0.3, rate=0.85)), (f'{S100}/sfx100v2_air_03.ogg', dict(maxlen=0.3, rate=0.9)), (f'{C100}/tools_04.ogg', dict(maxlen=0.25)))

# bullets hitting the world, by material
add('impact_concrete', (f'{C100}/hit_02.ogg', dict(maxlen=0.25)), (f'{C100}/hit_03.ogg', dict(maxlen=0.25)), (f'{S100}/sfx100v2_hit_01.ogg', dict(maxlen=0.25)), (f'{S100}/sfx100v2_stones_03.ogg', dict(maxlen=0.25)))
add('impact_metal', (f'{S100}/sfx100v2_metal_hit_01.ogg', dict(maxlen=0.4)), (f'{S100}/sfx100v2_metal_hit_02.ogg', dict(maxlen=0.4)), (f'{C100}/metal_06.ogg', dict(maxlen=0.4)), (f'{C100}/metal_08.ogg', dict(maxlen=0.4)), (f'{C100}/metal_10.ogg', dict(maxlen=0.4)))
add('impact_dirt', (f'{S100}/sfx100v2_stones_01.ogg', dict(maxlen=0.2)), (f'{S100}/sfx100v2_stones_02.ogg', dict(maxlen=0.2)), (f'{C100}/hit_04.ogg', dict(maxlen=0.2, lp=2500)), (f'{S100}/sfx100v2_hit_03.ogg', dict(maxlen=0.2, lp=3000)))
add('impact_wood', (f'{S100}/sfx100v2_wood_hit_01.ogg', dict(maxlen=0.3)), (f'{C100}/wooden_01.ogg', dict(maxlen=0.3)), (f'{C100}/wooden_02.ogg', dict(maxlen=0.3)), (f'{C100}/wooden_03.ogg', dict(maxlen=0.3)))
add('impact_glass', (f'{S100}/sfx100v2_glass_01.ogg', dict(maxlen=0.6)), (f'{S100}/sfx100v2_glass_02.ogg', dict(maxlen=0.6)), (f'{C100}/glass_01.ogg', dict(maxlen=0.6)), (f'{C100}/glass_02.ogg', dict(maxlen=0.6)))
add('impact_snow', (f'{S100}/sfx100v2_stones_01.ogg', dict(maxlen=0.2, lp=1800, rate=0.8)), (f'{C100}/hit_04.ogg', dict(maxlen=0.2, lp=1500)))
add('whiz', (f'{S100}/sfx100v2_air_01.ogg', dict(maxlen=0.35, hp=1500)), (f'{S100}/sfx100v2_air_02.ogg', dict(maxlen=0.35, hp=1800, rate=1.3)),
    (f'{S100}/sfx100v2_air_03.ogg', dict(maxlen=0.3, hp=1500, rate=1.15)), (f'{C100}/shot_01.ogg', dict(maxlen=0.2, hp=2500)))

# a blast heard from far away, and the ringing after a near one
add('nade_far', (f'{S100}/sfx100v2_thunder_01.ogg', dict(maxlen=2.5, fade=0.6, lp=900)), (f'{C100}/explosion.ogg', dict(lp=700, rate=0.85)))
add('ring', (f'{C100}/bell_03.ogg', dict(maxlen=1.2, hp=4000, fade=0.9)))

# more of the menus and the match
add('ui_slider', (f'{KEN}/tick_004.ogg', {}), (f'{UI}/rollover5.wav', {}), (f'{UI}/rollover4.wav', {}))
add('countdown_final', (f'{KEN}/bong_001.ogg', dict(rate=1.5)), (f'{KEN}/maximize_006.ogg', {}))
add('spawn', (f'{S100}/sfx100v2_air_03.ogg', dict(maxlen=0.5, lp=3000)), (f'{KEN}/open_002.ogg', {}))

# ambience for each map: seamless loops, left whole
AMB = [('water', f'{S100}/sfx100v2_loop_water_02.ogg'), ('wind', f'{DL2}/wind%20woosh%20loop.ogg'),
       ('crickets', f'{DL2}/crickets_1.mp3'), ('highway', f'{S100}/sfx100v2_loop_highway.ogg'),
       ('machine', f'{S100}/sfx100v2_loop_machine_02.ogg'), ('hum', f'{S100}/sfx100v2_loop_machine_01.ogg'),
       ('room', f'{S100}/sfx100v2_loop_ambient_01.ogg'), ('yard', f'{S100}/sfx100v2_loop_construction_site.ogg')]
for name, src in AMB:
    add(f'ambience_{name}', (src, dict(raw=True, level=0.8)))


MUSIC = {
    'lobby': ['dl/main_menu_music_mastered_0.mp3', 'dl/menu_3.ogg', "dl/Just%20S%27more%20Fun.mp3", 'dl2/in_the_lobby.wav',
              'dl2/Friendly%20Talk%20On%20a%20Robotic%20Battlefield_0.ogg', ('dl2/SpacyLoop.ogg', 3), 'dl2/awesomeness.wav'],
    'shop': ['music/Local Forecast - Elevator.mp3', 'dl/Heavenly%20Loop_0.ogg', 'x2/shop/shop_theme/Buy Something!.ogg',
             'dl2/8bit%20Bossa.mp3', 'dl2/waiting._.wav'],
}


def main():
    clips = {}
    count = 0
    for name, specs in S.items():
        files = []
        for i, (src, opt) in enumerate(specs):
            try:
                x = process(load(src), **opt)
            except Exception as e:  # a missing or unreadable source is a build error, not a silent gap
                raise SystemExit(f'{name}: {src}: {e}')
            rel = f'sfx/{name}_{i + 1}.ogg'
            write(os.path.join(OUT, rel), x)
            files.append(rel)
            count += 1
        clips[name] = files
    music = {}
    for kind, srcs in MUSIC.items():
        music[kind] = []
        for i, src in enumerate(srcs):
            reps = 1
            if isinstance(src, tuple):
                src, reps = src          # a short loop played end to end this many times
            p = os.path.join(SRCROOT, src)
            x, sr = sf.read(p, always_2d=True, dtype='float32')
            if x.shape[1] == 1:
                x = np.repeat(x, 2, axis=1)
            x = np.tile(x, (reps, 1))
            if sr != SR:
                g = np.gcd(sr, SR)
                x = resample_poly(x, SR // g, sr // g, axis=0).astype('float32')
            x = x * (0.85 / (np.abs(x).max() + 1e-9))
            rel = f'music/{kind}_{i + 1}.ogg'
            os.makedirs(os.path.join(OUT, 'music'), exist_ok=True)
            # one big write overflows libsndfile's Vorbis encoder stack, so feed it a second at a time
            with sf.SoundFile(os.path.join(OUT, rel), 'w', samplerate=SR, channels=x.shape[1], format='OGG', subtype='VORBIS', compression_level=0.35) as f:
                for i in range(0, len(x), SR):
                    f.write(x[i:i + SR])
            music[kind].append(rel)
    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump({'version': 1, 'clips': clips, 'music': music}, f, indent=1)
    print(len(clips), 'names,', count, 'clips,', sum(len(v) for v in music.values()), 'tracks')


if __name__ == '__main__':
    main()
