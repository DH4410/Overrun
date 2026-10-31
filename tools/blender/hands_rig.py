"""
The arm rig for build_hands.py: two arms (upper arm, forearm, hand, three phalanges per finger, three
for the thumb) under a `root`, plus the controls an animation keys:

  gun            offset of the weapon (and everything that rides it) from where it normally sits
  ik_r / ik_l    where each wrist goes and how the hand is turned; children of `gun`, so a gun that
                 tilts or drops takes both hands along
  pole_r / pole_l  the point the elbow bends toward

The arms themselves are never keyed. Their pose is solved from the controls by solve_arm() here and
by the same maths in src/handRig.js, so what the Blender previews show is what the game draws.

Bones are laid out along +Y. A finger or thumb bone's local +X is the axis that curls it toward the
palm, so `curl` angles are positive for a fist on both hands.
"""
import math

import bpy
from mathutils import Matrix, Quaternion, Vector

import hands_mesh as hm

# The shoulders, in the gun frame at the hip of the reference rifle (the camera is at (-0.11, -0.19, 0.105)):
# a little behind the eye and below it. The rest pose stretches each arm straight forward from there, so the
# wrists start at SHOULDER + 0.69 forward.
FOREARM = 0.33
UPPER = 0.36
SHOULDER = {'r': Vector((0.09, -0.23, -0.07)), 'l': Vector((-0.31, -0.23, -0.07))}
WRIST = {s: v + Vector((0, FOREARM + UPPER, 0)) for s, v in SHOULDER.items()}
HAND_LEN = 0.09
FINGER_NAMES = ('idx', 'mid', 'rng', 'pnk')
ANCHORS = ('grip', 'support', 'mag', 'charge')    # the named points of a gun a hand can be on (see hands_anim.py)

# Controls that are not arm: prop bones (name: (parent, rest head)). hands_props.py skins each prop to its bone,
# and the clips key them in the root's frame like everything else. `p_*` bones rest at their prop's pivot.
PROP_BONES = {}


def mirror_x(v):
    return Vector((-v.x, v.y, v.z))


def side_pt(side, p):
    """A right-hand rest point for `side`, relative to that wrist, in rig space."""
    q = Vector(p) if side == 'r' else mirror_x(Vector(p))
    return q + WRIST[side]


def flex_axis(d):
    """The axis a bone pointing along d curls about, so a positive angle bends it toward the palm (-Z)."""
    a = d.normalized().cross(Vector((0, 0, -1)))
    if a.length < 1e-4:
        a = Vector((-1, 0, 0))
    return a.normalized()


def make_armature(name='Rig'):
    arm = bpy.data.armatures.new(name)
    ob = bpy.data.objects.new(name, arm)
    bpy.context.scene.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.edit_bones

    def bone(nm, head, tail, parent=None, deform=True, axis=None, connect=False):
        b = eb.new(nm)
        b.head = Vector(head)
        b.tail = Vector(tail)
        b.use_deform = deform
        if parent:
            b.parent = eb[parent]
            b.use_connect = connect
        d = (b.tail - b.head).normalized()
        a = axis if axis is not None else Vector((1, 0, 0))
        b.align_roll(a.cross(d) if abs(a.cross(d).length) > 1e-5 else Vector((0, 0, 1)))
        return b

    bone('root', (0, -0.02, 0), (0, 0.03, 0), deform=False)
    bone('gun', (0, 0, 0), (0, 0.08, 0), 'root', deform=False)
    for s in ('r', 'l'):
        W = WRIST[s]
        elbow = W - Vector((0, FOREARM, 0))
        sh = elbow - Vector((0, UPPER, 0))
        bone(f'upperarm_{s}', sh, elbow, 'root')
        bone(f'forearm_{s}', elbow, W, f'upperarm_{s}', connect=True)
        bone(f'hand_{s}', W, W + Vector((0, HAND_LEN, 0)), f'forearm_{s}', connect=True)
        for fn in FINGER_NAMES:
            pts = [side_pt(s, p) for p in hm.finger_joints(fn)]
            prev = f'hand_{s}'
            for i in range(3):
                nm = f'{fn}{i + 1}_{s}'
                d = pts[i + 1] - pts[i]
                bone(nm, pts[i], pts[i + 1], prev, axis=flex_axis(d))
                prev = nm
        tp = [side_pt(s, p) for p in hm.thumb_joints()]
        prev = f'hand_{s}'
        for i in range(3):
            nm = f'th{i + 1}_{s}'
            d = tp[i + 1] - tp[i]
            bone(nm, tp[i], tp[i + 1], prev, axis=flex_axis(d))
            prev = nm
        bone(f'ik_{s}', W, W + Vector((0, 0.05, 0)), 'gun', deform=False)
        sgn = 1 if s == 'r' else -1
        pole = W + Vector((sgn * 0.12, -0.34, -0.2))
        bone(f'pole_{s}', pole, pole + Vector((0, 0.05, 0)), 'root', deform=False)
    # which anchor each hand is on, as four weights (location x of one bone each), and the two magazines
    for s in ('r', 'l'):
        for a in ANCHORS:
            bone(f'aw_{s}_{a}', (0, -0.1, 0), (0, -0.05, 0), 'root', deform=False)
    bone('mag_ctl', (0, -0.1, 0.02), (0, -0.05, 0.02), 'root', deform=False)
    bone('drop_ctl', (0, -0.1, 0.04), (0, -0.05, 0.04), 'root', deform=False)
    for nm, (par, head) in PROP_BONES.items():
        h = Vector(head)
        bone(nm, h, h + Vector((0, 0.03, 0)), par or 'root', deform=True)
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in ob.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    return ob


