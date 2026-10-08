"""
roundkit_dh: rounded primitives, smooth normals and surface wear for the Blender map scripts.

Exec it into a map script's namespace AFTER the piece kit (mapkit.py, or build_port.py's own
copy of it) and after the script has set its configuration:

    RK_ROUND = {'wall': 0.06, ...}   # key -> largest edge radius for vbox/solid (metres)
    RK_ROUND_DEFAULT = 0.04          # keys not listed
    RK_PLAIN = {'far', 'lamp'}       # keys whose boxes stay sharp
    RK_WEAR = {'wall': (0.3, 0.1)}   # key -> (dirt at the foot, patchiness): vertex colours
    exec(open(REPO + '/scripts/blender/roundkit_dh.py').read())

It then replaces vbox() with a version that rounds the edges of the boxes it emits (so every
solid(), crate(), container() ... of the kit gets soft edges without being rewritten), and adds:

    rbox     a box with rounded edges and the analytic normals of a rounded box
    lathe    a profile revolved about the vertical axis: barrels, bollards, domes, tyres, poles
    tube     a circle swept along a path: pipes, cables, hoses, curved trunks
    rprism   prism() with smooth normals round the profile
    smooth   one polygon with a normal per corner

and two calls for the build: rk_finalize() at the end of the layout (wear colours, custom
normals read out of the buckets) and rk_apply(objs) once the meshes exist.

What stays fixed: nothing here emits a collider and every rounded box sits INSIDE the box it
replaces, so the collider tables, and with them the multiplayer map hash, do not change.

Vertices: every vertex of a rounded box has its own normal and a UV projected from that normal,
so neighbouring faces share their vertices when the glTF exporter merges identical ones. A
rounded box costs the same 24 vertices as a plain one (48 with two segments), only more
triangles.
"""
import math
import os

import bmesh

RK_ROUND = globals().get('RK_ROUND', {})
RK_ROUND_DEFAULT = globals().get('RK_ROUND_DEFAULT', 0.04)
RK_PLAIN = set(globals().get('RK_PLAIN', ()))
RK_WEAR = globals().get('RK_WEAR', {})
RK_CELL = globals().get('RK_CELL', 5.0)         # wear patches: metres between cuts
RK_COUNT = {'rbox': 0, 'plain': 0}
SMOOTH = globals().get('SMOOTH', set())      # keys the kit welds and smooths itself


# ------------------------------------------------------------------ small maths

def _norm(v):
    l = math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    if l < 1e-9:
        return (0.0, 1.0, 0.0)
    # + 0.0 turns -0.0 into 0.0: the exporter merges vertices by their bytes, which differ
    return (v[0] / l + 0.0, v[1] / l + 0.0, v[2] / l + 0.0)


def _rot(frame, v):
    """A direction from a frame's local axes into the world (yaw about +Y only)."""
    x, y, z = v
    return (x * frame.c + z * frame.s, y, -x * frame.s + z * frame.c)


def _proj(frame, p, n):
    """Box-projected UV in metres for local point p on a surface whose local normal is n."""
    x, y, z = frame.uvbase(p)
    ax, ay, az = abs(n[0]), abs(n[1]), abs(n[2])
    if ay >= ax and ay >= az:
        return (x, -z) if n[1] > 0 else (x, z)
    if ax >= az:
        return (-z, y) if n[0] > 0 else (z, y)
    return (x, y) if n[2] > 0 else (-x, y)


# ------------------------------------------------------------------ buckets carry normals

_init0 = Bucket.__init__


def _bucket_init(self, key):
    _init0(self, key)
    bm = getattr(self, 'bm', None)
    self.nl = bm.loops.layers.float_vector.new('nrm') if bm is not None else None
    self.rk_normals = None


def _bucket_face(self, pts, uvs, tint, normals=None):
    STATS['faces'] += 1
    if getattr(self, 'bm', None) is None:
        return
    vs = [self.bm.verts.new((p[0], -p[2], p[1])) for p in pts]
    f = self.bm.faces.new(vs)
    if normals is None:
        flat = _norm(newell(pts))
        normals = [flat] * len(pts)
    for loop, (u, v), nv in zip(f.loops, uvs, normals):
        # glTF export flips V; pre-flipping keeps V pointing up the wall in three.js
        loop[self.uv].uv = (u / self.tile, -v / self.tile)
        if self.col is not None:
            loop[self.col] = (tint[0], tint[1], tint[2], 1.0)
        loop[self.nl] = (nv[0], -nv[2], nv[1])


