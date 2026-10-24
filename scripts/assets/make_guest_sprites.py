"""Build apps/web/public/assets/kenney/guests.png: 10 customer variants.

The Kenney RPG Urban Pack (CC0) has 6 characters and the dashboard uses 4 of
them for staff, so customers are made by recolouring clothing pixels of the
6 bases (hue/saturation swapped, brightness kept so shading survives).

Layout: one row per guest, 12 frames of 16x16 per row:
  frame = anim * 4 + dir, dir in (left, down, up, right), anim in (idle, walk1, walk2).
Run: python3 scripts/assets/make_guest_sprites.py  (needs Pillow)
"""
import colorsys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / 'apps/web/public/assets/kenney'
SHEET = Image.open(ASSETS / 'rpg-urban.png').convert('RGBA')
COLS = 27  # frames per row in the source sheet

# First frame (left, idle) of each base character in rpg-urban.png.
BASE = {'boy': 23, 'girl': 104, 'bluehair': 185, 'hardhat': 266, 'bald': 347, 'headband': 428}
# Clothing colours per base that may be recoloured.
SHIRT = {
    'boy': ['#42a379', '#369069'], 'girl': ['#c2504d', '#a54240'], 'bluehair': ['#42a379', '#369069'],
    'bald': ['#aaa8bd', '#898ca6'], 'headband': ['#c77b47', '#a9673b'], 'hardhat': [],
}
PANTS = {'boy': ['#d6d4aa', '#c5b993'], 'hardhat': ['#918eb9', '#7a77a4']}

# Guest kinds a–j, in row order: (base, shirt (hue°, sat) or None, pants (hue°, sat) or None)
GUESTS = [
    ('hardhat', None, None), ('bald', None, None), ('hardhat', None, (175, 0.45)),
    ('bald', (120, 0.45), None), ('boy', (280, 0.5), None), ('girl', (185, 0.55), None),
    ('bluehair', (28, 0.65), None), ('headband', (215, 0.55), None), ('bald', (0, 0.55), None),
    ('boy', (48, 0.7), (220, 0.3)),
]


def hex_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def recolour(tile, colours, target):
    if not target:
        return tile
    hue, sat = target
    wanted = {hex_rgb(c) for c in colours}
    px = tile.load()
    for y in range(tile.height):
        for x in range(tile.width):
            r, g, b, a = px[x, y]
            if a and (r, g, b) in wanted:
                _, _, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
                nr, ng, nb = colorsys.hsv_to_rgb(hue / 360, sat, v)
                px[x, y] = (round(nr * 255), round(ng * 255), round(nb * 255), a)
    return tile


out = Image.new('RGBA', (12 * 16, len(GUESTS) * 16), (0, 0, 0, 0))
for row, (base, shirt, pants) in enumerate(GUESTS):
    for anim in range(3):
        for d in range(4):
            idx = BASE[base] + anim * COLS + d
            r, c = divmod(idx, COLS)
            tile = SHEET.crop((c * 16, r * 16, c * 16 + 16, r * 16 + 16))
            tile = recolour(tile, SHIRT.get(base, []), shirt)
            tile = recolour(tile, PANTS.get(base, []), pants)
            out.alpha_composite(tile, ((anim * 4 + d) * 16, row * 16))
out.save(ASSETS / 'guests.png')
print('wrote', ASSETS / 'guests.png', out.size)
