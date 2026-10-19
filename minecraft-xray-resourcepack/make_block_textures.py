#!/usr/bin/env python3
"""Bake recognisable animated textures for every block family.

The pack puts ONE video on every block, which makes blocks impossible to
tell apart.  This script keeps the video (and its sound, untouched) but
bakes a per-family identity into each animated strip:

  * the video frames, darkened and tinted towards the family colour, so
    the clip still plays on every face;
  * a coloured frame around the face (fast colour cue while mining);
  * a 16x16 pixel-art badge in the centre (shape cue: gems for ores,
    planks for wood, a latch for chests, ...).

Outputs (into assets/ next to this script):
  families/<key>.png           animated strip, 32x32 per frame
  families.json                block id -> family key + render specs
  anime_girl_water.png         baked water strip (video + blue + droplet)
  anime_girl_lava.png          baked lava strip (video + orange + flame)

build.py then packages everything; it needs neither Pillow nor ffmpeg.
Regenerate after editing the family table:

  python3 make_block_textures.py && python3 build.py

Requires Pillow (`pip install pillow`).
"""

from __future__ import annotations

import json
import random
import re
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
FAM_DIR = ASSETS / "families"
SOURCE_STRIP = ASSETS / "anime_girl.png"
FAMILIES_JSON = ASSETS / "families.json"

SIZE_HI = 32         # pixels per frame for common blocks (badge x2)
SIZE_LO = 16         # pixels per frame for the long tail (badge 1:1)
ICON = 16            # badge grid
HI_FRAMES = 149      # common blocks: 10 fps (frametime 2)
LO_FRAMES = 75       # everything else: 5 fps (frametime 4)
HI_FRAMETIME = 2
LO_FRAMETIME = 4
FLUID_FRAMETIME = 2

# video background: brightness, mix towards family tint, posterise levels
LUM = 0.78
MIX = 0.25
LEVELS = 7


# --------------------------------------------------------------------------
# pixel drawing helpers (all work on a 16x16 RGBA badge)
# --------------------------------------------------------------------------
def new_icon() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    im = Image.new("RGBA", (ICON, ICON), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)


def outline(icon: Image.Image, color=(10, 8, 12, 255)) -> Image.Image:
    base = icon.load()
    out = icon.copy()
    po = out.load()
    for y in range(ICON):
        for x in range(ICON):
            if base[x, y][3] == 0:
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < ICON and 0 <= ny < ICON and base[nx, ny][3] > 0:
                        po[x, y] = color
                        break
    return out


def shade(c, f):
    return tuple(max(0, min(255, int(v * f))) for v in c[:3])


def light(c, f=1.35):
    return shade(c, f)


# --------------------------------------------------------------------------
# badge glyphs
# --------------------------------------------------------------------------
def g_ore(gem):
    im, d = new_icon()
    for cx, cy, r in ((5, 5, 2), (10, 6, 2), (7, 10, 2), (11, 11, 1)):
        d.polygon([(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)],
                  fill=gem + (255,))
        d.point((cx, cy - 1), fill=(255, 255, 255, 255))
    return im


def g_ingot(metal):
    im, d = new_icon()
    d.polygon([(4, 6), (12, 6), (13, 8), (3, 8)], fill=metal + (255,))
    d.polygon([(4, 9), (12, 9), (13, 11), (3, 11)], fill=shade(metal, 0.85) + (255,))
    d.line([(5, 6), (11, 6)], fill=light(metal) + (255,))
    d.line([(5, 9), (11, 9)], fill=light(metal, 1.15) + (255,))
    return im


def g_chunk(color):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=shade(color, 0.8) + (255,))
    for x, y in ((4, 4), (8, 4), (6, 7), (10, 8), (4, 9), (8, 10)):
        d.rectangle([x, y, x + 2, y + 2], fill=color + (255,))
        d.point((x, y), fill=light(color) + (255,))
    return im


def g_planks(c):
    im, d = new_icon()
    d.rectangle([3, 4, 12, 11], fill=c + (255,))
    d.line([(3, 6), (12, 6)], fill=shade(c, 0.6) + (255,))
    d.line([(3, 9), (12, 9)], fill=shade(c, 0.6) + (255,))
    d.point((8, 5), fill=shade(c, 0.6) + (255,))
    d.point((5, 8), fill=shade(c, 0.6) + (255,))
    d.point((10, 10), fill=shade(c, 0.6) + (255,))
    d.line([(3, 4), (12, 4)], fill=light(c) + (255,))
    return im


def g_log(c, bark):
    im, d = new_icon()
    d.rectangle([4, 3, 11, 12], fill=bark + (255,))
    for x in (5, 8, 10):
        d.line([(x, 3), (x, 12)], fill=shade(bark, 0.7) + (255,))
    d.line([(4, 3), (11, 3)], fill=c + (255,))
    d.point((7, 3), fill=shade(c, 0.7) + (255,))
    d.point((9, 3), fill=shade(c, 0.7) + (255,))
    return im


def g_leaves(c):
    im, d = new_icon()
    rnd = random.Random(11)
    d.rectangle([3, 3, 12, 12], fill=c + (255,))
    for _ in range(16):
        x, y = rnd.randint(3, 12), rnd.randint(3, 12)
        d.point((x, y), fill=shade(c, 0.65) + (255,))
    for _ in range(8):
        x, y = rnd.randint(3, 12), rnd.randint(3, 12)
        d.point((x, y), fill=light(c, 1.2) + (255,))
    for x, y in ((5, 5), (10, 9)):
        d.point((x, y), fill=(0, 0, 0, 0))
    return im


def g_speckle(base, spot, n=14):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=base + (255,))
    rnd = random.Random(hash((base, spot)) % 9999)
    for _ in range(n):
        x, y = rnd.randint(3, 12), rnd.randint(3, 12)
        d.point((x, y), fill=spot + (255,))
    d.line([(3, 3), (12, 3)], fill=light(base, 1.15) + (255,))
    return im


def g_bricks(c, mortar):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=mortar + (255,))
    for row, y in enumerate((3, 6, 9)):
        off = 2 if row % 2 else 0
        for x in range(3 + off, 13, 5):
            d.rectangle([x, y + 1, min(x + 3, 12), y + 2], fill=c + (255,))
    return im


def g_flat(c):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=c + (255,))
    d.line([(3, 3), (12, 3)], fill=light(c) + (255,))
    d.line([(3, 12), (12, 12)], fill=shade(c, 0.7) + (255,))
    return im


def g_wool(c):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=c + (255,))
    for y in (5, 8, 11):
        for x in range(3, 12, 2):
            d.point((x, y), fill=shade(c, 0.8) + (255,))
            d.point((x + 1, y - 1), fill=light(c, 1.12) + (255,))
    return im


def g_carpet(c):
    im, d = new_icon()
    d.rectangle([3, 8, 12, 11], fill=c + (255,))
    d.line([(3, 8), (12, 8)], fill=light(c) + (255,))
    for x in range(3, 13, 3):
        d.point((x, 11), fill=shade(c, 0.7) + (255,))
    return im


def g_powder(c):
    im, d = new_icon()
    d.rectangle([3, 4, 12, 12], fill=c + (255,))
    rnd = random.Random(4)
    for _ in range(18):
        x, y = rnd.randint(3, 12), rnd.randint(4, 12)
        d.point((x, y), fill=shade(c, 0.82) + (255,))
    for x in (4, 7, 10):
        d.point((x, 4), fill=light(c) + (255,))
    return im


def g_glazed(c):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=c + (255,))
    d.arc([4, 4, 11, 11], 0, 270, fill=light(c) + (255,))
    d.point((7, 7), fill=shade(c, 0.6) + (255,))
    d.point((8, 8), fill=shade(c, 0.6) + (255,))
    return im


def g_glass(c):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], outline=c + (255,))
    d.line([(5, 10), (10, 5)], fill=(255, 255, 255, 200))
    d.line([(6, 11), (11, 6)], fill=(255, 255, 255, 120))
    return im


def g_chest(c, latch=(240, 220, 80)):
    im, d = new_icon()
    d.rectangle([3, 4, 12, 12], fill=c + (255,))
    d.line([(3, 7), (12, 7)], fill=shade(c, 0.55) + (255,))
    d.rectangle([7, 6, 8, 8], fill=latch + (255,))
    d.line([(3, 4), (12, 4)], fill=light(c) + (255,))
    return im


def g_furnace(c, fire=(250, 160, 50)):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=c + (255,))
    d.rectangle([6, 7, 9, 11], fill=(30, 26, 26, 255))
    d.point((7, 10), fill=fire + (255,))
    d.point((8, 9), fill=light(fire) + (255,))
    d.point((7, 9), fill=shade(fire, 0.8) + (255,))
    d.line([(3, 3), (12, 3)], fill=light(c) + (255,))
    return im


def g_craft(c):
    im, d = new_icon()
    d.rectangle([3, 4, 12, 12], fill=c + (255,))
    d.rectangle([4, 3, 11, 5], fill=light(c, 1.1) + (255,))
    for x in (6, 9):
        d.line([(x, 3), (x, 5)], fill=shade(c, 0.55) + (255,))
    for y in (7, 10):
        d.line([(4, y), (11, y)], fill=shade(c, 0.65) + (255,))
    for x in (6, 9):
        d.line([(x, 6), (x, 12)], fill=shade(c, 0.65) + (255,))
    return im


def g_bookshelf(c, spines=((150, 60, 60), (60, 60, 130), (70, 110, 70),
                           (140, 120, 60), (90, 60, 120))):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=c + (255,))
    for row, y in ((4, 4), (9, 9)):
        x = 4
        i = row
        while x < 12:
            w = 2 if i % 2 else 1
            col = spines[(x + row) % len(spines)]
            d.rectangle([x, y, min(x + w - 1, 11), y + 3], fill=col + (255,))
            x += w
            i += 1
    d.line([(3, 8), (12, 8)], fill=shade(c, 0.5) + (255,))
    return im


def g_tnt():
    im, d = new_icon()
    d.rectangle([3, 4, 12, 12], fill=(200, 60, 50, 255))
    d.rectangle([3, 7, 12, 9], fill=(235, 225, 215, 255))
    d.rectangle([6, 7, 9, 9], fill=(160, 40, 35, 255))
    d.point((7, 8), fill=(255, 255, 255, 255))
    d.point((8, 8), fill=(255, 255, 255, 255))
    d.line([(7, 4), (8, 3)], fill=(60, 60, 60, 255))
    return im


def g_anvil(c):
    im, d = new_icon()
    d.rectangle([4, 4, 12, 6], fill=c + (255,))
    d.rectangle([6, 7, 9, 9], fill=shade(c, 0.8) + (255,))
    d.rectangle([4, 10, 11, 12], fill=shade(c, 0.9) + (255,))
    d.line([(4, 4), (12, 4)], fill=light(c) + (255,))
    return im