Bucket.__init__ = _bucket_init
Bucket.face = _bucket_face


def smooth(key, frame, pts, nrms, uvs=None, tint=WHITE):
    """One polygon with a normal per corner (local frame), wound to agree with them. Without
    uvs each corner is projected along its own normal, so neighbours share vertices."""
    nx, ny, nz = newell(pts)
    if nx * sum(n[0] for n in nrms) + ny * sum(n[1] for n in nrms) + nz * sum(n[2] for n in nrms) < 0:
        pts, nrms = pts[::-1], nrms[::-1]
        uvs = uvs[::-1] if uvs else None
    if uvs is None:
        uvs = [_proj(frame, p, n) for p, n in zip(pts, nrms)]
    bucket(key).face([frame.world(p) for p in pts], uvs, tint, [_rot(frame, n) for n in nrms])


# ------------------------------------------------------------------ rounded box

_TRI2 = (((2, 0, 0), (1, 1, 0), (1, 0, 1)), ((1, 1, 0), (0, 2, 0), (0, 1, 1)),
         ((1, 0, 1), (0, 1, 1), (0, 0, 2)), ((1, 1, 0), (0, 1, 1), (1, 0, 1)))
_TRI1 = (((1, 0, 0), (0, 1, 0), (0, 0, 1)),)


def rbox(key, frame, cx, cy, cz, w, h, d, r, tint=WHITE, skip=('-y',), n=None):
    """A box whose edges and corners are rounded with radius r (n = 1 or 2 segments). The
    surface lies inside the plain box. Faces named in skip lose only their flat middle."""
    hw, hh, hd = w / 2, h / 2, d / 2
    r = min(r, 0.45 * min(hw, hh, hd))
    if n is None:
        n = 2 if r >= 0.075 else 1
    half = (hw - r, hh - r, hd - r)
    c0 = (cx, cy, cz)

    def P(s, a):
        dv = _norm((s[0] * a[0], s[1] * a[1], s[2] * a[2]))
        return (c0[0] + s[0] * half[0] + r * dv[0], c0[1] + s[1] * half[1] + r * dv[1],
                c0[2] + s[2] * half[2] + r * dv[2]), dv

    def emit(items):
        smooth(key, frame, [p for p, _ in items], [v for _, v in items], tint=tint)

    for i in range(3):
        j, k = [q for q in range(3) if q != i]
        for sg in (-1, 1):
            if ('+' if sg > 0 else '-') + 'xyz'[i] in skip:
                continue
            a = [0, 0, 0]
            a[i] = n
            quad = []
            for sj, sk in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                s = [0, 0, 0]
                s[i], s[j], s[k] = sg, sj, sk
                quad.append(P(s, a))
            emit(quad)
    for e in range(3):
        i, j = [q for q in range(3) if q != e]
        for si in (-1, 1):
            for sj in (-1, 1):
                for step in range(n):
                    a0, a1 = [0, 0, 0], [0, 0, 0]
                    a0[i], a0[j] = n - step, step
                    a1[i], a1[j] = n - step - 1, step + 1
                    quad = []
                    for se, aa in ((-1, a0), (-1, a1), (1, a1), (1, a0)):
                        s = [0, 0, 0]
                        s[i], s[j], s[e] = si, sj, se
                        quad.append(P(s, aa))
                    emit(quad)
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                for tri in (_TRI2 if n == 2 else _TRI1):
                    emit([P((sx, sy, sz), a) for a in tri])
    RK_COUNT['rbox'] += 1


_vbox0 = vbox


def vbox(key, frame, cx, cy, cz, w, h, d, tint=WHITE, skip=('-y',)):
    """The kit's visual box, with rounded edges where the box is thick enough to show them."""
    r = min(RK_ROUND.get(key, RK_ROUND_DEFAULT), min(w, h, d) * 0.3)
    if key in RK_PLAIN or r < 0.012:
        RK_COUNT['plain'] += 1
        return _vbox0(key, frame, cx, cy, cz, w, h, d, tint, skip)
    return rbox(key, frame, cx, cy, cz, w, h, d, r, tint, skip)


# ------------------------------------------------------------------ lathe and tube