def sleeve_weights(ob, side):
    """Sleeve vertices: forearm below the elbow, upper arm above it, blended over a hand's width."""
    ob.vertex_groups.new(name=f'forearm_{side}')
    ob.vertex_groups.new(name=f'upperarm_{side}')
    fa, ua = ob.vertex_groups[f'forearm_{side}'], ob.vertex_groups[f'upperarm_{side}']
    for v in ob.data.vertices:
        y = v.co.y
        t = hm.smooth(-FOREARM - 0.05, -FOREARM + 0.05, y)       # 1 toward the wrist
        fa.add([v.index], t, 'REPLACE')
        ua.add([v.index], 1 - t, 'REPLACE')


def auto_weights(mesh_ob, arm_ob):
    """Heat-map weights for the glove, then trimmed to the four influences glTF allows."""
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    mesh_ob.select_set(True)
    arm_ob.select_set(True)
    bpy.context.view_layer.objects.active = arm_ob
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')


def limit_weights(ob):
    bpy.context.view_layer.objects.active = ob
    for o in bpy.context.view_layer.objects:
        o.select_set(o is ob)
    bpy.ops.object.mode_set(mode='WEIGHT_PAINT')
    bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)
    bpy.ops.object.mode_set(mode='OBJECT')


# ------------------------------------------------------------------ arm solver

def _bone_dir(pb):
    return (pb.bone.tail_local - pb.bone.head_local).normalized()


def solve_arm(arm_ob, side, ik_pose=None):
    """Aim upper arm, forearm and hand at the ik control (both in armature space) with the elbow toward the pole."""
    pbs = arm_ob.pose.bones
    ik = pbs[f'ik_{side}']
    pole = pbs[f'pole_{side}']
    ua, fa, ha = pbs[f'upperarm_{side}'], pbs[f'forearm_{side}'], pbs[f'hand_{side}']
    for b in (ua, fa, ha):
        b.rotation_quaternion = Quaternion((1, 0, 0, 0))
    bpy.context.view_layer.update()
    S = ua.bone.head_local.copy()
    l1, l2 = UPPER, FOREARM
    T = ik.matrix.translation.copy()
    P = pole.matrix.translation.copy()
    v = T - S
    d = v.length
    d = max(abs(l1 - l2) + 1e-3, min(l1 + l2 - 1e-3, d))
    ax = v.normalized()
    n = P - S
    n -= ax * n.dot(ax)
    if n.length < 1e-5:
        n = Vector((0, 0, -1))
    n.normalize()
    ca = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)
    sa = math.sqrt(max(0.0, 1 - ca * ca))
    E = S + ax * (l1 * ca) + n * (l1 * sa)
    Tc = S + ax * d

    def aim(pb, head, to):
        rest = pb.bone.matrix_local
        q = _bone_dir(pb).rotation_difference((to - head).normalized())
        m3 = q.to_matrix() @ rest.to_3x3()
        m = m3.to_4x4()
        m.translation = head
        pb.matrix = m
        bpy.context.view_layer.update()

    aim(ua, S, E)
    aim(fa, E, Tc)
    # the hand turns with the control: its rest orientation carried by the control's rotation
    hm_ = ik.matrix.to_3x3() @ ik.bone.matrix_local.to_3x3().inverted() @ ha.bone.matrix_local.to_3x3()
    m = hm_.to_4x4()
    m.translation = Tc
    ha.matrix = m
    bpy.context.view_layer.update()


def hand_basis(f, n):
    """Rotation (3x3) that turns the rest hand (fingers +Y, palm -Z) so fingers point f and the palm faces n."""
    y = Vector(f).normalized()
    z = -Vector(n)
    z = (z - y * z.dot(y)).normalized()
    x = y.cross(z)
    return Matrix((x, y, z)).transposed()
