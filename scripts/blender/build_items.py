"""
OVERRUN's props: the four healing items, the ammo chest and the first-person gloved hands.

    & 'C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe' -b --factory-startup --python scripts/blender/build_items.py
    ... -- preview <dir>        also renders a PNG per asset into <dir>
    ... -- only medkit,big      build just these

Writes assets/items/<name>.glb. The code (src/itemModels.js, src/healAnim.js) finds parts by
name, so the names and pivots below are a contract:

  bandage   gauze (the wound roll; code shrinks it as it unwinds, axle = X), core, band, cross,
            gauze_tail (hangs from the roll; pivot at its root)
  medkit    body, lid (pivot on the hinge, open = rotation.x negative), latch (pivot at its foot),
            handle, foam, cross, hardware, item_a / item_b / item_c (what lifts out)
  mini      liquid (pivot at its bottom, scale.y = level), neck, cap, label, emblem, glass
  big       liquid (pivot at its bottom), swirl, neck, cork (pivot at its base), tag, glass
  chest     body, lid, bands, seam, hardware, bullets
  hands     hand_r / hand_l each a Group of palm, knuckle, fingers (pivot at the knuckles),
            thumb (pivot at its root), cuff; sleeve_r / sleeve_l are unit-length cones along +Z

`glass` parts are translucent shells: the game shows them only in first person and hides them
elsewhere (a blended mesh on every floor pickup was once most of a frame). Nothing here uses
transmission or alpha.

Axes: authored in game axes (+Y up, +Z towards the viewer). See itemkit.py.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(REPO, 'assets', 'items')

import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import itemkit as K  # noqa: E402
from itemkit import Geo, arc, cross_pts, empty, export_glb, mat, place, shield_pts  # noqa: E402

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
PREVIEW = args[args.index('preview') + 1] if 'preview' in args else None
ONLY = set(args[args.index('only') + 1].split(',')) if 'only' in args else None

# ---------------------------------------------------------------- materials

WHITE_CASE = mat('case_white', 0xf1f3f5, 0.40, 0.0)
GAUZE = mat('gauze', 0xf3eee3, 0.92, 0.0)
CARDBOARD = mat('cardboard', 0xc9b085, 0.9, 0.0)
PAPER = mat('paper', 0xfbfaf6, 0.62, 0.0)
TAPE = mat('tape', 0x6fa8e0, 0.55, 0.0)
RED_CROSS = mat('red_cross', 0xd9323a, 0.45, 0.0, emit=0xff3b42, emit_k=0.9)
DARK_PLASTIC = mat('dark_plastic', 0x2c3036, 0.55, 0.05)
STEEL = mat('steel', 0xaeb6c0, 0.32, 0.9)
FOAM = mat('foam', 0x34282b, 0.95, 0.0)
AMBER = mat('amber_glass', 0x8a4a14, 0.2, 0.0, emit=0xb86a1c, emit_k=0.25)
GREEN_PACK = mat('green_pack', 0x4aa86a, 0.6, 0.0)
WOOD_CORK = mat('cork', 0xa57d4b, 0.88, 0.0)
TAG_PAPER = mat('tag_paper', 0xe9dec2, 0.85, 0.0)
ROPE = mat('rope', 0x8a6a3c, 0.9, 0.0)
GLOVE = mat('glove', 0x25282c, 0.86, 0.02)
KNUCKLE = mat('knuckle', 0x33373c, 0.7, 0.05)
SLEEVE = mat('sleeve', 0x3a3f35, 0.93, 0.0)

MINI_LIQ = mat('mini_liquid', 0x62d0ff, 0.12, 0.0, emit=0x62d0ff, emit_k=1.3)
MINI_NECK = mat('mini_neck', 0xbfe8ff, 0.18, 0.0, emit=0x62d0ff, emit_k=0.35)
MINI_GLASS = mat('glass_mini', 0xcfefff, 0.05, 0.0)
EMBLEM_BLUE = mat('emblem_blue', 0x1a5fd0, 0.5, 0.0, emit=0x3a8cff, emit_k=1.0)
BIG_LIQ = mat('big_liquid', 0x3d6bff, 0.1, 0.0, emit=0x3d6bff, emit_k=1.1)
BIG_NECK = mat('big_neck', 0xb7ccff, 0.15, 0.0, emit=0x3d6bff, emit_k=0.3)
BIG_GLASS = mat('glass_big', 0xd5e2ff, 0.05, 0.0)
SWIRL = mat('swirl', 0xb4e6ff, 0.2, 0.0, emit=0x9fe0ff, emit_k=2.2)

CHEST_OLIVE = mat('chest_olive', 0x4b5636, 0.7, 0.15)
CHEST_BAND = mat('chest_band', 0x2a2d2a, 0.45, 0.65)
SEAM_AMBER = mat('seam_amber', 0xffcf5a, 0.4, 0.0, emit=0xffc040, emit_k=2.2)
BRASS = mat('brass', 0xd6a63c, 0.28, 0.9)

coll_cache = {}


def collection(name):
    if name not in coll_cache:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
        coll_cache[name] = c
    return coll_cache[name]


def want(name):
    return ONLY is None or name in ONLY


def adopt(parent, child):
    """Parent without moving: the child keeps its world transform."""
    bpy.context.view_layer.update()
    child.parent = parent
    child.matrix_parent_inverse = parent.matrix_world.inverted()


def shell(size, r, wall, open_top, seg=2, pos=(0, 0, 0)):
    """A rounded box with one side removed and walls `wall` thick (a tray or a lid)."""
    import bmesh

    def make(sign):
        t = bmesh.new()
        bmesh.ops.create_cube(t, size=1.0)
        for v in t.verts:
            v.co.x *= size[0]
            v.co.y *= size[1]
            v.co.z *= size[2]
        bmesh.ops.bevel(t, geom=list(t.edges), offset=min(r, min(size) * 0.49), offset_type='OFFSET',
                        segments=seg, profile=0.5, affect='EDGES')
        t.normal_update()
        t.faces.ensure_lookup_table()
        top = max(t.faces, key=lambda f: f.normal.y * (1 if open_top else -1))
        bmesh.ops.delete(t, geom=[top], context='FACES_ONLY')
        t.faces.ensure_lookup_table()
        bmesh.ops.solidify(t, geom=list(t.faces), thickness=sign * wall)
        return t

    # whichever sign of thickness keeps the outside where it was is the inward one
    t = make(-1)
    ext = max(abs(v.co.x) for v in t.verts)
    if ext > size[0] / 2 + 1e-4:
        t.free()
        t = make(1)
    bmesh.ops.recalc_face_normals(t, faces=t.faces)
    bmesh.ops.transform(t, matrix=Matrix.Translation(Vector(pos)), verts=t.verts)
    g = Geo()
    me = bpy.data.meshes.new('tmp')
    t.to_mesh(me)
    t.free()
    g.bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    return g


# ================================================================ BANDAGE


def build_bandage():
    c = collection('bandage')
    R, HW = 0.13, 0.07
    # the wound gauze: layered steps on each end face and shallow ripples round the rim
    hs = [HW, HW - 0.004, HW - 0.008]
    rs = [0.05, 0.075, 0.10, R - 0.005]
    prof = []
    for k in range(3):
        prof += [(rs[k], hs[k]), (rs[k + 1], hs[k])]
    n = 10
    for i in range(n + 1):
        prof.append((R - 0.002 + 0.004 * math.cos(i / n * math.pi * 7), hs[2] - 2 * hs[2] * i / n))
    for k in (2, 1, 0):
        prof += [(rs[k + 1], -hs[k]), (rs[k], -hs[k])]
    g = Geo().lathe(prof, segs=28, closed=True, m=K.rot_to('x'))
    gauze = g.finish('gauze', GAUZE, crease=40, coll=c)
    core = Geo().lathe([(0.04, -HW - 0.004), (0.052, -HW - 0.004), (0.052, HW + 0.004), (0.04, HW + 0.004)],
                       segs=20, closed=True, m=K.rot_to('x')).finish('core', CARDBOARD, coll=c)
    # a paper belt round the middle with a cross facing front and back
    band = Geo().lathe([(R - 0.002, -0.03), (R + 0.005, -0.03), (R + 0.005, 0.03), (R - 0.002, 0.03)],
                       segs=28, closed=True, m=K.rot_to('x')).finish('band', PAPER, crease=70, coll=c)
    cg = Geo()
    for sgn in (1, -1):
        cg.prism(cross_pts(0.034, 0.0135), 0, 0.006, bevel=0.0012,
                 m=place((0, 0, sgn * (R + 0.0035)), ry=0 if sgn > 0 else math.pi))
    cross = cg.finish('cross', RED_CROSS, coll=c)
    # tape stripe across the gauze end, plus the loose tail
    tape = Geo()
    frames = []
    for i in range(7):
        a = math.radians(-70 + i * 6)
        pos = Vector((0, R * 0.995 * math.sin(a), R * 0.995 * math.cos(a)))
        frames.append((pos + Vector((0, 0, 0)), (1, 0, 0), pos.normalized()))
    tape.sweep(frames, 0.062, 0.0028)
    tape = tape.finish('tape', TAPE, crease=70, coll=c)
    pts = [(0, -0.118, 0.06), (0, -0.136, 0.115), (0, -0.172, 0.15), (0, -0.215, 0.16), (0, -0.255, 0.14), (0, -0.28, 0.105)]
    frames = []
    for i, p in enumerate(pts):
        q = pts[min(i + 1, len(pts) - 1)]
        p0 = pts[max(i - 1, 0)]
        tan = (Vector(q) - Vector(p0)).normalized()
        up = Vector((1, 0, 0)).cross(tan).normalized()
        frames.append((p, (1, 0, 0), up))
    tail = Geo().sweep(frames, 0.052, 0.0035).finish('gauze_tail', GAUZE, pivot=pts[0], crease=70, coll=c)
    return [gauze, core, band, cross, tape, tail]


# ================================================================ MEDKIT


def build_medkit():
    c = collection('medkit')
    W, D = 0.40, 0.14
    HB, HL = 0.14, 0.14          # body below the split (y 0), lid above it
    # body: a hollow tray with ribs on the sides and rubber gasket at the rim
    body = shell((W, HB, D), 0.02, 0.014, open_top=True, pos=(0, -HB / 2, 0))
    for sx in (-1, 1):
        for k in (-1, 0, 1):
            body.rbox((0.006, 0.09, 0.05), 0.002, 1, m=place((sx * (W / 2 + 0.001), -0.07, k * 0.04)))
    body = body.finish('body', WHITE_CASE, crease=55, coll=c)
    lid_pos = (0, HL / 2, D / 2)         # so that the lid sits above the split with its hinge at the back
    lid = shell((W, HL, D), 0.02, 0.014, open_top=False, pos=(0, HL / 2, 0))
    # embossed front panel and a groove frame
    lid.rbox((0.31, 0.105, 0.006), 0.004, 2, m=place((0, 0.07, D / 2 + 0.001)))
    for sx in (-1, 1):
        lid.rbox((0.006, 0.09, 0.05), 0.002, 1, m=place((sx * (W / 2 + 0.001), 0.07, 0.0)))
    lid = lid.finish('lid', WHITE_CASE, pivot=(0, 0.0, -D / 2 + 0.01), crease=55, coll=c)
    hinge = (0, 0.0, -D / 2 + 0.01)
    handle = Geo()
    for sx in (-1, 1):
        handle.rbox((0.022, 0.03, 0.03), 0.006, 2, m=place((sx * 0.07, HL + 0.012, 0.0)))
        handle.rbox((0.03, 0.03, 0.15), 0.008, 2, m=place((sx * (W / 2 - 0.01), 0.125, 0.0)))   # lid corner guards
    handle.rbox((0.17, 0.022, 0.03), 0.009, 2, m=place((0, HL + 0.034, 0.0)))
    handle.rbox((0.04, 0.02, 0.012), 0.004, 1, m=place((0, 0.035, D / 2 + 0.004)))             # the stud the latch hooks over
    handle = handle.finish('handle', DARK_PLASTIC, pivot=hinge, coll=c)
    cr = Geo()
    for sgn in (1, -1):
        cr.prism(cross_pts(0.043, 0.0185), 0, 0.007, bevel=0.0015,
                 m=place((0, 0.07, sgn * (D / 2 + 0.0045)), ry=0 if sgn > 0 else math.pi))
    cross = cr.finish('cross', RED_CROSS, pivot=hinge, coll=c)
    for ch in (handle, cross):
        adopt(lid, ch)
    hw = Geo()
    for sx in (-1, 1):                       # lower corner guards and hinge barrels
        hw.rbox((0.03, 0.03, 0.15), 0.008, 2, m=place((sx * (W / 2 - 0.01), -0.125, 0.0)))
        hw.cyl(0.011, 0.07, 12, axis='x', pos=(sx * 0.12, 0.0, -D / 2 - 0.004))
    hw = hw.finish('hardware', DARK_PLASTIC, coll=c)
    latch = Geo().rbox((0.05, 0.075, 0.014), 0.005, 2, m=place((0, -0.0075, D / 2 + 0.012)))
    latch.rbox((0.034, 0.02, 0.02), 0.005, 2, m=place((0, 0.03, D / 2 + 0.015)))
    latch = latch.finish('latch', STEEL, pivot=(0, -0.045, D / 2 + 0.012), coll=c)
    foam = Geo().rbox((W - 0.04, 0.07, D - 0.04), 0.008, 2, m=place((0, -0.118 + 0.035, 0)))
    foam = foam.finish('foam', FOAM, coll=c)
    # what lifts out: a gauze roll, an amber bottle, a green dressing pack
    a = Geo().cyl(0.032, 0.07, 16, axis='x', bevel=0.004)
    a.cyl(0.0335, 0.016, 16, axis='x', pos=(0, 0, 0), bevel=0.002)
    ia = a.finish('item_a', GAUZE, pivot=(-0.11, -0.012, 0.0), coll=c)
    ia.location = K.gv(-0.11, -0.012, 0.0)
    b = Geo().cyl(0.026, 0.07, 14, axis='y', bevel=0.005)
    b.cyl(0.02, 0.025, 12, pos=(0, 0.045, 0), bevel=0.003)
    ib = b.finish('item_b', AMBER, pivot=(0.0, -0.012, 0.0), coll=c)
    ib.location = K.gv(0.0, -0.012, 0.0)
    p = Geo().rbox((0.085, 0.022, 0.06), 0.006, 2)
    p.prism(cross_pts(0.016, 0.007), 0, 0.003, m=place((0, 0.0115, 0), rx=-math.pi / 2))
    ic = p.finish('item_c', GREEN_PACK, pivot=(0.115, -0.025, 0.0), coll=c)
    ic.location = K.gv(0.115, -0.025, 0.0)
    return [body, lid, handle, cross, hw, latch, foam, ia, ib, ic]


# ================================================================ MINI SHIELD


def build_mini():
    c = collection('mini')
    # liquid: a capsule that fills the lower vial; origin at its bottom so scale.y drains it
    rl = 0.042
    prof = [(0, 0.0)] + arc(0, rl, rl, -90, 0, 6)[1:] + [(rl, 0.19), (0, 0.19)]
    liq = Geo().lathe(prof, segs=20).finish('liquid', MINI_LIQ, pivot=(0, 0, 0), crease=70, coll=c)
    liq.location = K.gv(0, -0.15, 0)
    # the shoulder and neck are opaque tinted glass, so they read on the floor
    neck_prof = [(0.0, 0.19), (0.047, 0.19), (0.047, 0.2), (0.034, 0.235), (0.026, 0.25), (0.026, 0.29), (0.032, 0.295), (0.032, 0.305), (0.0, 0.305)]
    neck = Geo().lathe(neck_prof, segs=20).finish('neck', MINI_NECK, pivot=(0, 0, 0), crease=60, coll=c)
    neck.location = K.gv(0, -0.15, 0)
    cap = Geo().cyl(0.036, 0.06, 8, bevel=0.006, pos=(0, 0.3 + 0.03, 0))
    cap.cyl(0.03, 0.012, 8, pos=(0, 0.3 + 0.066, 0), bevel=0.003)
    cap = cap.finish('cap', STEEL, pivot=(0, 0.3, 0), crease=40, coll=c)
    cap.location = K.gv(0, -0.15 + 0.3, 0)
    base = Geo().cyl(0.046, 0.016, 20, pos=(0, 0.008, 0), bevel=0.004).finish('base', STEEL, pivot=(0, 0, 0), crease=40, coll=c)
    base.location = K.gv(0, -0.166, 0)
    # a paper label wrapped round the vial with a shield on it (front)
    lab = Geo().lathe([(0.0432, 0.045), (0.0475, 0.045), (0.0475, 0.125), (0.0432, 0.125)], segs=24, closed=True)
    lab = lab.finish('label', PAPER, pivot=(0, 0, 0), crease=70, coll=c)
    lab.location = K.gv(0, -0.15, 0)
    em = Geo()
    for sgn in (1, -1):
        em.prism(shield_pts(0.05, 0.062), 0, 0.004, bevel=0.0008,
                 m=place((0, 0.085, sgn * 0.0475), ry=0 if sgn > 0 else math.pi))
    emblem = em.finish('emblem', EMBLEM_BLUE, pivot=(0, 0, 0), coll=c)
    emblem.location = K.gv(0, -0.15, 0)
    gprof = [(0, 0.0)] + arc(0, 0.05, 0.05, -90, 0, 6)[1:] + [(0.05, 0.19), (0.036, 0.235), (0.028, 0.255), (0.028, 0.29), (0, 0.29)]
    glass = Geo().lathe(gprof, segs=20).finish('glass', MINI_GLASS, pivot=(0, 0, 0), crease=70, coll=c)
    glass.location = K.gv(0, -0.152, 0)
    return [liq, neck, cap, base, lab, emblem, glass]


# ================================================================ BIG POTION


def build_big():
    c = collection('big')
    R = 0.135
    cy = -0.10                                # body centre
    neck_top = 0.17
    # liquid: a sphere cut flat at the top; origin at its bottom so scale.y is the level
    rl = R - 0.012
    pts = [(0.0, 0.0)]
    top_a = 34.0                               # the liquid fills to a little above the equator
    for i in range(1, 15):
        a = math.radians(-90 + i * (90 + top_a) / 14)
        pts.append((rl * math.cos(a), rl + rl * math.sin(a)))
    pts.append((0.0, pts[-1][1]))
    liq = Geo().lathe(pts, segs=24).finish('liquid', BIG_LIQ, pivot=(0, 0, 0), crease=70, coll=c)
    liq.location = K.gv(0, cy - rl, 0)
    lvl = cy - rl + pts[-1][1]                 # world height of the liquid surface
    # opaque neck: shoulder, tube, flared lip
    rr_ = math.sqrt(max(rl * rl - (lvl - cy) ** 2, 1e-6))
    nprof = [(0.0, lvl), (rr_ + 0.002, lvl), (rr_ - 0.004, lvl + 0.025), (0.085, lvl + 0.05), (0.062, lvl + 0.085),
             (0.045, lvl + 0.12), (0.04, lvl + 0.15), (0.04, lvl + 0.205), (0.052, lvl + 0.22), (0.056, lvl + 0.235),
             (0.046, lvl + 0.245), (0.0, lvl + 0.245)]
    neck_top = lvl + 0.245
    neck = Geo().lathe(nprof, segs=20).finish('neck', BIG_NECK, pivot=(0, lvl, 0), crease=55, coll=c)
    neck.location = K.gv(0, lvl, 0)
    cork = Geo().cyl(0.04, 0.075, 14, r2=0.047, pos=(0, 0.0375, 0), bevel=0.004)
    cork.cyl(0.05, 0.014, 14, pos=(0, 0.082, 0), bevel=0.004)
    cork = cork.finish('cork', WOOD_CORK, pivot=(0, 0, 0), crease=45, coll=c)
    cork.location = K.gv(0, neck_top - 0.02, 0)
    # swirl: a ribbon spiralling up inside the liquid, with a few bubbles; code turns it
    frames = []
    for i in range(0, 25):
        t = i / 24
        a = t * math.pi * 3.2
        rr = 0.075 * math.sin(math.pi * t) ** 0.7 + 0.01
        pos = Vector((rr * math.cos(a), -0.1 + t * 0.2, rr * math.sin(a)))
        right = Vector((0, 1, 0))
        up = Vector((math.cos(a), 0, math.sin(a)))
        frames.append((pos, right, up))
    sw = Geo().sweep(frames, 0.022, 0.0035)
    for bx, by, bz, br in ((0.04, 0.09, 0.03, 0.011), (-0.05, 0.05, 0.02, 0.008), (0.0, 0.13, -0.05, 0.009), (-0.03, 0.02, -0.07, 0.007)):
        sw.sphere(br, pos=(bx, by, bz), segs=8, rings=6)
    swirl = sw.finish('swirl', SWIRL, pivot=(0, 0, 0), coll=c)
    swirl.location = K.gv(0, cy, 0)
    # hanging tag with a shield, tied round the neck
    rope = Geo().lathe(arc(0.0, 0.0, 0.0, 0, 0, 1) if False else [(0.048, -0.004), (0.052, -0.004), (0.052, 0.006), (0.048, 0.006)], segs=16, closed=True)
    tag = Geo().merge_geo(rope, m=place((0, cy + 0.25, 0)))
    tg = Geo()
    tg.prism([(-0.032, -0.04), (0.032, -0.04), (0.032, 0.03), (0.0, 0.052), (-0.032, 0.03)], 0, 0.004, bevel=0.0012,
             m=place((0.0, cy + 0.205, 0.075), rx=0.22))
    tg_obj = tg.merge_geo(tag).finish('tag', TAG_PAPER, pivot=(0, cy + 0.25, 0), crease=50, coll=c)
    tg_obj.location = K.gv(0, cy + 0.25, 0)
    tagem = Geo().prism(shield_pts(0.032, 0.04), 0, 0.003, bevel=0.0008, m=place((0.0, cy + 0.2, 0.0795), rx=0.22))
    tagem = tagem.finish('emblem', EMBLEM_BLUE, pivot=(0, cy + 0.25, 0), coll=c)
    tagem.location = K.gv(0, cy + 0.25, 0)
    gprof = [(0.0, 0.0)]
    rg = R
    for i in range(1, 13):
        a = math.radians(-90 + i * 125 / 12)
        gprof.append((rg * math.cos(a), rg + rg * math.sin(a)))
    gy = cy - rg                                # world height of the glass's bottom
    gprof += [(0.075, lvl + 0.04 - gy), (0.052, lvl + 0.1 - gy), (0.046, lvl + 0.15 - gy), (0.046, neck_top - 0.005 - gy), (0.0, neck_top - 0.005 - gy)]
    glass = Geo().lathe(gprof, segs=24).finish('glass', BIG_GLASS, pivot=(0, 0, 0), crease=70, coll=c)
    glass.location = K.gv(0, cy - rg, 0)
    return [liq, neck, cork, swirl, tg_obj, tagem, glass]


# ================================================================ AMMO CHEST


def build_chest():
    c = collection('chest')
    W, H, D = 0.62, 0.42, 0.44
    hb = 0.30                                      # body height; the lid sits on it
    body = shell((W, hb, D), 0.02, 0.02, open_top=True, pos=(0, -H / 2 + hb / 2, 0))
    body.rbox((W - 0.05, 0.14, D - 0.05), 0.01, 2, m=place((0, -H / 2 + hb - 0.12, 0)))   # the ammo inside
    body = body.finish('body', CHEST_OLIVE, crease=55, coll=c)
    lid_h = H - hb
    lid = Geo().rbox((W + 0.02, lid_h, D + 0.02), 0.025, 3, m=place((0, -H / 2 + hb + lid_h / 2, 0)))
    lid = lid.finish('lid', CHEST_OLIVE, pivot=(0, -H / 2 + hb, -D / 2), crease=55, coll=c)
    bands = Geo()
    for sx in (-0.2, 0.2):
        bands.rbox((0.05, H + 0.01, D + 0.034), 0.008, 2, m=place((sx, 0.0, 0.0)))
    bands = bands.finish('bands', CHEST_BAND, crease=55, coll=c)
    hw = Geo()
    for sx in (-1, 1):                              # end handles
        hw.rbox((0.014, 0.05, 0.1), 0.005, 2, m=place((sx * (W / 2 + 0.012), 0.04, 0.0)))
    for bx in (-0.2, 0.2):                          # rivets
        for by in (-0.15, 0.15):
            hw.sphere(0.013, pos=(bx, by, D / 2 + 0.019), segs=8, rings=5)
    hw.rbox((0.085, 0.07, 0.02), 0.006, 2, m=place((0, -H / 2 + hb - 0.01, D / 2 + 0.014)))   # latch
    hw = hw.finish('hardware', STEEL, crease=50, coll=c)
    seam = Geo().rbox((W + 0.03, 0.022, D + 0.03), 0.005, 1, m=place((0, -H / 2 + hb, 0)))
    seam = seam.finish('seam', SEAM_AMBER, crease=60, coll=c)
    bl = Geo()
    for i, bx in enumerate((-0.05, 0.0, 0.05)):
        bl.cyl(0.013, 0.07, 10, pos=(bx, -0.04, D / 2 + 0.003), axis='y')
        bl.cyl(0.013, 0.018, 10, r2=0.003, pos=(bx, 0.005, D / 2 + 0.003))
    # the bullets are drawn on the front, lying against it: squash them
    bl = bl.finish('bullets', BRASS, crease=50, coll=c)
    return [body, lid, bands, hw, seam, bl]


# ================================================================ HANDS


def build_hand(side):
    """A gloved hand, wrist at the origin, fingers along -Z, palm up (+Y), thumb on +X for the
    right hand. fingers pivot at the knuckles and thumb at its root: rotation.x on `fingers`
    curls them towards the palm."""
    s = side
    sfx = 'r' if s > 0 else 'l'
    c = collection('hands')
    pal = Geo().rbox((0.084, 0.034, 0.092), 0.011, 2, m=place((0, 0, -0.052)))
    pal.cyl(0.04, 0.034, 14, axis='z', pos=(0, 0, 0.012), bevel=0.004)             # cuff
    palm = pal.finish('palm_%s' % sfx, GLOVE, crease=60, coll=c)
    kn = Geo().rbox((0.07, 0.01, 0.034), 0.004, 2, m=place((0, -0.02, -0.075)))
    for i in range(4):
        kn.rbox((0.014, 0.012, 0.014), 0.004, 1, m=place((s * (0.027 - i * 0.018), -0.016, -0.098)))
    knuckle = kn.finish('knuckle_%s' % sfx, KNUCKLE, crease=60, coll=c)
    fingers = Geo()
    lens = ((0.036, 0.03, 0.024), (0.04, 0.032, 0.026), (0.037, 0.03, 0.024), (0.03, 0.024, 0.02))
    curl = (38, 52, 44)
    for i in range(4):
        x = s * (0.0315 - i * 0.0205)
        # each finger is three rounded blocks, each bent a little more than the last
        m = Matrix.Translation(Vector((x, 0.0, -0.098)))
        for seg in range(3):
            m = m @ Matrix.Rotation(math.radians(curl[seg]), 4, 'X')
            ln = lens[i][seg]
            fingers.rbox((0.0175 - 0.001 * seg, 0.0175 - 0.001 * seg, ln + 0.004), 0.0072, 2, m=m @ Matrix.Translation(Vector((0, 0, -ln / 2))))
            m = m @ Matrix.Translation(Vector((0, 0, -ln)))
    fingers = fingers.finish('fingers_%s' % sfx, GLOVE, pivot=(0, 0, -0.098), crease=60, coll=c)
    th = Geo()
    m = Matrix.Translation(Vector((s * 0.043, 0.004, -0.032))) @ Matrix.Rotation(math.radians(-8) * s, 4, 'Y') @ Matrix.Rotation(math.radians(30), 4, 'X')
    for ln, ang in ((0.036, 0), (0.03, 25)):
        m = m @ Matrix.Rotation(math.radians(ang), 4, 'X')
        th.rbox((0.021, 0.021, ln + 0.005), 0.009, 2, m=m @ Matrix.Translation(Vector((0, 0, -ln / 2))))
        m = m @ Matrix.Translation(Vector((0, 0, -ln)))
    thumb = th.finish('thumb_%s' % sfx, GLOVE, pivot=(s * 0.043, 0.004, -0.032), crease=60, coll=c)
    sl = Geo().cyl(0.036, 1.0, 12, r2=0.055, axis='z', pos=(0, 0, 0.5), m=None)
    sleeve = sl.finish('sleeve_%s' % sfx, SLEEVE, pivot=(0, 0, 0), crease=50, coll=c)
    sleeve.location = K.gv(0, 0, 0.026)
    root = empty('hand_%s' % sfx, (0, 0, 0), coll=c)
    for ch in (palm, knuckle, fingers, thumb):
        adopt(root, ch)
    return [root, palm, knuckle, fingers, thumb, sleeve]


def run():
    os.makedirs(OUT, exist_ok=True)
    jobs = [('bandage', build_bandage, (0.42, 0.28, 0.62), (0, -0.07, 0)),
            ('medkit', build_medkit, (0.4, 0.45, 0.85), (0, 0.0, 0)),
            ('mini', build_mini, (0.4, 0.3, 0.75), (0, 0.07, 0)),
            ('big', build_big, (0.4, 0.3, 0.8), (0, 0.04, 0)),
            ('chest', build_chest, (0.55, 0.45, 0.85), (0, 0, 0))]
    for name, fn, eye, tgt in jobs:
        if not want(name):
            continue
        objs = fn()
        export_glb(os.path.join(OUT, name + '.glb'), objs)
        if PREVIEW:
            os.makedirs(PREVIEW, exist_ok=True)
            K.preview(objs, os.path.join(PREVIEW, name + '.png'), eye, tgt)
            K.preview(objs, os.path.join(PREVIEW, name + '_b.png'), (-eye[0] * 0.9, eye[1] * 0.4, -eye[2] * 0.9), tgt)
        for o in objs:
            o.hide_render = True
            o.hide_viewport = True
    if want('hands'):
        right, left = build_hand(1), build_hand(-1)
        export_glb(os.path.join(OUT, 'hands.glb'), right + left)
        if PREVIEW:
            os.makedirs(PREVIEW, exist_ok=True)
            K.preview(right, os.path.join(PREVIEW, 'hand_r.png'), (0.28, 0.22, 0.2), (0, 0, -0.07), lens=55)
            K.preview(right, os.path.join(PREVIEW, 'hand_r_b.png'), (-0.2, -0.2, -0.3), (0, 0, -0.07), lens=55)


run()