def lathe(key, frame, cx, cz, prof, n=14, tint=WHITE, sharp=50.0, caps=(False, False), phase=0.0, ax='y'):
    """Revolve a profile of (radius, y) points, bottom to top, about the vertical line through
    local (cx, cz). Turns gentler than `sharp` degrees are smooth, sharper ones stay creased.
    A radius of 0 at an end makes a pole. caps = (bottom, top) adds flat discs at the ends.
    ax = 'x' or 'z' lays the axis along that local axis instead (the point (cx, y, cz) of the
    upright profile becomes (y, cx, cz) for 'x', and (cx, cz, y) for 'z')."""
    sw = {'y': lambda v: v, 'x': lambda v: (v[1], v[0], v[2]), 'z': lambda v: (v[0], v[2], v[1])}[ax]
    m = len(prof)
    segs = []
    for i in range(m - 1):
        (r0, y0), (r1, y1) = prof[i], prof[i + 1]
        dr, dy = r1 - r0, y1 - y0
        L = math.hypot(dr, dy)
        segs.append((dy / L, -dr / L) if L > 1e-9 else None)
    cs = math.cos(math.radians(sharp))
    closed = math.dist(prof[0], prof[-1]) < 1e-9

    def pn(i, si):
        """Profile normal at point i as seen from segment si."""
        r = prof[i][0]
        if r < 1e-6:
            return (0.0, -1.0) if i == 0 else (0.0, 1.0)
        s = segs[si]
        a = b = None
        if 0 < i < m - 1 and segs[i - 1] and segs[i]:
            a, b = segs[i - 1], segs[i]
        elif closed and i in (0, m - 1) and segs[m - 2] and segs[0]:
            a, b = segs[m - 2], segs[0]
        if a:
            if a[0] * b[0] + a[1] * b[1] >= cs:
                v = (a[0] + b[0], a[1] + b[1])
                l = math.hypot(*v)
                return (v[0] / l, v[1] / l)
        return s

    rref = max(p[0] for p in prof)
    ang = [phase + 2 * math.pi * k / n for k in range(n + 1)]
    vacc = [0.0]
    for i in range(m - 1):
        vacc.append(vacc[-1] + math.hypot(prof[i + 1][0] - prof[i][0], prof[i + 1][1] - prof[i][1]))

    def vert(i, k, nn):
        r, y = prof[i]
        c, s = math.cos(ang[k]), math.sin(ang[k])
        return ((cx + r * c, y, cz + r * s), (nn[0] * c, nn[1], nn[0] * s),
                (2 * math.pi * rref * k / n, vacc[i]))

    for i in range(m - 1):
        if segs[i] is None:
            continue
        na, nb = pn(i, i), pn(i + 1, i)
        for k in range(n):
            q = [vert(i, k, na), vert(i, k + 1, na), vert(i + 1, k + 1, nb), vert(i + 1, k, nb)]
            if prof[i][0] < 1e-6:
                q = [q[0], q[2], q[3]]
            elif prof[i + 1][0] < 1e-6:
                q = [q[0], q[1], q[2]]
            smooth(key, frame, [sw(p) for p, _, _ in q], [sw(v) for _, v, _ in q], [u for _, _, u in q], tint)
    for end, on in zip((0, m - 1), caps):
        if on and prof[end][0] > 1e-6:
            r, y = prof[end]
            ny = -1.0 if end == 0 else 1.0
            ring_ = [sw((cx + r * math.cos(a), y, cz + r * math.sin(a))) for a in ang[:n]]
            smooth(key, frame, ring_, [sw((0.0, ny, 0.0))] * n, tint=tint)


def torus(key, frame, cx, cy, cz, R, r, ax='y', n=14, m=8, tint=WHITE):
    """A ring of tube radius r round a circle of radius R, its axis along local x, y or z."""
    prof = [(R + r * math.cos(math.radians(-90 + 360 * i / m)), r * math.sin(math.radians(-90 + 360 * i / m)))
            for i in range(m + 1)]
    off = {'y': (cx, cz), 'x': (cy, cz), 'z': (cx, cy)}[ax]
    base = {'y': cy, 'x': cx, 'z': cz}[ax]
    lathe(key, frame, off[0], off[1], [(rr, yy + base) for rr, yy in prof], n, tint, sharp=80.0, ax=ax)


def wheel(key, frame, cx, cy, cz, R, width, ax='x', n=16, tint=WHITE, hub=0.45):
    """A solid wheel with a rounded tread, its axis along local x, y or z."""
    w2 = width / 2
    c = min(0.04, w2 * 0.8)
    prof = [(0.0, -w2), (R * hub, -w2), (R - c, -w2), (R, -w2 + c), (R, w2 - c), (R - c, w2), (R * hub, w2), (0.0, w2)]
    off = {'y': (cx, cz), 'x': (cy, cz), 'z': (cx, cy)}[ax]
    base = {'y': cy, 'x': cx, 'z': cz}[ax]
    lathe(key, frame, off[0], off[1], [(rr, yy + base) for rr, yy in prof], n, tint, sharp=50.0, ax=ax)