def g_book(c):
    im, d = new_icon()
    d.rectangle([3, 6, 12, 12], fill=shade(c, 0.8) + (255,))
    d.polygon([(4, 6), (8, 4), (12, 6), (8, 8)], fill=(235, 230, 220, 255))
    d.line([(8, 4), (8, 8)], fill=(120, 110, 100, 255))
    d.point((6, 6), fill=(180, 60, 180, 255))
    d.point((10, 6), fill=(80, 180, 220, 255))
    return im


def g_brewing(c):
    im, d = new_icon()
    d.line([(8, 3), (8, 6)], fill=(90, 90, 95, 255))
    d.polygon([(6, 7), (10, 7), (11, 12), (5, 12)], fill=(70, 70, 80, 255))
    d.polygon([(6, 9), (10, 9), (11, 12), (5, 12)], fill=c + (255,))
    d.line([(3, 12), (13, 12)], fill=(90, 90, 95, 255))
    return im


def g_beacon(c):
    im, d = new_icon()
    d.rectangle([4, 8, 11, 12], fill=(40, 40, 45, 255))
    d.rectangle([6, 9, 9, 11], fill=c + (255,))
    d.rectangle([7, 3, 8, 8], fill=light(c) + (220,))
    return im


def g_bell(c):
    im, d = new_icon()
    d.polygon([(8, 3), (11, 6), (11, 10), (5, 10), (5, 6)], fill=c + (255,))
    d.rectangle([4, 10, 11, 11], fill=shade(c, 0.85) + (255,))
    d.point((8, 12), fill=shade(c, 0.7) + (255,))
    d.point((6, 5), fill=light(c) + (255,))
    return im


def g_cake():
    im, d = new_icon()
    d.rectangle([3, 7, 12, 12], fill=(240, 235, 230, 255))
    d.rectangle([3, 6, 12, 7], fill=(250, 160, 170, 255))
    for x in (5, 8, 11):
        d.point((x, 9), fill=(220, 60, 60, 255))
    d.line([(8, 3), (8, 5)], fill=(240, 240, 240, 255))
    d.point((8, 3), fill=(250, 200, 80, 255))
    return im


def g_flower(c):
    im, d = new_icon()
    d.line([(8, 8), (8, 13)], fill=(70, 140, 60, 255))
    d.point((6, 11), fill=(70, 140, 60, 255))
    d.point((10, 10), fill=(70, 140, 60, 255))
    for dx, dy in ((0, -2), (2, 0), (0, 2), (-2, 0)):
        d.rectangle([8 + dx - 1, 6 + dy - 1, 8 + dx, 6 + dy], fill=c + (255,))
    d.point((8, 6), fill=(250, 230, 90, 255))
    return im


def g_mushroom(c):
    im, d = new_icon()
    d.polygon([(4, 8), (6, 4), (10, 4), (12, 8)], fill=c + (255,))
    d.rectangle([3, 8, 12, 9], fill=shade(c, 0.85) + (255,))
    d.rectangle([6, 10, 9, 13], fill=(230, 225, 210, 255))
    d.point((6, 6), fill=(255, 255, 255, 255))
    d.point((9, 7), fill=(255, 255, 255, 255))
    return im


def g_crop(c):
    im, d = new_icon()
    for x in (5, 8, 11):
        d.line([(x, 13), (x, 6)], fill=(90, 150, 60, 255,))
        for y in (6, 8, 10):
            d.point((x - 1, y), fill=c + (255,))
            d.point((x + 1, y + 1), fill=c + (255,))
    return im


def g_root(c):
    im, d = new_icon()
    d.polygon([(8, 13), (6, 8), (8, 5), (10, 8)], fill=c + (255,))
    d.line([(7, 5), (6, 3)], fill=(90, 150, 60, 255))
    d.line([(9, 5), (10, 3)], fill=(90, 150, 60, 255))
    d.line([(8, 5), (8, 3)], fill=(110, 170, 70, 255))
    return im


def g_melon(c, stripe):
    im, d = new_icon()
    d.rectangle([3, 4, 12, 12], fill=c + (255,))
    for x in (4, 7, 10):
        d.line([(x, 4), (x, 12)], fill=stripe + (255,))
    d.line([(3, 4), (12, 4)], fill=light(c) + (255,))
    d.line([(8, 3), (8, 4)], fill=(90, 120, 60, 255))
    return im


def g_cactus(c):
    im, d = new_icon()
    d.rectangle([6, 3, 9, 13], fill=c + (255,))
    d.rectangle([3, 6, 5, 8], fill=c + (255,))
    d.rectangle([10, 4, 12, 6], fill=c + (255,))
    for y in (4, 7, 10):
        d.point((7, y), fill=light(c) + (255,))
        d.point((9, y + 1), fill=shade(c, 0.7) + (255,))
    return im


def g_vine(c):
    im, d = new_icon()
    for x in (5, 8, 11):
        d.line([(x, 3), (x, 10 + (x % 3))], fill=c + (255,))
        for y in range(4, 12, 3):
            d.point((x - 1, y), fill=light(c, 1.15) + (255,))
            d.point((x + 1, y + 1), fill=shade(c, 0.8) + (255,))
    return im


def g_tuft(c):
    im, d = new_icon()
    for x, h in ((4, 8), (6, 5), (8, 7), (10, 4), (12, 8)):
        d.line([(x, 13), (x, h)], fill=c + (255,))
        d.point((x - 1, h + 1), fill=light(c, 1.2) + (255,))
    return im


def g_torch(flame):
    im, d = new_icon()
    d.line([(8, 7), (8, 13)], fill=(120, 90, 50, 255))
    d.line([(7, 7), (7, 8)], fill=(100, 75, 40, 255))
    d.rectangle([7, 5, 8, 6], fill=flame + (255,))
    d.point((8, 4), fill=light(flame) + (255,))
    d.point((7, 4), fill=flame + (230,))
    return im


def g_lantern(c, glow=(250, 200, 90)):
    im, d = new_icon()
    d.rectangle([5, 5, 10, 11], fill=c + (255,))
    d.rectangle([6, 6, 9, 10], fill=glow + (255,))
    d.rectangle([7, 3, 8, 4], fill=shade(c, 0.9) + (255,))
    d.line([(5, 12), (10, 12)], fill=shade(c, 0.8) + (255,))
    return im


def g_candle(c):
    im, d = new_icon()
    d.rectangle([6, 7, 9, 13], fill=c + (255,))
    d.line([(8, 5), (8, 6)], fill=(60, 60, 60, 255))
    d.point((8, 4), fill=(250, 200, 90, 255))
    d.point((8, 3), fill=(250, 230, 140, 200))
    d.line([(6, 7), (9, 7)], fill=light(c) + (255,))
    return im


def g_rail(c, powered=False):
    im, d = new_icon()
    tie = (110, 85, 55) if not powered else (120, 60, 50)
    for y in (5, 8, 11):
        d.line([(4, y), (11, y)], fill=tie + (255,))
    d.line([(6, 3), (6, 13)], fill=c + (255,))
    d.line([(9, 3), (9, 13)], fill=c + (255,))
    if powered:
        d.point((7, 8), fill=(250, 60, 50, 255))
        d.point((8, 8), fill=(250, 60, 50, 255))
    return im


def g_door(c):
    im, d = new_icon()
    d.rectangle([5, 3, 10, 13], fill=c + (255,))
    d.rectangle([6, 4, 9, 7], fill=shade(c, 0.75) + (255,))
    d.rectangle([6, 9, 9, 12], fill=shade(c, 0.75) + (255,))
    d.point((9, 8), fill=(240, 220, 80, 255))
    return im


def g_trapdoor(c):
    im, d = new_icon()
    d.rectangle([4, 6, 11, 10], fill=c + (255,))
    d.line([(4, 8), (11, 8)], fill=shade(c, 0.6) + (255,))
    d.line([(7, 6), (7, 10)], fill=shade(c, 0.6) + (255,))
    d.rectangle([4, 6, 11, 10], outline=shade(c, 0.5) + (255,))
    return im


def g_small(c, bar=False):
    im, d = new_icon()
    if bar:
        d.rectangle([4, 9, 11, 11], fill=c + (255,))
        d.line([(4, 9), (11, 9)], fill=light(c) + (255,))
    else:
        d.rectangle([6, 7, 9, 10], fill=c + (255,))
        d.line([(6, 7), (9, 7)], fill=light(c) + (255,))
    return im


def g_lever(c):
    im, d = new_icon()
    d.rectangle([5, 10, 10, 12], fill=(110, 110, 110, 255))
    d.line([(8, 10), (11, 4)], fill=c + (255,))
    d.point((11, 4), fill=light(c) + (255,))
    return im


def g_piston(c, sticky=False):
    im, d = new_icon()
    d.rectangle([3, 6, 12, 12], fill=c + (255,))
    d.rectangle([3, 4, 12, 5], fill=(160, 150, 140, 255))
    d.line([(3, 4), (12, 4)], fill=(200, 190, 180, 255))
    if sticky:
        d.rectangle([5, 2, 10, 3], fill=(120, 190, 90, 255))
    d.point((5, 9), fill=shade(c, 0.7) + (255,))
    d.point((10, 10), fill=shade(c, 0.7) + (255,))
    return im


def g_observer(c):
    im, d = new_icon()
    d.rectangle([3, 4, 12, 12], fill=c + (255,))
    d.rectangle([6, 6, 9, 9], fill=(60, 60, 65, 255))
    d.rectangle([7, 7, 8, 8], fill=(200, 200, 205, 255))
    d.point((11, 11), fill=(150, 40, 40, 255))
    return im


def g_hopper(c):
    im, d = new_icon()
    d.polygon([(3, 4), (12, 4), (9, 9), (6, 9)], fill=c + (255,))
    d.rectangle([7, 9, 8, 12], fill=shade(c, 0.8) + (255,))
    d.line([(3, 4), (12, 4)], fill=light(c) + (255,))
    return im


def g_dispenser(c):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=c + (255,))
    d.rectangle([6, 6, 9, 9], fill=(40, 38, 38, 255))
    d.point((7, 8), fill=(90, 88, 88, 255))
    d.line([(3, 3), (12, 3)], fill=light(c) + (255,))
    d.point((4, 4), fill=(60, 58, 58, 255))
    d.point((11, 4), fill=(60, 58, 58, 255))
    return im


def g_barrel(c):
    im, d = new_icon()
    d.rectangle([4, 3, 11, 12], fill=c + (255,))
    d.line([(4, 5), (11, 5)], fill=(90, 90, 95, 255))
    d.line([(4, 10), (11, 10)], fill=(90, 90, 95, 255))
    d.rectangle([6, 6, 9, 9], fill=shade(c, 0.8) + (255,))
    return im


def g_composter(c):
    im, d = new_icon()
    d.rectangle([3, 5, 12, 12], fill=c + (255,))
    d.rectangle([5, 6, 10, 8], fill=(110, 70, 40, 255))
    d.line([(3, 5), (3, 12)], fill=light(c) + (255,))
    d.line([(12, 5), (12, 12)], fill=shade(c, 0.7) + (255,))
    return im


