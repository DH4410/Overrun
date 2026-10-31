"""
The first-person arms: a gloved hand with sculpted-looking fingers and a sleeve, built for build_hands.py.

Frame (Blender, Z up): the arm points along +Y (the way the gun points), the wrist is at the origin
of the arm, the palm faces DOWN (-Z) and the thumb is on -X for the right hand. The left hand is the
mirror image. Everything is in metres.

The glove is a union of overlapping ellipsoids (palm, thenar pad, one per phalanx) fused by a voxel
remesh and relaxed, which gives the soft joint bulges of a real glove rather than a row of
cylinders; the result is decimated to a game budget. Hard knuckle guards, a strap and the sleeve are
separate shells added on top.
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Vector

# Finger layout: x of the knuckle, y of the knuckle, phalanx lengths, radius (right hand, palm down).
FINGERS = {
    'idx': (-0.0315, 0.090, (0.040, 0.0245, 0.019), 0.0108),
    'mid': (-0.0105, 0.095, (0.044, 0.027, 0.020), 0.0112),
    'rng': (0.0105, 0.091, (0.040, 0.025, 0.0185), 0.0104),
    'pnk': (0.0315, 0.082, (0.032, 0.019, 0.016), 0.0094),
}
# Thumb: base, then three directions and lengths (metacarpal, proximal, distal).
THUMB_BASE = Vector((-0.032, 0.026, -0.004))
THUMB = ((Vector((-0.52, 0.85, -0.08)), 0.046), (Vector((-0.34, 0.93, -0.12)), 0.036), (Vector((-0.2, 0.97, -0.1)), 0.031))


def finger_joints(name):
    x, y0, lens, _ = FINGERS[name]
    pts = [Vector((x, y0, 0.0))]
    for ln in lens:
        pts.append(pts[-1] + Vector((0, ln, 0)))
    return pts


def thumb_joints():
    pts = [THUMB_BASE.copy()]
    for d, ln in THUMB:
        pts.append(pts[-1] + d.normalized() * ln)
    return pts


class Blob:
    """Ellipsoids collected in one bmesh."""

    def __init__(self):
        self.bm = bmesh.new()

    def ell(self, c, r, rot_x=0.0, rot_z=0.0, seg=20):
        geom = bmesh.ops.create_uvsphere(self.bm, u_segments=seg, v_segments=seg // 2 + 1, radius=1.0)['verts']
        m = (Matrix.Translation(Vector(c)) @ Matrix.Rotation(rot_z, 4, 'Z') @ Matrix.Rotation(rot_x, 4, 'X')
             @ Matrix.Diagonal(Vector((r[0], r[1], r[2], 1))))
        bmesh.ops.transform(self.bm, matrix=m, verts=geom)

    def seg(self, p0, p1, r0, r1, flat=1.0, grow=0.8):
        """A phalanx: an ellipsoid whose long axis runs p0 -> p1, a little longer than the bone so it overlaps the next."""
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        ln = d.length
        rz = math.atan2(-d.x, d.y)
        rx = math.atan2(d.z, math.hypot(d.x, d.y))
        r = (r0 + r1) / 2
        self.ell((p0 + p1) / 2, (r, ln / 2 + r * grow, r * flat), rx, rz)


def to_mesh(bm, name):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return me


def evaluated_copy(ob, name):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    me.name = name
    return me


def build_glove(name, target_tris):
    """The glove as a single smooth shell (right hand). Returns an object."""
    b = Blob()
    # palm and the fleshy pads
    b.ell((0.002, 0.047, 0.0), (0.0455, 0.052, 0.0175), seg=26)
    b.ell((-0.031, 0.03, -0.003), (0.0205, 0.031, 0.0145), 0, 0.35)          # thenar
    b.ell((0.034, 0.03, -0.003), (0.014, 0.03, 0.013), 0, -0.1)             # hypothenar
    # wrist: a short tapered cuff running back under the sleeve
    for y, rx, rz in ((0.0, 0.0345, 0.0235), (-0.03, 0.033, 0.023), (-0.06, 0.0335, 0.0235)):
        b.ell((0.0, y, 0.0), (rx, 0.03, rz), seg=22)
    for n, (x, y0, lens, r) in FINGERS.items():
        pts = finger_joints(n)
        b.ell((x, y0, 0.0), (r * 1.28, 0.013, r * 1.18))                       # knuckle
        for i in range(3):
            b.seg(pts[i], pts[i + 1], r * (1 - 0.07 * i), r * (1 - 0.1 * (i + 1)), 0.94)
    t = thumb_joints()
    rs = (0.0132, 0.0122, 0.0112, 0.0098)
    for i in range(3):
        b.seg(t[i], t[i + 1], rs[i], rs[i + 1], 0.96)
    me = to_mesh(b.bm, name)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    rm = ob.modifiers.new('rm', 'REMESH')
    rm.mode = 'VOXEL'
    rm.voxel_size = 0.0016
    sm = ob.modifiers.new('sm', 'SMOOTH')
    sm.factor = 0.9
    sm.iterations = 10
    me2 = evaluated_copy(ob, name)
    ob.modifiers.clear()
    ob.data = me2
    # decimate to the budget
    dec = ob.modifiers.new('dec', 'DECIMATE')
    dec.ratio = min(1.0, target_tris / max(1, sum(len(p.vertices) - 2 for p in me2.polygons)))
    me3 = evaluated_copy(ob, name)
    ob.modifiers.clear()
    ob.data = me3
    for p in me3.polygons:
        p.use_smooth = True
    return ob


def sleeve_radius(y):
    """Sleeve radius at y (wrist at 0, elbow near -0.28): snug at the cuff, a little baggy up the arm."""
    t = max(0.0, min(1.0, (-y - 0.04) / 0.65))
    return 0.0395 + 0.0125 * t


def build_sleeve(name, y_end=-0.7, rings=22, segs=20):
    """A fabric tube from the cuff (just behind the wrist) back to the shoulder, with a rolled hem."""
    bm = bmesh.new()
    y_start = -0.035
    ys = [y_start + 0.004, y_start]
    ys += [y_start + (y_end - y_start) * ((i + 1) / rings) ** 1.25 for i in range(rings)]
    rows = []
    for k, y in enumerate(ys):
        r = sleeve_radius(y) - (0.007 if k == 0 else 0.0)
        row = []
        for j in range(segs):
            a = j / segs * math.tau
            # soft folds near the cuff and at the elbow, so it is cloth and not a pipe
            bunch = 1.0 + 0.04 * math.sin(a * 3 + y * 40) * (1 if y > -0.2 else 0.5) + 0.03 * math.exp(-((y + 0.33) / 0.03) ** 2)
            bunch += 0.022 * math.sin(a * 5 - y * 70)
            row.append(bm.verts.new((math.cos(a) * r * bunch, y, math.sin(a) * r * 0.97 * bunch)))
        rows.append(row)
    for i in range(len(rows) - 1):
        for j in range(segs):
            a, b = rows[i][j], rows[i][(j + 1) % segs]
            c, d = rows[i + 1][(j + 1) % segs], rows[i + 1][j]
            bm.faces.new((a, d, c, b))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = to_mesh(bm, name)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    for p in me.polygons:
        p.use_smooth = True
    return ob


def smooth(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def lin(h, k=1.0):
    out = []
    for sh in (16, 8, 0):
        c = ((h >> sh) & 255) / 255.0
        out.append((c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4) * k)
    return Vector(out)


COL = {
    'back': lin(0x23262a), 'pad': lin(0x34373b), 'guard': lin(0x111214), 'strap': lin(0x5b5440),
    'sleeve': lin(0x3a3f35), 'hem': lin(0x2c3029),
}


def paint_glove(ob):
    """Raise the knuckle guard, finger plates, strap and cuff band a millimetre or two, and tint them.
    Everything is a soft mask on vertices, so edges are clean gradients and not a ragged cut."""
    me = ob.data
    me.update()
    cols = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    lifts = []
    for v in me.vertices:
        c, n = v.co, v.normal
        back = smooth(-0.05, 0.35, n.z)                                   # faces the back of the hand
        under = smooth(0.05, 0.45, -n.z) * smooth(-0.01, 0.015, c.y)      # palm and the fingers' pads
        # hard knuckle guard across the four knuckles
        g = back * smooth(0.040, 0.034, abs(c.x)) * smooth(0.064, 0.074, c.y) * smooth(0.112, 0.102, c.y)
        # plates on the backs of the fingers
        pl = 0.0
        for fx, y0, lens, r in FINGERS.values():
            pl = max(pl, back * smooth(r * 0.75, r * 0.45, abs(c.x - fx)) * smooth(y0 + lens[0] * 0.15, y0 + lens[0] * 0.4, c.y)
                     * smooth(y0 + lens[0] * 1.0, y0 + lens[0] * 0.85, c.y))
        hard = max(g, pl * 0.9)
        strap = smooth(-0.002, 0.003, c.y) * smooth(0.021, 0.016, c.y)
        cuff = smooth(-0.062, -0.056, c.y) * smooth(-0.040, -0.046, c.y)
        band = max(strap, cuff)
        lifts.append(0.0016 * hard + 0.0013 * band)
        col = COL['back'].lerp(COL['pad'], under)
        col = col.lerp(COL['guard'], hard)
        col = col.lerp(COL['strap'], band)
        # creases at every finger joint
        crease = 0.0
        for n_, (fx, y0, lens, r) in FINGERS.items():
            if abs(c.x - fx) < r * 1.5:
                y = y0
                for ln in lens[:2]:
                    y += ln
                    crease = max(crease, smooth(0.0035, 0.0, abs(c.y - y)))
        col = col * (1 - 0.35 * crease)
        cols.data[v.index].color = (col.x, col.y, col.z, 1.0)
    for v, k in zip(me.vertices, lifts):
        v.co += v.normal * k
    me.update()
    for p in me.polygons:
        p.use_smooth = True


def paint_sleeve(ob):
    me = ob.data
    cols = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    for v in me.vertices:
        a = math.atan2(v.co.z, v.co.x)
        k = 0.88 + 0.12 * math.sin(a * 3 + v.co.y * 40) * 0.5 + 0.06 * math.sin(a * 5 - v.co.y * 70)
        col = COL['sleeve'] * k
        if v.co.y > -0.045:
            col = COL['hem']
        cols.data[v.index].color = (col.x, col.y, col.z, 1.0)