def tube(key, frame, path, r, n=8, tint=WHITE, caps=True, uv_scale=1.0):
    """Sweep a circle of radius r (a number, or one radius per path point) along local points."""
    m = len(path)
    rs = r if isinstance(r, (list, tuple)) else [r] * m
    tans = []
    for i in range(m):
        a = path[max(0, i - 1)]
        b = path[min(m - 1, i + 1)]
        tans.append(_norm((b[0] - a[0], b[1] - a[1], b[2] - a[2])))
    ref = (0.0, 1.0, 0.0) if abs(tans[0][1]) < 0.9 else (1.0, 0.0, 0.0)
    nv = ref
    rings = []
    dist = 0.0
    for i in range(m):
        t = tans[i]
        d = nv[0] * t[0] + nv[1] * t[1] + nv[2] * t[2]
        nv = _norm((nv[0] - t[0] * d, nv[1] - t[1] * d, nv[2] - t[2] * d))
        bv = (t[1] * nv[2] - t[2] * nv[1], t[2] * nv[0] - t[0] * nv[2], t[0] * nv[1] - t[1] * nv[0])
        if i:
            dist += math.dist(path[i], path[i - 1])
        ring_ = []
        for k in range(n + 1):
            a = 2 * math.pi * k / n
            dirv = (math.cos(a) * nv[0] + math.sin(a) * bv[0], math.cos(a) * nv[1] + math.sin(a) * bv[1],
                    math.cos(a) * nv[2] + math.sin(a) * bv[2])
            ring_.append(((path[i][0] + rs[i] * dirv[0], path[i][1] + rs[i] * dirv[1], path[i][2] + rs[i] * dirv[2]),
                          dirv, (dist * uv_scale, 2 * math.pi * rs[i] * k / n)))
        rings.append(ring_)
    for i in range(m - 1):
        for k in range(n):
            q = [rings[i][k], rings[i][k + 1], rings[i + 1][k + 1], rings[i + 1][k]]
            smooth(key, frame, [p for p, _, _ in q], [v for _, v, _ in q], [u for _, _, u in q], tint)
    if caps:
        for i, sg in ((0, -1.0), (m - 1, 1.0)):
            t = tans[i]
            nrm = (t[0] * sg, t[1] * sg, t[2] * sg)
            smooth(key, frame, [p for p, _, _ in rings[i][:n]], [nrm] * n, tint=tint)


def rprism(key, frame, profile, z0, z1, tint=WHITE, sharp=60.0, caps=True):
    """prism() with smooth normals round the profile where a turn is gentler than `sharp` degrees."""
    cs = math.cos(math.radians(sharp))
    m = len(profile)
    en = []
    for i in range(m):
        (xa, ya), (xb, yb) = profile[i], profile[(i + 1) % m]
        dx, dy = xb - xa, yb - ya
        L = math.hypot(dx, dy)
        en.append((dy / L, -dx / L) if L > 1e-9 else (0.0, 0.0))

    def vn(i, e):
        a, b = en[(i - 1) % m], en[i]
        if a[0] * b[0] + a[1] * b[1] >= cs:
            v = (a[0] + b[0], a[1] + b[1])
            l = math.hypot(*v)
            return (v[0] / l, v[1] / l)
        return en[e]

    for i in range(m):
        j = (i + 1) % m
        (xa, ya), (xb, yb) = profile[i], profile[j]
        if en[i] == (0.0, 0.0):
            continue
        na, nb = vn(i, i), vn(j, i)
        pts = [(xa, ya, z0), (xb, yb, z0), (xb, yb, z1), (xa, ya, z1)]
        nrms = [(na[0], na[1], 0.0), (nb[0], nb[1], 0.0), (nb[0], nb[1], 0.0), (na[0], na[1], 0.0)]
        fn = (en[i][0], en[i][1], 0.0)
        smooth(key, frame, pts, nrms, [_proj(frame, p, fn) for p in pts], tint)
    if caps:
        poly(key, frame, [(x, y, z1) for x, y in profile], tint)
        poly(key, frame, [(x, y, z0) for x, y in reversed(profile)], tint)