def g_lodestone(c):
    im, d = new_icon()
    d.rectangle([3, 5, 12, 12], fill=c + (255,))
    d.rectangle([5, 7, 10, 10], fill=(70, 70, 78, 255))
    d.rectangle([6, 8, 9, 9], fill=(120, 120, 130, 255))
    d.line([(3, 5), (12, 5)], fill=light(c) + (255,))
    return im


def g_anchor(c, glow=(160, 60, 200)):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=c + (255,))
    d.rectangle([6, 6, 9, 9], fill=(20, 16, 24, 255))
    d.point((7, 7), fill=glow + (255,))
    d.point((8, 8), fill=glow + (200,))
    return im


def g_spawner(c):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=(35, 35, 45, 255))
    for x in (5, 8, 11):
        d.line([(x, 3), (x, 12)], fill=c + (255,))
    for y in (5, 8, 11):
        d.line([(3, y), (12, y)], fill=shade(c, 0.8) + (255,))
    d.point((7, 7), fill=(120, 200, 220, 255))
    return im


def g_skull(c):
    im, d = new_icon()
    d.rectangle([5, 4, 10, 9], fill=c + (255,))
    d.rectangle([6, 10, 9, 12], fill=shade(c, 0.9) + (255,))
    d.point((6, 6), fill=(20, 20, 20, 255))
    d.point((9, 6), fill=(20, 20, 20, 255))
    d.point((8, 9), fill=(20, 20, 20, 255))
    return im


def g_egg(c, spot=(90, 70, 50)):
    im, d = new_icon()
    d.ellipse([5, 4, 10, 12], fill=c + (255,))
    d.point((7, 6), fill=spot + (255,))
    d.point((8, 9), fill=spot + (255,))
    d.point((6, 8), fill=spot + (200,))
    return im


def g_coral(c):
    im, d = new_icon()
    d.line([(8, 13), (8, 7)], fill=c + (255,))
    d.line([(8, 9), (5, 6)], fill=c + (255,))
    d.line([(8, 8), (11, 5)], fill=c + (255,))
    d.point((5, 5), fill=light(c) + (255,))
    d.point((11, 4), fill=light(c) + (255,))
    d.point((8, 6), fill=light(c) + (255,))
    return im


def g_kelp(c):
    im, d = new_icon()
    d.line([(7, 13), (7, 4)], fill=c + (255,))
    for y in (5, 8, 11):
        d.line([(7, y), (10, y - 1)], fill=light(c, 1.15) + (255,))
        d.line([(7, y + 1), (4, y)], fill=shade(c, 0.85) + (255,))
    return im


def g_sealantern(c):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=shade(c, 0.75) + (255,))
    d.rectangle([5, 5, 10, 10], fill=c + (255,))
    d.rectangle([7, 7, 8, 8], fill=(255, 255, 240, 255))
    for x, y in ((4, 4), (11, 4), (4, 11), (11, 11)):
        d.point((x, y), fill=light(c) + (255,))
    return im


def g_slime(c):
    im, d = new_icon()
    d.rectangle([3, 4, 12, 12], fill=c + (170,))
    d.rectangle([5, 6, 10, 10], fill=light(c, 1.1) + (140,))
    d.point((6, 7), fill=(20, 40, 20, 200))
    d.point((9, 7), fill=(20, 40, 20, 200))
    d.point((7, 9), fill=(20, 40, 20, 200))
    d.point((8, 9), fill=(20, 40, 20, 200))
    return im


def g_honey(c):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=c + (220,))
    d.rectangle([4, 4, 6, 6], fill=light(c, 1.15) + (200,))
    d.point((9, 9), fill=shade(c, 0.8) + (220,))
    d.point((10, 5), fill=shade(c, 0.8) + (220,))
    return im


def g_sponge(c):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=c + (255,))
    for x, y in ((5, 5), (9, 6), (6, 9), (10, 10), (4, 11)):
        d.rectangle([x, y, x + 1, y + 1], fill=shade(c, 0.65) + (255,))
    return im


def g_obsidian(c, spark=(140, 90, 200)):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=c + (255,))
    rnd = random.Random(21)
    for _ in range(10):
        x, y = rnd.randint(3, 12), rnd.randint(3, 12)
        d.point((x, y), fill=shade(c, 0.6) + (255,))
    for x, y in ((5, 6), (9, 5), (7, 10), (11, 9)):
        d.point((x, y), fill=spark + (255,))
    return im


def g_sculk(c, teal=(30, 120, 130)):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=c + (255,))
    rnd = random.Random(31)
    for _ in range(12):
        x, y = rnd.randint(3, 12), rnd.randint(3, 12)
        d.point((x, y), fill=(10, 14, 20, 255))
    for x, y in ((6, 6), (10, 8), (5, 10)):
        d.point((x, y), fill=teal + (255,))
    return im


def g_crystal(c):
    im, d = new_icon()
    d.polygon([(6, 12), (5, 7), (7, 4), (8, 8), (7, 12)], fill=c + (255,))
    d.polygon([(9, 12), (9, 6), (11, 4), (12, 9), (11, 12)], fill=light(c, 1.1) + (255,))
    d.point((7, 5), fill=(255, 255, 255, 255))
    return im


def g_cone(c):
    im, d = new_icon()
    d.polygon([(8, 13), (5, 4), (11, 4)], fill=c + (255,))
    d.line([(8, 12), (7, 5)], fill=light(c) + (255,))
    d.line([(9, 11), (10, 5)], fill=shade(c, 0.75) + (255,))
    return im


def g_chain(c):
    im, d = new_icon()
    for y in (3, 7, 11):
        d.rectangle([7, y, 8, y + 3], outline=c + (255,))
    return im


def g_bars(c):
    im, d = new_icon()
    for x in (5, 8, 11):
        d.line([(x, 3), (x, 12)], fill=c + (255,))
    d.line([(4, 5), (12, 5)], fill=shade(c, 0.8) + (255,))
    d.line([(4, 10), (12, 10)], fill=shade(c, 0.8) + (255,))
    return im


def g_ladder(c):
    im, d = new_icon()
    d.line([(5, 3), (5, 13)], fill=c + (255,))
    d.line([(10, 3), (10, 13)], fill=c + (255,))
    for y in (5, 8, 11):
        d.line([(5, y), (10, y)], fill=light(c) + (255,))
    return im


def g_target():
    im, d = new_icon()
    d.ellipse([3, 3, 12, 12], fill=(235, 230, 225, 255))
    d.ellipse([5, 5, 10, 10], fill=(200, 50, 45, 255))
    d.ellipse([7, 7, 8, 8], fill=(235, 230, 225, 255))
    return im


def g_note(c):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=c + (255,))
    d.line([(8, 5), (8, 10)], fill=(30, 30, 30, 255))
    d.ellipse([6, 9, 8, 11], fill=(30, 30, 30, 255))
    d.line([(8, 5), (11, 6)], fill=(30, 30, 30, 255))
    return im


def g_jukebox(c):
    im, d = new_icon()
    d.rectangle([3, 4, 12, 12], fill=c + (255,))
    d.ellipse([6, 6, 9, 9], fill=(40, 38, 38, 255))
    d.point((7, 7), fill=(120, 110, 100, 255))
    d.line([(3, 4), (12, 4)], fill=light(c) + (255,))
    return im


def g_workbench(c, tool=(170, 170, 175)):
    im, d = new_icon()
    d.rectangle([3, 6, 12, 12], fill=c + (255,))
    d.rectangle([3, 5, 12, 6], fill=light(c, 1.12) + (255,))
    d.line([(6, 8), (10, 12)], fill=tool + (255,))
    d.point((5, 7), fill=tool + (255,))
    d.point((4, 8), fill=tool + (255,))
    return im


def g_grindstone(c):
    im, d = new_icon()
    d.ellipse([5, 4, 10, 9], fill=c + (255,))
    d.point((7, 6), fill=shade(c, 0.7) + (255,))
    d.line([(5, 10), (5, 13)], fill=(110, 85, 55, 255))
    d.line([(10, 10), (10, 13)], fill=(110, 85, 55, 255))
    return im


def g_blade(c):
    im, d = new_icon()
    d.rectangle([3, 8, 12, 12], fill=c + (255,))
    d.polygon([(7, 3), (9, 3), (8, 8)], fill=(190, 190, 195, 255))
    d.line([(3, 8), (12, 8)], fill=light(c) + (255,))
    return im


def g_campfire(flame):
    im, d = new_icon()
    d.line([(4, 12), (12, 10)], fill=(110, 85, 55, 255))
    d.line([(4, 10), (12, 12)], fill=(90, 70, 45, 255))
    d.polygon([(8, 4), (10, 8), (8, 10), (6, 8)], fill=flame + (255,))
    d.point((8, 6), fill=light(flame) + (255,))
    return im


def g_pot(c):
    im, d = new_icon()
    d.polygon([(4, 6), (11, 6), (10, 12), (5, 12)], fill=c + (255,))
    d.line([(4, 6), (11, 6)], fill=light(c) + (255,))
    d.line([(7, 5), (7, 3)], fill=(90, 150, 60, 255))
    d.point((6, 3), fill=(110, 170, 70, 255))
    return im


def g_lectern(c):
    im, d = new_icon()
    d.polygon([(4, 5), (11, 4), (11, 7), (4, 8)], fill=light(c, 1.1) + (255,))
    d.rectangle([6, 8, 9, 12], fill=c + (255,))
    d.rectangle([5, 3, 10, 5], fill=(235, 230, 220, 255))
    return im


def g_cauldron(c):
    im, d = new_icon()
    d.rectangle([4, 5, 11, 11], fill=c + (255,))
    d.rectangle([5, 5, 10, 6], fill=(40, 40, 45, 255))
    d.line([(4, 12), (5, 12)], fill=c + (255,))
    d.line([(10, 12), (11, 12)], fill=c + (255,))
    d.line([(4, 5), (11, 5)], fill=light(c) + (255,))
    return im


def g_daylight(c):
    im, d = new_icon()
    d.rectangle([3, 6, 12, 10], fill=c + (255,))
    d.rectangle([4, 5, 11, 6], fill=(120, 120, 130, 255))
    for x in (5, 8, 11):
        d.point((x, 8), fill=light(c) + (255,))
    return im


def g_lamp(c, on=True):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=shade(c, 0.55) + (255,))
    d.rectangle([5, 5, 10, 10], fill=(c if on else shade(c, 0.8)) + (255,)
                )
    if on:
        d.rectangle([7, 7, 8, 8], fill=(255, 250, 230, 255))
    return im


def g_repeater(c):
    im, d = new_icon()
    d.rectangle([3, 8, 12, 11], fill=(120, 118, 115, 255))
    d.rectangle([5, 6, 6, 8], fill=c + (255,))
    d.rectangle([9, 6, 10, 8], fill=c + (255,))
    d.point((5, 5), fill=(250, 60, 50, 255))
    d.point((9, 5), fill=(250, 60, 50, 255))
    return im


def g_wire(c):
    im, d = new_icon()
    d.line([(3, 8), (6, 8)], fill=c + (255,))
    d.line([(6, 8), (8, 6)], fill=c + (255,))
    d.line([(8, 6), (10, 8)], fill=c + (255,))
    d.line([(10, 8), (12, 8)], fill=c + (255,))
    d.point((8, 5), fill=light(c) + (255,))
    return im


