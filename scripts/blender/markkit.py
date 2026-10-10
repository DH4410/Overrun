"""
markkit: stencilled text and flat decals, shared by the detail passes (portdetail.py, arenadetail.py).

Exec'd after the map's own plumbing, so it uses its namespace: poly, Frame, newell, math. Every
shape here is a flat quad in the 'mark' key; text is a 5x7 pixel face merged into runs of quads, so
a word is a few dozen faces. Nothing here emits a collider.
"""
_FONT = {k: v.split('/') for k, v in {
    'A': '01110/10001/10001/11111/10001/10001/10001',
    'B': '11110/10001/10001/11110/10001/10001/11110',
    'C': '01110/10001/10000/10000/10000/10001/01110',
    'D': '11100/10010/10001/10001/10001/10010/11100',
    'E': '11111/10000/10000/11110/10000/10000/11111',
    'F': '11111/10000/10000/11110/10000/10000/10000',
    'G': '01110/10001/10000/10111/10001/10001/01111',
    'H': '10001/10001/10001/11111/10001/10001/10001',
    'I': '01110/00100/00100/00100/00100/00100/01110',
    'J': '00111/00010/00010/00010/00010/10010/01100',
    'K': '10001/10010/10100/11000/10100/10010/10001',
    'L': '10000/10000/10000/10000/10000/10000/11111',
    'M': '10001/11011/10101/10101/10001/10001/10001',
    'N': '10001/11001/10101/10011/10001/10001/10001',
    'O': '01110/10001/10001/10001/10001/10001/01110',
    'P': '11110/10001/10001/11110/10000/10000/10000',
    'Q': '01110/10001/10001/10001/10101/10010/01101',
    'R': '11110/10001/10001/11110/10100/10010/10001',
    'S': '01111/10000/10000/01110/00001/00001/11110',
    'T': '11111/00100/00100/00100/00100/00100/00100',
    'U': '10001/10001/10001/10001/10001/10001/01110',
    'V': '10001/10001/10001/10001/10001/01010/00100',
    'W': '10001/10001/10001/10101/10101/10101/01010',
    'X': '10001/10001/01010/00100/01010/10001/10001',
    'Y': '10001/10001/01010/00100/00100/00100/00100',
    'Z': '11111/00001/00010/00100/01000/10000/11111',
    '0': '01110/10001/10011/10101/11001/10001/01110',
    '1': '00100/01100/00100/00100/00100/00100/01110',
    '2': '01110/10001/00001/00010/00100/01000/11111',
    '3': '11110/00001/00001/01110/00001/00001/11110',
    '4': '00010/00110/01010/10010/11111/00010/00010',
    '5': '11111/10000/11110/00001/00001/10001/01110',
    '6': '00110/01000/10000/11110/10001/10001/01110',
    '7': '11111/00001/00010/00100/01000/01000/01000',
    '8': '01110/10001/10001/01110/10001/10001/01110',
    '9': '01110/10001/10001/01111/00001/00010/01100',
    '-': '00000/00000/00000/11111/00000/00000/00000',
    '!': '00100/00100/00100/00100/00100/00000/00100',
    '.': '00000/00000/00000/00000/00000/01100/01100',
    ':': '00000/01100/01100/00000/01100/01100/00000',
    '/': '00001/00001/00010/00100/01000/10000/10000',
    '>': '10000/01000/00100/00010/00100/01000/10000',
    '<': '00001/00010/00100/01000/00100/00010/00001',
    '+': '00000/00100/00100/11111/00100/00100/00000',
}.items()}


def turn(fr, d):
    """The same origin, turned d radians about the vertical: another face of the same box."""
    return Frame(fr.o[0], fr.o[1], fr.o[2], fr.yaw + d)


def rect(fr, u0, y0, u1, y1, z, tint, key='mark'):
    poly(key, fr, [(u0, y0, z), (u1, y0, z), (u1, y1, z), (u0, y1, z)], tint)


def upoly(fr, pts, tint, key='mark'):
    """A decal on a surface that faces up (a floor, a ramp), wound whichever way that needs."""
    if newell(pts)[1] < 0:
        pts = pts[::-1]
    poly(key, fr, pts, tint)


def _runs(text, ph):
    """Pixel runs of a string in the 5x7 face, in metres: (u0, v0, u1, v1), centred on u = 0."""
    px = ph / 7.0
    text = text.upper()
    total = (len(text) * 6 - 1) * px
    out = []
    for row in range(7):
        v0 = (6 - row) * px
        for ci, ch in enumerate(text):
            g = _FONT.get(ch)
            if g is None:
                continue
            start = None
            for col in range(6):
                on = col < 5 and g[row][col] == '1'
                if on and start is None:
                    start = col
                elif not on and start is not None:
                    out.append((-total / 2 + (ci * 6 + start) * px, v0, -total / 2 + (ci * 6 + col) * px, v0 + px))
                    start = None
    return out


def text_w(text, ph):
    return (len(text) * 6 - 1) * ph / 7.0


def label(fr, u, y, z, text, ph, tint):
    """Stencilled text on a vertical face: centred on local x = u, baseline at y, z off the surface."""
    for u0, v0, u1, v1 in _runs(text, ph):
        rect(fr, u + u0, y + v0, u + u1, y + v1, z, tint)


def floor_label(fr, text, ph, tint):
    """Text painted on a floor: reads along the frame's x, its top toward the frame's -z."""
    for u0, v0, u1, v1 in _runs(text, ph):
        poly('mark', fr, [(u0, 0.0, -v0), (u1, 0.0, -v0), (u1, 0.0, -v1), (u0, 0.0, -v1)], tint)