def rsolid(key, frame, cx, cy, cz, w, h, d, r, tint=WHITE, skip=('-y',), block=1):
    """solid() with an explicit edge radius."""
    rbox(key, frame, cx, cy, cz, w, h, d, r, tint, skip)
    collider(frame, cx, cy, cz, w, h, d, block)


# ------------------------------------------------------------------ wear (vertex colours)

def _hash3(i, j, k):
    h = (i * 374761393 + j * 668265263 + k * 1442695041) & 0xffffffff
    h = ((h ^ (h >> 13)) * 1274126177) & 0xffffffff
    return ((h ^ (h >> 16)) & 0xffff) / 65535.0


def _vnoise(x, y, z):
    i, j, k = math.floor(x), math.floor(y), math.floor(z)
    fx, fy, fz = x - i, y - j, z - k
    fx, fy, fz = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy), fz * fz * (3 - 2 * fz)
    out = 0.0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                wgt = (fx if dx else 1 - fx) * (fy if dy else 1 - fy) * (fz if dz else 1 - fz)
                out += wgt * _hash3(i + dx, j + dy, k + dz)
    return out


def _wear(b, key):
    """Cut the bucket on a coarse grid and a few heights, then darken the vertices: dirt that
    gathers at the foot of everything, and soft patches that break up long clean walls."""
    cfg = RK_WEAR[key]
    dirt, var = cfg[:2]
    cut = len(cfg) > 2 and cfg[2]
    bm = b.bm
    xs = [v.co.x for v in bm.verts]
    ys = [v.co.y for v in bm.verts]
    if not xs:
        return
    planes = []
    if cut:
        for h in (0.35, 1.1):
            planes.append(((0, 0, h), (0, 0, 1)))
        if max(xs) - min(xs) > RK_CELL:
            for q in range(int(math.floor(min(xs) / RK_CELL)) + 1, int(math.floor(max(xs) / RK_CELL)) + 1):
                planes.append(((q * RK_CELL, 0, 0), (1, 0, 0)))
        if max(ys) - min(ys) > RK_CELL:
            for q in range(int(math.floor(min(ys) / RK_CELL)) + 1, int(math.floor(max(ys) / RK_CELL)) + 1):
                planes.append(((0, q * RK_CELL, 0), (0, 1, 0)))
    for co, no in planes:
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=co, plane_no=no)
    for f in bm.faces:
        for l in f.loops:
            c = l.vert.co
            t = min(1.0, max(0.0, c.z / 1.1))
            foot = 1.0 - dirt * (1.0 - t * t * (3 - 2 * t))
            patch = 1.0 - var * _vnoise(c.x / RK_CELL, c.y / RK_CELL, c.z / 3.0)
            base = l[b.col]
            k = foot * patch
            l[b.col] = (base[0] * k, base[1] * k, base[2] * k, 1.0)


def rk_finalize():
    """Call once when the layout is done and before the meshes are made."""
    for key, b in BUCKETS.items():
        if getattr(b, 'bm', None) is None:
            continue
        if key in RK_WEAR and b.col is not None:
            _wear(b, key)
        if key in SMOOTH:
            b.rk_normals = None
        else:
            # The exporter merges loops only when they sit on the same mesh vertex, so weld the
            # corners: loops keep their own normal and UV, and a rounded box exports 24 vertices.
            bmesh.ops.remove_doubles(b.bm, verts=b.bm.verts[:], dist=1e-5)
            b.rk_normals = [_norm(l[b.nl]) for f in b.bm.faces for l in f.loops]


def rk_quantize(path):
    """Shrink the exported GLB (scripts/glbquant.mjs) when node is on the path."""
    import subprocess
    try:
        subprocess.run(['node', os.path.join(REPO, 'scripts', 'glbquant.mjs'), path], check=True)
    except (OSError, subprocess.CalledProcessError) as e:
        print('roundkit: GLB left unquantized:', e)


def rk_apply(objs):
    """Give each bucket mesh its custom normals. Call after the meshes exist, before export."""
    done = 0
    for ob in objs:
        key = ob.name.split('_', 1)[1] if '_' in ob.name else ob.name
        b = BUCKETS.get(key)
        if b is None or b.rk_normals is None:
            continue
        mesh = ob.data
        if len(mesh.loops) != len(b.rk_normals):
            print('roundkit: loop count mismatch on', ob.name, len(mesh.loops), len(b.rk_normals))
            continue
        mesh.shade_smooth()
        mesh.normals_split_custom_set(b.rk_normals)
        done += 1
    return done