def g_portal(c):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=(30, 20, 40, 255))
    d.rectangle([5, 5, 10, 10], fill=c + (230,))
    d.point((7, 7), fill=light(c) + (255,))
    d.point((9, 9), fill=shade(c, 0.7) + (255,))
    return im


def g_wart(c):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=c + (255,))
    for x, y in ((5, 5), (9, 6), (6, 9), (10, 10)):
        d.ellipse([x, y, x + 2, y + 2], fill=shade(c, 0.7) + (255,))
    return im


def g_glowdots(c):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=shade(c, 0.6) + (255,))
    for x, y in ((5, 5), (9, 5), (5, 9), (9, 9), (7, 7)):
        d.rectangle([x, y, x + 1, y + 1], fill=c + (255,))
        d.point((x, y), fill=(255, 255, 240, 255))
    return im


def g_pillar(c, band):
    im, d = new_icon()
    d.rectangle([4, 3, 11, 12], fill=c + (255,))
    for x in (5, 8, 10):
        d.line([(x, 3), (x, 12)], fill=shade(c, 0.85) + (255,))
    d.line([(4, 3), (11, 3)], fill=band + (255,))
    d.line([(4, 12), (11, 12)], fill=band + (255,))
    return im


def g_layers(c, mid):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=c + (255,))
    d.line([(3, 6), (12, 6)], fill=mid + (255,))
    d.line([(3, 9), (12, 9)], fill=mid + (255,))
    d.line([(3, 3), (12, 3)], fill=light(c) + (255,))
    return im


def g_turf(top, soil):
    im, d = new_icon()
    d.rectangle([3, 6, 12, 12], fill=soil + (255,))
    d.rectangle([3, 4, 12, 6], fill=top + (255,))
    rnd = random.Random(5)
    for _ in range(8):
        x = rnd.randint(3, 12)
        d.point((x, 7), fill=shade(top, 0.8) + (255,))
    for x in (5, 9):
        d.point((x, 3), fill=top + (255,))
    return im


def g_ice(c):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=c + (210,))
    d.line([(5, 4), (7, 7)], fill=(255, 255, 255, 200))
    d.line([(7, 7), (6, 10)], fill=(255, 255, 255, 160))
    d.line([(9, 5), (11, 8)], fill=(255, 255, 255, 160))
    return im


def g_drop(c):
    im, d = new_icon()
    d.polygon([(8, 3), (11, 8), (8, 12), (5, 8)], fill=c + (255,))
    d.point((7, 7), fill=(255, 255, 255, 255))
    return im


def g_flame(c):
    im, d = new_icon()
    d.polygon([(8, 3), (11, 8), (10, 12), (6, 12), (5, 8)], fill=c + (255,))
    d.polygon([(8, 6), (9, 9), (8, 11), (7, 9)], fill=(255, 240, 150, 255))
    return im


def g_bone(c):
    im, d = new_icon()
    d.rectangle([4, 6, 11, 9], fill=c + (255,))
    for x in (4, 11):
        d.rectangle([x - 1 if x == 4 else x, 4, x + 1, 11], fill=c + (255,))
    d.line([(5, 7), (10, 7)], fill=light(c) + (255,))
    return im


def g_hex(c):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=c + (255,))
    for cx, cy in ((6, 6), (10, 8), (6, 10)):
        d.polygon([(cx, cy - 2), (cx + 2, cy), (cx, cy + 2), (cx - 2, cy)],
                  outline=shade(c, 0.65) + (255,))
    return im


def g_face(c):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=c + (255,))
    for x, y in ((6, 6), (10, 8), (7, 10)):
        d.rectangle([x, y, x + 1, y + 1], fill=(40, 30, 25, 255))
        d.point((x, y), fill=(20, 15, 12, 255))
    return im


def g_scaffold(c):
    im, d = new_icon()
    for x in (4, 11):
        d.line([(x, 3), (x, 12)], fill=c + (255,))
    for y in (4, 8, 12):
        d.line([(4, y), (11, y)], fill=shade(c, 0.8) + (255,))
    d.point((7, 6), fill=(120, 160, 60, 255))
    return im


def g_nest(c):
    im, d = new_icon()
    d.rectangle([3, 4, 12, 12], fill=c + (255,))
    d.rectangle([5, 8, 7, 10], fill=(40, 30, 20, 255))
    d.rectangle([9, 8, 10, 10], fill=(40, 30, 20, 255))
    d.line([(3, 6), (12, 6)], fill=shade(c, 0.75) + (255,))
    return im


def g_none():
    im, _ = new_icon()
    return im


def g_shroom(c):
    im, d = new_icon()
    d.rectangle([3, 3, 12, 12], fill=c + (255,))
    for x, y in ((5, 5), (9, 7), (6, 10)):
        d.rectangle([x, y, x + 2, y + 1], fill=light(c) + (255,))
    return im


GLYPHS = {f.__name__[2:]: f for f in [
    g_ore, g_ingot, g_chunk, g_planks, g_log, g_leaves, g_speckle, g_bricks,
    g_flat, g_wool, g_carpet, g_powder, g_glazed, g_glass, g_chest, g_furnace,
    g_craft, g_bookshelf, g_tnt, g_anvil, g_book, g_brewing, g_beacon, g_bell,
    g_cake, g_flower, g_mushroom, g_crop, g_root, g_melon, g_cactus, g_vine,
    g_tuft, g_torch, g_lantern, g_candle, g_rail, g_door, g_trapdoor, g_small,
    g_lever, g_piston, g_observer, g_hopper, g_dispenser, g_barrel,
    g_composter, g_lodestone, g_anchor, g_spawner, g_skull, g_egg, g_coral,
    g_kelp, g_sealantern, g_slime, g_honey, g_sponge, g_obsidian, g_sculk,
    g_crystal, g_cone, g_chain, g_bars, g_ladder, g_target, g_note, g_jukebox,
    g_workbench, g_grindstone, g_blade, g_campfire, g_pot, g_lectern,
    g_cauldron, g_daylight, g_lamp, g_repeater, g_wire, g_portal, g_wart,
    g_glowdots, g_pillar, g_layers, g_turf, g_ice, g_drop, g_flame, g_bone,
    g_hex, g_face, g_scaffold, g_nest, g_shroom, g_none,
]}


# --------------------------------------------------------------------------
# family table: (regex, key template, glyph, params, tier, tint, alpha)
# tint colours the video background and the frame ring.
# --------------------------------------------------------------------------
WOODS = {
    "oak": (156, 127, 78), "spruce": (114, 84, 48), "birch": (192, 175, 121),
    "jungle": (168, 124, 79), "acacia": (168, 90, 50), "cherry": (226, 178, 172),
    "dark_oak": (66, 43, 20), "pale_oak": (222, 214, 204),
    "mangrove": (117, 54, 48), "bamboo": (194, 178, 83),
    "crimson": (101, 48, 71), "warped": (43, 104, 99),
}
BARK = {k: shade(v, 0.62) for k, v in WOODS.items()}

COLORS = {
    "white": (240, 240, 240), "light_gray": (140, 140, 140),
    "gray": (70, 70, 70), "black": (25, 25, 25), "brown": (110, 70, 40),
    "red": (180, 50, 45), "orange": (220, 110, 40), "yellow": (240, 190, 60),
    "lime": (120, 190, 50), "green": (70, 140, 50), "cyan": (60, 160, 170),
    "light_blue": (90, 160, 220), "blue": (50, 80, 190), "purple": (130, 60, 180),
    "magenta": (190, 70, 190), "pink": (240, 130, 180),
}

METALS = {
    "iron": (220, 220, 220), "gold": (250, 200, 80), "copper": (220, 120, 80),
    "diamond": (80, 230, 220), "emerald": (60, 220, 110), "lapis": (40, 90, 200),
    "redstone": (220, 40, 40), "coal": (40, 40, 40), "quartz": (235, 230, 225),
    "netherite": (70, 62, 65),
}

# ordered rules; first match wins.
# rule(pattern, family key, glyph, glyph params, tier, tint, alpha)
RULES: list[tuple[str, str, str, tuple, str, tuple | None, str]] = []


def rule(pattern, key, glyph, params=(), tier="lo", tint=None, alpha="solid"):
    RULES.append((pattern, key, glyph, params, tier, tint, alpha))


# block ids are normalised before matching: waxed/potted variants look the
# same as their base block, so they share its family.
NORMALISE = ((r"^waxed_", ""), (r"^potted_", ""))

# --- ores, raw blocks, metal storage -----------------------------------------
for ore, gem in METALS.items():
    rule(rf"(deepslate_|nether_)?{ore}_ore$", f"{ore}_ore", "ore", (gem,), "hi",
         (90, 90, 95))
rule(r"ancient_debris$", "ancient_debris", "speckle", ((90, 65, 50), (170, 130, 95)), "hi", (80, 58, 45))
for metal, col in METALS.items():
    rule(rf"raw_{metal}_block$", f"raw_{metal}", "chunk", (col,), "lo", shade(col, 0.6))
for metal, col in METALS.items():
    if metal not in ("redstone", "lapis", "quartz"):
        rule(rf"{metal}_block$", f"{metal}_block", "ingot", (col,), "hi", shade(col, 0.55))
rule(r"redstone_block$", "redstone_block", "glowdots", ((250, 60, 50),), "hi", (120, 20, 20))
rule(r"lapis_block$", "lapis_block", "chunk", ((40, 90, 200),), "hi", (25, 45, 110))
rule(r"netherite_block$", "netherite_block", "ingot", ((70, 62, 65),), "hi", (40, 36, 38))
rule(r"amethyst_block$", "amethyst_block", "crystal", ((160, 100, 220),), "hi", (90, 55, 140))
rule(r"budding_amethyst$", "budding_amethyst", "crystal", ((190, 140, 240),), "lo", (90, 55, 140))
rule(r"amethyst_cluster|amethyst_bud", "amethyst_cluster", "crystal", ((200, 150, 245),), "lo", (90, 55, 140))

# --- copper (stage = oxidation level) ----------------------------------------
COPPER_STAGES = [("copper", (220, 120, 80)), ("exposed", (190, 145, 105)),
                 ("weathered", (130, 165, 135)), ("oxidized", (90, 170, 150))]
for stage, col in COPPER_STAGES:
    pre = "" if stage == "copper" else stage + "_"
    rule(rf"^{pre}(copper_block|copper)$|^{stage}_copper$",
         f"{stage}_copper_block", "ingot", (col,),
         "hi" if stage == "copper" else "lo", shade(col, 0.7))
    rule(rf"^{pre}cut_copper|^{pre}chiseled_copper",
         f"{stage}_cut_copper", "layers", (col, shade(col, 0.72)), "lo", shade(col, 0.7))
    rule(rf"^{pre}copper_bulb", f"{stage}_copper_bulb",
         "lamp", ((250, 200, 120),), "lo", shade(col, 0.75))
    rule(rf"^{pre}copper_(grate|bars|chain)", f"{stage}_cut_copper",
         "layers", (col, shade(col, 0.72)), "lo", shade(col, 0.7))
    rule(rf"^{pre}copper_(chest|golem_statue)",
         f"{stage}_copper_chest", "chest", (col, (60, 40, 30)), "lo", shade(col, 0.7))
    rule(rf"^{pre}copper_(door|trapdoor)", f"{stage}_cut_copper",
         "door", (col,), "lo", shade(col, 0.7))
rule(r"copper_torch", "copper_torch", "torch", ((250, 180, 110),), "lo", (170, 100, 60))
rule(r"copper_lantern", "copper_lantern", "lantern", ((190, 105, 70), (250, 200, 90)), "lo", (160, 88, 58))


# --- stone family -------------------------------------------------------------
rule(r"^stone$", "stone", "speckle", ((125, 125, 125), (95, 95, 95)), "hi", (110, 110, 110))
rule(r"smooth_stone$", "smooth_stone", "layers", ((140, 140, 142), (120, 120, 122)), "lo", (125, 125, 127))
rule(r"^cobblestone$", "cobblestone", "speckle", ((120, 120, 120), (80, 80, 80), 22), "hi", (105, 105, 105))
rule(r"mossy_cobblestone", "mossy_cobblestone", "speckle", ((110, 120, 105), (70, 110, 60), 22), "lo", (90, 110, 85))
rule(r"^(granite|polished_granite)$", "granite", "speckle", ((150, 110, 95), (190, 150, 135)), "hi", (140, 100, 90))
rule(r"^(diorite|polished_diorite)$", "diorite", "speckle", ((190, 190, 190), (140, 140, 145)), "hi", (170, 170, 172))
rule(r"^(andesite|polished_andesite)$", "andesite", "speckle", ((130, 130, 133), (100, 100, 103)), "hi", (115, 115, 118))
rule(r"^deepslate$|cobbled_deepslate", "deepslate", "speckle", ((70, 70, 75), (45, 45, 50)), "hi", (60, 60, 66))
rule(r"chiseled_deepslate|polished_deepslate|deepslate_brick|deepslate_tile",
     "deepslate_bricks", "bricks", ((65, 65, 70), (40, 40, 45)), "lo", (55, 55, 60))
rule(r"tuff", "tuff", "speckle", ((120, 118, 112), (90, 88, 84)), "lo", (105, 103, 98))
rule(r"calcite", "calcite", "speckle", ((220, 218, 210), (190, 188, 180)), "lo", (200, 198, 190))
rule(r"^dripstone_block$", "dripstone_block", "speckle", ((140, 110, 95), (110, 85, 72)), "lo", (125, 100, 86))
rule(r"pointed_dripstone$", "pointed_dripstone", "cone", ((150, 120, 105),), "lo", (125, 100, 86))
rule(r"reinforced_deepslate", "reinforced_deepslate", "bricks", ((60, 62, 66), (140, 130, 90)), "lo", (52, 54, 58))
rule(r"infested_", "infested", "speckle", ((110, 110, 108), (70, 70, 68)), "lo", (95, 95, 93))

# --- dirt / ground --------------------------------------------------------------
rule(r"^grass_block$", "grass_block", "turf", ((110, 180, 70), (120, 90, 60)), "hi", (100, 150, 70))
rule(r"^dirt$", "dirt", "speckle", ((120, 90, 60), (95, 70, 45)), "hi", (110, 85, 58))
rule(r"coarse_dirt$", "coarse_dirt", "speckle", ((110, 82, 55), (80, 58, 38), 24), "lo", (100, 76, 52))
rule(r"^podzol$", "podzol", "speckle", ((90, 60, 30), (60, 40, 20)), "lo", (85, 58, 30))
rule(r"rooted_dirt$", "rooted_dirt", "speckle", ((130, 95, 70), (90, 60, 40)), "lo", (120, 90, 66))
rule(r"^dirt_path$", "dirt_path", "layers", ((130, 100, 65), (110, 84, 54)), "lo", (120, 92, 60))
rule(r"farmland$", "farmland", "layers", ((110, 80, 50), (80, 58, 36)), "lo", (100, 74, 48))
rule(r"^mud$", "mud", "speckle", ((70, 55, 50), (50, 40, 36)), "lo", (65, 52, 47))
rule(r"mud_brick|muddy_mangrove|^packed_mud$", "mud_bricks", "bricks", ((105, 88, 74), (80, 66, 55)), "lo", (95, 80, 67))
rule(r"^clay$", "clay", "flat", ((140, 140, 150),), "lo", (130, 130, 140))
rule(r"^mycelium$", "mycelium", "speckle", ((110, 105, 115), (150, 145, 160)), "lo", (105, 100, 112))
rule(r"red_sand$|red_sandstone|smooth_red_sandstone", "red_sandstone",
     "layers", ((200, 110, 40), (175, 90, 30)), "hi", (185, 100, 36))
rule(r"^sand$|sandstone|suspicious_sand|smooth_sandstone", "sandstone",
     "layers", ((220, 205, 160), (195, 180, 135)), "hi", (205, 190, 148))
rule(r"gravel|suspicious_gravel", "gravel", "speckle", ((125, 120, 118), (90, 86, 84), 24), "hi", (112, 108, 106))
rule(r"powder_snow|^snow$|snow_block", "snow", "powder", ((245, 248, 252),), "hi", (225, 232, 240))
rule(r"packed_ice$", "packed_ice", "ice", ((160, 200, 245),), "lo", (130, 175, 225), "translucent")
rule(r"blue_ice$", "blue_ice", "ice", ((100, 160, 240),), "lo", (70, 130, 210), "translucent")
rule(r"^ice$", "ice", "ice", ((150, 190, 240),), "hi", (120, 165, 220), "translucent")

# --- wood ------------------------------------------------------------------------
for w, c in WOODS.items():
    rule(rf"^{w}_(planks|slab|stairs|fence|fence_gate|door|trapdoor|button|pressure_plate|sign|wall_sign|hanging_sign|wall_hanging_sign|shelf|wood$|hyphae)",
         f"{w}_planks", "planks", (c,), "hi", shade(c, 0.8))
    rule(rf"stripped_{w}_log$|stripped_{w}_wood$|stripped_{w}_stem$|stripped_{w}_hyphae$",
         f"stripped_{w}_log", "log",
         (light(c, 1.08), c), "lo", c)
    rule(rf"^{w}_log$|^{w}_wood$|^{w}_stem$|^{w}_hyphae$", f"{w}_log", "log",
         (c, BARK[w]), "hi", BARK[w])
    rule(rf"^{w}_leaves$", f"{w}_leaves", "leaves",
         (shade(c, 0.55) if w in ("crimson", "warped") else (60, 130, 50),),
         "hi", (50, 110, 45))
    rule(rf"^{w}_sapling$|^{w}_propagule$", f"{w}_sapling", "tuft", ((90, 170, 70),), "lo", (80, 140, 62))
rule(r"azalea_leaves", "azalea_leaves", "leaves", ((70, 140, 55),), "lo", (58, 118, 48))
rule(r"bamboo_mosaic", "bamboo_mosaic", "planks", ((180, 160, 70),), "lo", (165, 148, 64))
rule(r"bamboo_block|stripped_bamboo", "bamboo_block", "planks", ((194, 178, 83),), "lo", (175, 160, 75))
rule(r"^bamboo$", "bamboo", "kelp", ((194, 178, 83),), "lo", (160, 148, 70))
rule(r"crimson_nylium|crimson_roots", "crimson_nylium", "turf", ((140, 50, 70), (90, 35, 50)), "lo", (120, 45, 62))
rule(r"warped_nylium|warped_roots", "warped_nylium", "turf", ((50, 120, 110), (35, 85, 80)), "lo", (45, 105, 98))
rule(r"pale_moss", "pale_moss", "speckle", ((120, 130, 120), (90, 100, 92)), "lo", (105, 115, 105))
rule(r"moss_block|moss_carpet", "moss_block", "speckle", ((80, 120, 60), (55, 90, 42)), "lo", (68, 105, 52))

# --- bricks & rocky variants -------------------------------------------------------
rule(r"^bricks$|brick_(slab|stairs|wall)", "bricks", "bricks", ((150, 95, 80), (190, 170, 160)), "hi", (140, 90, 76))
rule(r"chiseled_stone_bricks", "chiseled_stone_bricks", "bricks", ((125, 125, 125), (80, 80, 80)), "lo", (108, 108, 108))
rule(r"stone_brick", "stone_bricks", "bricks", ((120, 120, 120), (90, 90, 90)), "hi", (108, 108, 108))
rule(r"red_nether_brick", "red_nether_bricks", "bricks", ((80, 30, 35), (55, 18, 22)), "lo", (68, 25, 30))
rule(r"nether_brick", "nether_bricks", "bricks", ((60, 25, 30), (40, 15, 20)), "lo", (52, 22, 27))
rule(r"gilded_blackstone", "gilded_blackstone", "bricks", ((45, 42, 48), (240, 190, 80)), "lo", (40, 38, 44))
rule(r"blackstone", "blackstone", "bricks", ((45, 42, 48), (30, 28, 33)), "hi", (40, 38, 44))
rule(r"basalt", "basalt", "pillar", ((85, 85, 90), (60, 60, 66)), "lo", (75, 75, 82))
rule(r"end_stone_brick", "end_stone_bricks", "bricks", ((220, 220, 180), (195, 195, 155)), "lo", (205, 205, 168))
rule(r"^end_stone$", "end_stone", "speckle", ((220, 220, 180), (190, 190, 150)), "hi", (205, 205, 168))
rule(r"purpur", "purpur", "pillar", ((170, 130, 170), (150, 110, 150)), "lo", (158, 120, 158))
rule(r"prismarine_bricks", "prismarine_bricks", "bricks", ((100, 160, 150), (75, 130, 120)), "lo", (88, 145, 135))
rule(r"dark_prismarine", "dark_prismarine", "speckle", ((50, 90, 75), (30, 65, 52)), "lo", (42, 78, 65))
rule(r"^prismarine$", "prismarine", "speckle", ((90, 150, 140), (60, 115, 105)), "lo", (78, 135, 126))
rule(r"crying_obsidian", "crying_obsidian", "obsidian", ((40, 25, 70), (160, 90, 240)), "lo", (35, 22, 62))
rule(r"^obsidian$", "obsidian", "obsidian", ((30, 25, 45),), "hi", (26, 22, 40))
rule(r"^netherrack$", "netherrack", "speckle", ((110, 40, 40), (80, 28, 28)), "hi", (98, 36, 36))
rule(r"soul_sand$", "soul_sand", "face", ((90, 70, 55),), "lo", (82, 64, 50))
rule(r"soul_soil$", "soul_soil", "speckle", ((60, 45, 35), (40, 30, 24)), "lo", (55, 42, 32))
rule(r"magma_block$", "magma_block", "glowdots", ((250, 140, 50),), "hi", (120, 50, 25))
rule(r"glowstone$", "glowstone", "glowdots", ((255, 200, 100),), "hi", (150, 110, 50))
rule(r"shroomlight", "shroomlight", "glowdots", ((250, 170, 90),), "lo", (150, 95, 50))
rule(r"sea_lantern", "sea_lantern", "sealantern", ((160, 200, 190),), "lo", (110, 150, 145))
rule(r"sculk_catalyst", "sculk_catalyst", "sculk", ((30, 45, 55),), "lo", (24, 38, 48))
rule(r"sculk_shrieker", "sculk_shrieker", "sculk", ((40, 60, 65),), "lo", (32, 50, 55))
rule(r"sculk_sensor", "sculk_sensor", "sculk", ((35, 55, 60),), "lo", (28, 45, 50))
rule(r"sculk", "sculk", "sculk", ((20, 30, 40),), "lo", (16, 26, 36))
rule(r"bone_block", "bone_block", "bone", ((230, 225, 200),), "lo", (210, 205, 185))
rule(r"resin", "resin", "bricks", ((220, 140, 60), (185, 105, 40)), "lo", (190, 115, 48))
rule(r"quartz_bricks", "quartz_bricks", "bricks", ((235, 230, 225), (210, 205, 195)), "lo", (215, 210, 200))
rule(r"quartz", "quartz_block", "pillar", ((235, 230, 225), (210, 205, 195)), "hi", (215, 210, 200))

# --- functional blocks --------------------------------------------------------------
rule(r"ender_chest$", "ender_chest", "chest", ((50, 35, 60), (120, 230, 220)), "hi", (45, 32, 55))
rule(r"^chest$|trapped_chest", "chest", "chest", ((150, 105, 50),), "hi", (130, 90, 45))
rule(r"^barrel$", "barrel", "barrel", ((140, 100, 55),), "lo", (120, 86, 48))
rule(r"blast_furnace$", "blast_furnace", "furnace", ((80, 82, 88), (250, 170, 60)), "lo", (70, 72, 78))
rule(r"smoker$", "smoker", "furnace", ((90, 75, 60), (250, 150, 50)), "lo", (80, 66, 52))
rule(r"^furnace$", "furnace", "furnace", ((110, 110, 110),), "hi", (95, 95, 95))
rule(r"crafting_table$", "crafting_table", "craft", ((150, 110, 60),), "hi", (130, 95, 52))
rule(r"bookshelf$", "bookshelf", "bookshelf", ((150, 110, 60),), "hi", (130, 95, 52))
rule(r"chiseled_bookshelf", "chiseled_bookshelf", "bookshelf", ((140, 100, 55),), "lo", (120, 86, 48))
rule(r"^tnt$", "tnt", "tnt", (), "hi", (170, 50, 45))
rule(r"anvil$", "anvil", "anvil", ((70, 68, 72),), "lo", (60, 58, 62))
rule(r"enchanting_table$", "enchanting_table", "book", ((120, 40, 40),), "lo", (100, 35, 35))
rule(r"brewing_stand$", "brewing_stand", "brewing", ((220, 180, 80),), "lo", (150, 120, 60))
rule(r"^beacon$", "beacon", "beacon", ((120, 230, 220),), "lo", (90, 180, 175))
rule(r"^bell$", "bell", "bell", ((250, 200, 80),), "lo", (200, 160, 65))
rule(r"^cake$", "cake", "cake", (), "lo", (200, 120, 130))
rule(r"jukebox$", "jukebox", "jukebox", ((150, 110, 60),), "lo", (130, 95, 52))
rule(r"note_block$", "note_block", "note", ((150, 110, 60),), "lo", (130, 95, 52))
rule(r"loom$", "loom", "workbench", ((150, 110, 60), (230, 230, 230)), "lo", (130, 95, 52))
rule(r"cartography_table$", "cartography_table", "workbench", ((150, 110, 60), (230, 225, 200)), "lo", (130, 95, 52))
rule(r"fletching_table$", "fletching_table", "workbench", ((150, 110, 60), (200, 200, 205)), "lo", (130, 95, 52))
rule(r"smithing_table$", "smithing_table", "workbench", ((60, 60, 65), (180, 180, 185)), "lo", (52, 52, 58))
rule(r"grindstone$", "grindstone", "grindstone", ((130, 130, 132),), "lo", (110, 110, 112))
rule(r"stonecutter$", "stonecutter", "blade", ((120, 118, 115),), "lo", (105, 103, 100))
rule(r"lectern$", "lectern", "lectern", ((150, 110, 60),), "lo", (130, 95, 52))
rule(r"cauldron$", "cauldron", "cauldron", ((60, 60, 62),), "lo", (52, 52, 55))
rule(r"composter$", "composter", "composter", ((150, 100, 55),), "lo", (130, 86, 48))
rule(r"lodestone$", "lodestone", "lodestone", ((130, 130, 135),), "lo", (110, 110, 116))
rule(r"respawn_anchor$", "respawn_anchor", "anchor", ((40, 30, 60),), "lo", (35, 26, 52))
rule(r"trial_spawner", "trial_spawner", "spawner", ((60, 90, 95),), "lo", (48, 72, 76))
rule(r"spawner$", "spawner", "spawner", ((60, 60, 70),), "lo", (45, 45, 55))
rule(r"conduit$", "conduit", "sealantern", ((220, 190, 140),), "lo", (170, 145, 105))
rule(r"dispenser$", "dispenser", "dispenser", ((120, 120, 120),), "lo", (102, 102, 102))
rule(r"dropper$", "dropper", "dispenser", ((110, 110, 108),), "lo", (95, 95, 93))
rule(r"observer$", "observer", "observer", ((120, 120, 122),), "lo", (102, 102, 105))
rule(r"sticky_piston$", "sticky_piston", "piston", ((120, 118, 115), True), "lo", (100, 100, 98))
rule(r"^piston$|piston_head|moving_piston", "piston", "piston", ((120, 118, 115),), "lo", (100, 100, 98))
rule(r"hopper$", "hopper", "hopper", ((80, 80, 85),), "lo", (68, 68, 73))
rule(r"target$", "target", "target", (), "lo", (200, 120, 110))
rule(r"daylight_detector", "daylight_detector", "daylight", ((140, 120, 90),), "lo", (120, 102, 76))
rule(r"redstone_lamp", "redstone_lamp", "lamp", ((200, 120, 60),), "lo", (140, 80, 40))
rule(r"repeater|comparator", "repeater", "repeater", ((150, 150, 152),), "lo", (120, 120, 122))
rule(r"redstone_torch", "redstone_torch", "wire", ((250, 40, 40),), "lo", (150, 25, 25))
rule(r"redstone_wire|redstone_block$", "redstone_wire", "wire", ((250, 40, 40),), "lo", (150, 25, 25))
rule(r"^lever$", "lever", "lever", ((120, 90, 55),), "lo", (100, 80, 50))
rule(r"tripwire_hook", "tripwire_hook", "lever", ((140, 100, 60),), "lo", (115, 85, 52))
rule(r"vault$|ominous_vault", "vault", "lodestone", ((180, 150, 80),), "lo", (140, 118, 66))
rule(r"creaking_heart", "creaking_heart", "face", ((200, 170, 120),), "lo", (165, 140, 100))
rule(r"heavy_core", "heavy_core", "crystal", ((120, 130, 140),), "lo", (95, 105, 115))

# --- rails & small redstone -----------------------------------------------------------
rule(r"powered_rail$", "powered_rail", "rail", ((220, 180, 80), True), "lo", (170, 130, 60))
rule(r"detector_rail$", "detector_rail", "rail", ((160, 160, 165), True), "lo", (130, 130, 135))
rule(r"activator_rail$", "activator_rail", "rail", ((180, 90, 80), True), "lo", (150, 75, 66))
rule(r"_rail$|^rail$", "rail", "rail", ((150, 150, 155),), "lo", (120, 120, 125))
rule(r"weighted_pressure", "weighted_plate", "small", ((220, 180, 80), True), "lo", (170, 130, 60))
rule(r"pressure_plate$", "plate", "small", ((160, 160, 160), True), "lo", (130, 130, 130))
rule(r"_button$", "button", "small", ((160, 160, 160),), "lo", (130, 130, 130))

# --- light sources ---------------------------------------------------------------------
rule(r"soul_torch", "soul_torch", "torch", ((80, 220, 230),), "lo", (50, 160, 170))
rule(r"(^|_)torch$", "torch", "torch", ((250, 200, 90),), "hi", (180, 140, 60))
rule(r"soul_lantern", "soul_lantern", "lantern", ((45, 45, 50), (80, 220, 230)), "lo", (38, 38, 44))
rule(r"^lantern$", "lantern", "lantern", ((60, 58, 55),), "hi", (50, 48, 46))
rule(r"soul_campfire", "soul_campfire", "campfire", ((80, 220, 230),), "lo", (50, 140, 150))
rule(r"campfire$", "campfire", "campfire", ((250, 170, 60),), "lo", (150, 100, 45))
rule(r"end_rod$", "end_rod", "torch", ((240, 235, 220),), "lo", (190, 185, 170))
rule(r"ochre_froglight$", "ochre_froglight", "glowdots", ((250, 220, 150),), "lo", (180, 150, 90))
rule(r"verdant_froglight$", "verdant_froglight", "glowdots", ((180, 240, 180),), "lo", (120, 170, 120))
rule(r"pearlescent_froglight$", "pearlescent_froglight", "glowdots", ((240, 190, 240),), "lo", (170, 130, 170))
rule(r"glow_lichen$", "glow_lichen", "vine", ((150, 170, 150),), "lo", (110, 130, 110))
rule(r"sea_pickle$", "sea_pickle", "glowdots", ((160, 220, 120),), "lo", (110, 160, 85))

# --- plants ------------------------------------------------------------------------------
rule(r"wheat$|carrots$|potatoes$|beetroots$|torchflower_crop|pitcher_crop",
     "wheat", "crop", ((230, 200, 80),), "lo", (150, 140, 60))
rule(r"melon_stem|pumpkin_stem|attached", "stem", "tuft", ((110, 170, 60),), "lo", (90, 140, 52))
rule(r"^melon$", "melon", "melon", ((140, 200, 90), (60, 130, 50)), "hi", (110, 170, 70))
rule(r"pumpkin$|jack_o_lantern", "pumpkin", "melon", ((220, 140, 40), (180, 105, 25)), "hi", (190, 120, 32))
rule(r"cactus$", "cactus", "cactus", ((90, 160, 70),), "lo", (75, 135, 58))
rule(r"sugar_cane$", "sugar_cane", "kelp", ((150, 200, 120),), "lo", (120, 165, 95))
rule(r"kelp", "kelp", "kelp", ((90, 150, 70),), "lo", (75, 125, 58))
rule(r"weeping_vines|twisting_vines", "weeping_vines", "vine", ((180, 60, 70),), "lo", (140, 50, 58))
rule(r"vine$", "vine", "vine", ((70, 140, 60),), "lo", (60, 115, 50))
rule(r"dead_bush$", "dead_bush", "tuft", ((140, 110, 60),), "lo", (115, 90, 50))
rule(r"seagrass", "seagrass", "tuft", ((80, 150, 90),), "lo", (65, 125, 75))
rule(r"lily_pad$", "lily_pad", "flat", ((70, 150, 80),), "lo", (60, 125, 68))
rule(r"mangrove_roots", "mangrove_roots", "vine", ((110, 70, 50),), "lo", (90, 58, 42))
rule(r"flowering_azalea", "flowering_azalea", "flower", ((230, 140, 170),), "lo", (175, 110, 135))
rule(r"^azalea$", "azalea", "tuft", ((120, 160, 80),), "lo", (100, 135, 68))
rule(r"mushroom_block|mushroom_stem", "mushroom_block", "speckle", ((150, 60, 55), (230, 225, 215)), "lo", (130, 52, 48))
rule(r"brown_mushroom", "brown_mushroom", "mushroom", ((145, 110, 80),), "lo", (120, 90, 66))
rule(r"red_mushroom", "red_mushroom", "mushroom", ((200, 60, 50),), "lo", (160, 50, 42))
rule(r"nether_wart_block$", "nether_wart_block", "wart", ((130, 30, 30),), "lo", (105, 26, 26))
rule(r"nether_wart$", "nether_wart", "wart", ((160, 40, 40),), "lo", (130, 32, 32))
rule(r"warped_wart_block", "warped_wart_block", "wart", ((40, 110, 105),), "lo", (34, 92, 88))
rule(r"chorus_plant", "chorus_plant", "crystal", ((150, 100, 160),), "lo", (120, 80, 130))
rule(r"chorus_flower", "chorus_flower", "flower", ((220, 180, 220),), "lo", (170, 130, 170))
rule(r"cocoa$", "cocoa", "nest", ((140, 100, 50),), "lo", (115, 82, 42))
rule(r"bee_nest$", "bee_nest", "nest", ((200, 160, 80),), "lo", (165, 130, 66))
rule(r"beehive$", "beehive", "nest", ((190, 140, 70),), "lo", (155, 115, 58))
rule(r"honeycomb_block$", "honeycomb_block", "hex", ((220, 150, 50),), "lo", (180, 122, 42))
rule(r"honey_block$", "honey_block", "honey", ((240, 180, 60),), "lo", (190, 140, 50))
rule(r"slime_block$", "slime_block", "slime", ((110, 200, 120),), "lo", (85, 160, 95))
rule(r"turtle_egg|sniffer_egg", "turtle_egg", "egg", ((230, 225, 200),), "lo", (190, 185, 165))
rule(r"dragon_egg", "dragon_egg", "egg", ((20, 15, 25), (120, 60, 160)), "lo", (18, 14, 24))
rule(r"frogspawn", "frogspawn", "egg", ((150, 120, 80),), "lo", (120, 96, 66))
rule(r"torchflower$", "torchflower", "flower", ((240, 150, 60),), "lo", (180, 115, 50))
rule(r"rose_bush|peony|lilac|sunflower", "tall_flowers", "flower", ((220, 70, 80),), "lo", (170, 58, 66))
rule(r"_tulip$|allium|azure_bluet|cornflower|lily_of_the_valley|oxeye_daisy|dandelion|^poppy$|blue_orchid|wither_rose|eyeblossom|pink_petals|wildflowers|leaf_litter|dry_grass|sagebrush|firefly_bush|bush$|shrub|^grass$|short_grass|tall_grass|fern$|large_fern|flower_bed",
     "flowers", "flower", ((220, 80, 90),), "lo", (160, 70, 80))
rule(r"flower_pot$", "flower_pot", "pot", ((150, 90, 70),), "lo", (125, 75, 58))

# --- glass ---------------------------------------------------------------------------------
rule(r"tinted_glass$", "tinted_glass", "glass", ((60, 50, 70),), "lo", (50, 42, 60))
rule(r"^glass$|^glass_pane$", "glass", "glass", ((220, 240, 245),), "hi", (170, 210, 220), "cutout")

# --- water world -----------------------------------------------------------------------------
rule(r"coral_block$", "coral_block", "wart", ((220, 120, 150),), "lo", (180, 100, 125))
rule(r"coral_fan$|_coral$", "coral", "coral", ((230, 130, 160),), "lo", (185, 105, 130))
rule(r"wet_sponge$", "wet_sponge", "sponge", ((160, 160, 90),), "lo", (130, 130, 75))
rule(r"sponge$", "sponge", "sponge", ((200, 190, 90),), "lo", (165, 155, 75))
rule(r"dried_ghast", "dried_ghast", "wart", ((200, 190, 180),), "lo", (165, 155, 148))
rule(r"happy_ghast", "happy_ghast", "skull", ((240, 240, 240),), "lo", (200, 200, 200))

# --- misc structures ---------------------------------------------------------------------------
rule(r"iron_bars$", "iron_bars", "bars", ((200, 200, 205),), "lo", (160, 160, 165))
rule(r"(^|_)chain$", "chain", "chain", ((60, 60, 68),), "lo", (50, 50, 58))
rule(r"ladder$", "ladder", "ladder", ((150, 110, 60),), "lo", (125, 92, 50))
rule(r"scaffolding$", "scaffolding", "scaffold", ((194, 178, 83),), "lo", (160, 148, 70))
rule(r"skull$|_head$|^head$", "skull", "skull", ((220, 220, 210),), "lo", (180, 180, 172))
rule(r"end_portal_frame", "end_portal_frame", "portal", ((90, 160, 120),), "lo", (75, 130, 100))
rule(r"portal$", "portal", "portal", ((120, 60, 200),), "lo", (95, 48, 160))
rule(r"lightning_rod", "lightning_rod", "lever", ((220, 120, 80),), "lo", (180, 100, 66))
rule(r"decorated_pot", "decorated_pot", "pot", ((180, 120, 90),), "lo", (150, 100, 75))
rule(r"crafter$", "crafter", "craft", ((90, 90, 95),), "lo", (75, 75, 80))
rule(r"bubble_column", "water", "drop", ((230, 240, 255),), "lo", (60, 110, 190))

# --- coloured families (before the generic fallbacks below) -------------------------------------
for cname, c in COLORS.items():
    rule(rf"^{cname}_wool$", f"{cname}_wool", "wool", (c,), "lo", shade(c, 0.8))
    rule(rf"^{cname}_carpet$", f"{cname}_carpet", "carpet", (c,), "lo", shade(c, 0.8))
    rule(rf"^{cname}_concrete_powder$", f"{cname}_concrete_powder", "powder", (c,), "lo", shade(c, 0.8))
    rule(rf"^{cname}_concrete$", f"{cname}_concrete", "flat", (c,), "lo", shade(c, 0.8))
    rule(rf"^{cname}_glazed_terracotta$", f"{cname}_glazed_terracotta", "glazed", (c,), "lo", shade(c, 0.8))
    rule(rf"^{cname}_terracotta$", f"{cname}_terracotta", "flat", (shade(c, 0.9),), "lo", shade(c, 0.75))
    rule(rf"^{cname}_stained_glass", f"{cname}_stained_glass", "glass", (light(c, 1.2),),
         "lo", shade(c, 0.9), "cutout")
    rule(rf"^{cname}_bed$", f"{cname}_bed", "carpet", (c,), "lo", shade(c, 0.8))
    rule(rf"^{cname}_candle$", f"{cname}_candle", "candle", (c,), "lo", shade(c, 0.85))
    rule(rf"^{cname}_candle_cake$", f"{cname}_candle", "candle", (c,), "lo", shade(c, 0.85))
    rule(rf"^{cname}_shulker_box$", f"{cname}_shulker_box", "chest", (c, (200, 200, 200)), "lo", shade(c, 0.8))
    rule(rf"^{cname}_banner$", f"{cname}_banner", "carpet", (c,), "lo", shade(c, 0.8))
rule(r"^terracotta$", "terracotta", "glazed", ((150, 95, 70),), "lo", (125, 80, 60))
rule(r"glazed_terracotta$", "glazed_terracotta", "glazed", ((150, 95, 70),), "lo", (125, 80, 60))
rule(r"terracotta$", "terracotta", "flat", ((150, 95, 70),), "lo", (125, 80, 60))
rule(r"concrete_powder$", "concrete_powder", "powder", ((220, 220, 220),), "lo", (180, 180, 180))
rule(r"concrete$", "concrete", "flat", ((220, 220, 220),), "lo", (180, 180, 180))
rule(r"wool$", "wool", "wool", ((240, 240, 240),), "lo", (200, 200, 200))
rule(r"carpet$", "carpet", "carpet", ((240, 240, 240),), "lo", (200, 200, 200))
rule(r"stained_glass", "stained_glass", "glass", ((220, 240, 245),), "lo", (170, 210, 220), "cutout")
rule(r"candle$", "candle", "candle", ((240, 240, 230),), "lo", (200, 200, 190))
rule(r"shulker_box$", "shulker_box", "chest", ((150, 100, 150), (200, 200, 200)), "lo", (125, 84, 125))
rule(r"banner$", "banner", "carpet", ((200, 60, 60),), "lo", (160, 50, 50))
rule(r"bed$", "bed", "carpet", ((200, 60, 60),), "lo", (160, 50, 50))

rule(r"packed_mud", "packed_mud", "flat", ((100, 80, 66),), "lo", (88, 70, 58))
rule(r"cobweb", "cobweb", "vine", ((230, 230, 230),), "lo", (190, 190, 190))
rule(r"soul_fire", "soul_fire", "flame", ((80, 220, 230),), "lo", (50, 160, 170))
rule(r"^fire$", "fire", "flame", ((250, 160, 50),), "hi", (180, 100, 40))
rule(r"tripwire$", "tripwire", "wire", ((160, 160, 160),), "lo", (120, 120, 120))
rule(r"command_block|jigsaw|structure_block", "command_block", "craft", ((140, 110, 90),), "lo", (115, 90, 74))
rule(r"(iron|gold)_(door|trapdoor)", "iron_door", "door", ((220, 220, 220),), "lo", (180, 180, 185))
rule(r"petrified_oak", "petrified_oak", "log", ((150, 130, 90), (120, 100, 70)), "lo", (130, 110, 80))
rule(r"hay_block", "hay_block", "layers", ((200, 170, 50), (170, 140, 40)), "lo", (180, 152, 45))
rule(r"dried_kelp_block", "dried_kelp_block", "layers", ((60, 70, 40), (45, 55, 30)), "lo", (52, 62, 36))
rule(r"dead_.*coral", "dead_coral", "coral", ((150, 140, 130),), "lo", (125, 116, 108))
rule(r"coral", "coral", "coral", ((230, 130, 160),), "lo", (185, 105, 130))
rule(r"frosted_ice", "frosted_ice", "ice", ((170, 205, 245),), "lo", (140, 180, 228), "translucent")
rule(r"pitcher_plant|spore_blossom", "tall_flowers", "flower", ((230, 140, 170),), "lo", (180, 110, 135))
rule(r"cactus_flower|cactus_flower", "flowers", "flower", ((240, 150, 170),), "lo", (180, 115, 130))
rule(r"crimson_fungus", "crimson_fungus", "mushroom", ((200, 60, 50),), "lo", (160, 50, 42))
rule(r"warped_fungus", "warped_fungus", "mushroom", ((60, 160, 150),), "lo", (48, 128, 120))
rule(r"nether_sprouts", "nether_sprouts", "tuft", ((60, 160, 150),), "lo", (48, 128, 120))
rule(r"hanging_roots", "hanging_roots", "vine", ((140, 100, 80),), "lo", (115, 82, 66))
rule(r"cave_vines", "cave_vines", "vine", ((90, 150, 70),), "lo", (75, 125, 58))
rule(r"dripleaf", "dripleaf", "tuft", ((90, 160, 80),), "lo", (75, 135, 66))
rule(r"end_gateway|end_portal$", "portal", "portal", ((120, 60, 200),), "lo", (95, 48, 160))
rule(r"^light$", "light", "lamp", ((250, 250, 210),), "lo", (200, 200, 170))
rule(r"barrier|structure_void|void_air|cave_air|movement_block|test_block|test_instance", "void", "none", (), "lo", (0, 0, 0), "empty")
rule(r"^air$", "void", "none", (), "lo", (0, 0, 0), "empty")
rule(r"^bedrock$", "bedrock", "speckle", ((55, 55, 55), (18, 18, 18), 26), "hi", (45, 45, 45))
rule(r"candle_cake$", "cake", "cake", (), "lo", (200, 120, 130))
rule(r"hanging_moss", "hanging_moss", "vine", ((200, 210, 200),), "lo", (165, 175, 165))

# --- fallback -------------------------------------------------------------------------------------
rule(r".*", "unknown", "speckle", ((120, 120, 120), (90, 90, 90)), "lo", (105, 105, 105))


# vanilla renders these blocks with RenderType.cutout(), so a transparent
# background makes them look like themselves instead of opaque video cubes
SPRITE_FAMILIES = {
    "torch", "soul_torch", "copper_torch", "redstone_torch", "wire",
    "lantern", "soul_lantern", "copper_lantern", "campfire", "soul_campfire",
    "rail", "powered_rail", "detector_rail", "activator_rail",
    "lever", "tripwire_hook", "lightning_rod", "repeater",
    "ladder", "chain", "iron_bars", "scaffolding", "cobweb",
    "spawner", "trial_spawner", "hopper", "anvil", "grindstone",
    "stonecutter", "bell", "conduit", "brewing_stand", "cauldron",
    "sea_pickle", "cake", "flower_pot", "lily_pad",
    "amethyst_cluster", "pointed_dripstone", "chorus_plant", "chorus_flower",
    "flowers", "tall_flowers", "torchflower", "flowering_azalea", "wheat",
    "stem", "azalea", "grass", "dead_bush", "seagrass", "dripleaf",
    "nether_sprouts", "vine", "glow_lichen", "weeping_vines", "cave_vines",
    "hanging_moss", "hanging_roots", "mangrove_roots", "kelp",
    "coral", "dead_coral", "brown_mushroom", "red_mushroom",
    "crimson_fungus", "warped_fungus", "nether_wart", "frogspawn", "fire",
    "soul_fire",
}
SPRITE_FAMILIES |= {f"{w}_sapling" for w in WOODS}
SPRITE_FAMILIES |= {f"{c}_candle" for c in COLORS}
SPRITE_FAMILIES |= {"candle"}


def build_family_specs():
    specs = {}
    for pattern, key, glyph, params, tier, tint, alpha in RULES:
        if key not in specs:
            specs[key] = {
                "glyph": glyph, "params": list(params), "tier": tier,
                "tint": list(tint) if tint else [120, 120, 120],
                "alpha": "sprite" if key in SPRITE_FAMILIES else alpha,
            }
    return specs


# these are rendered with the baked fluid strips, not with a family strip
FLUID_BLOCKS = {"water": "water", "bubble_column": "water", "lava": "lava"}


def normalise(block_id: str) -> str:
    for pattern, repl in NORMALISE:
        block_id = re.sub(pattern, repl, block_id)
    return block_id


DERIVATIVES = ("_stairs", "_slab", "_wall", "_fence_gate", "_fence",
               "_pressure_plate", "_button", "_hanging_sign", "_wall_sign",
               "_wall_hanging_sign", "_sign", "_shelf", "_trapdoor", "_door")


def match_id(nid: str, compiled, fallback):
    for rx, key in compiled:
        if rx.search(nid):
            return key
    for suffix in DERIVATIVES:
        if nid.endswith(suffix):
            base = nid[: -len(suffix)]
            for rx, key in compiled:
                if rx.search(base):
                    return key
    for rx, key in fallback:
        if rx.search(nid):
            return key
    return "unknown"


def map_blocks(block_ids):
    mapping = {}
    # the catch-all fallback must not run before derivative suffix stripping
    main_rules = [r for r in RULES if r[1] != "unknown"]
    fallback = [r for r in RULES if r[1] == "unknown"]
    compiled = [(re.compile(p), k) for p, k, *_ in main_rules]
    fallback = [(re.compile(p), k) for p, k, *_ in fallback]
    for bid in block_ids:
        if bid in FLUID_BLOCKS:
            continue
        mapping[bid] = match_id(normalise(bid), compiled, fallback)
    return mapping


def render_badge(spec):
    fn = GLYPHS[spec["glyph"]]
    icon = fn(*spec["params"])
    return outline(icon)


def compose_frame(video_frame, spec, badge, size):
    tint = tuple(spec["tint"])
    edge = max(1, size // 16)
    frame = video_frame.resize((size, size), Image.BILINEAR).convert("RGBA")
    px = frame.load()
    tr, tg, tb = tint
    q = 255 // (LEVELS - 1)
    for y in range(size):
        for x in range(size):
            r, g, b, _a = px[x, y]
            r = int(r * LUM * (1 - MIX) + tr * MIX)
            g = int(g * LUM * (1 - MIX) + tg * MIX)
            b = int(b * LUM * (1 - MIX) + tb * MIX)
            px[x, y] = (round(r / q) * q, round(g / q) * q, round(b / q) * q, 255)
    d = ImageDraw.Draw(frame)
    if spec["alpha"] == "solid":
        d.rectangle([0, 0, size - 1, size - 1], outline=tint + (255,), width=edge)
        if size >= 32:
            d.rectangle([2, 2, size - 3, size - 3], outline=(0, 0, 0, 150), width=1)
    elif spec["alpha"] == "cutout":
        # transparent middle: the block really is see-through in game
        inset = 2 * edge
        inner = Image.new("RGBA", (size - 2 * inset, size - 2 * inset), (0, 0, 0, 0))
        frame.paste(inner, (inset, inset))
        d = ImageDraw.Draw(frame)
        d.rectangle([0, 0, size - 1, size - 1], outline=tint + (255,), width=edge)
        d.rectangle([inset - 1, inset - 1, size - inset, size - inset],
                    outline=tint + (120,), width=1)
    elif spec["alpha"] == "sprite":
        frame = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        d = ImageDraw.Draw(frame)
    elif spec["alpha"] == "empty":
        return Image.new("RGBA", (size, size), (0, 0, 0, 0))
    else:  # translucent
        a = frame.split()[3].point(lambda v: 200)
        frame.putalpha(a)
        d = ImageDraw.Draw(frame)
        d.rectangle([0, 0, size - 1, size - 1], outline=tint + (255,), width=edge)
    big = badge if badge.size == (size, size) else badge.resize((size, size), Image.NEAREST)
    frame.alpha_composite(big, (0, 0))
    return frame


def main():
    block_ids = json.loads((ROOT / "block_ids.json").read_text(encoding="utf-8"))
    mapping = map_blocks(block_ids)
    specs = build_family_specs()

    src = Image.open(SOURCE_STRIP)
    w = src.size[0]
    total = src.size[1] // w
    frames = [src.crop((0, i * w, w, (i + 1) * w)) for i in range(total)]

    FAM_DIR.mkdir(parents=True, exist_ok=True)
    for old in FAM_DIR.glob("*.png"):
        old.unlink()

    families_out = {}
    used = sorted(set(mapping.values()))
    for key in used:
        spec = specs[key]
        n = HI_FRAMES if spec["tier"] == "hi" else LO_FRAMES
        size = SIZE_HI if spec["tier"] == "hi" else SIZE_LO
        step = total / n
        badge = render_badge(spec)
        strip = Image.new("RGBA", (size, size * n))
        for i in range(n):
            f = compose_frame(frames[int(i * step)], spec, badge, size)
            strip.paste(f, (0, i * size))
        if spec["alpha"] == "solid":
            strip = strip.convert("P", palette=Image.ADAPTIVE, colors=256)
        strip.save(FAM_DIR / f"{key}.png", optimize=True)
        families_out[key] = {
            **spec,
            "frames": n,
            "frametime": HI_FRAMETIME if spec["tier"] == "hi" else LO_FRAMETIME,
            "size": size,
        }
        print(f"{key:28} {spec['tier']}  {n:3} frames  "
              f"{(FAM_DIR / (key + '.png')).stat().st_size:>7} bytes")

    # fluids: baked tint + droplet/flame badge
    fluid_specs = {
        "water": {"tint": (40, 90, 200), "lum": 0.8, "mix": 0.5,
                  "glyph": ("drop", ((230, 240, 255),)), "alpha": 190},
        "lava": {"tint": (230, 90, 20), "lum": 0.95, "mix": 0.55,
                 "glyph": ("flame", ((255, 200, 60),)), "alpha": 255},
    }
    for name, fs in fluid_specs.items():
        badge = outline(GLYPHS[fs["glyph"][0]](*fs["glyph"][1]))
        big = badge.resize((SIZE_HI, SIZE_HI), Image.NEAREST)
        strip = Image.new("RGBA", (SIZE_HI, SIZE_HI * total))
        tr, tg, tb = fs["tint"]
        for i in range(total):
            f = frames[i].resize((SIZE_HI, SIZE_HI), Image.BILINEAR).convert("RGBA")
            px = f.load()
            for y in range(SIZE_HI):
                for x in range(SIZE_HI):
                    r, g, b, _a = px[x, y]
                    px[x, y] = (int(r * fs["lum"] * 0.5 + tr * fs["mix"]),
                                int(g * fs["lum"] * 0.5 + tg * fs["mix"]),
                                int(b * fs["lum"] * 0.5 + tb * fs["mix"]),
                                fs["alpha"])
            f.alpha_composite(big, (0, 0))
            strip.paste(f, (0, i * SIZE_HI))
        strip.save(ASSETS / f"anime_girl_{name}.png", optimize=True)
        print(f"anime_girl_{name}.png   {total} frames  "
              f"{(ASSETS / (name and f'anime_girl_{name}.png')).stat().st_size} bytes")

    out = {
        "size": SIZE_HI,
        "blocks": mapping,
        "families": families_out,
        "fluids": {"frametime": FLUID_FRAMETIME, "frames": total},
    }
    FAMILIES_JSON.write_text(json.dumps(out, separators=(",", ":")),
                             encoding="utf-8")
    print(f"{len(used)} families for {len(block_ids)} blocks -> "
          f"{FAMILIES_JSON.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
