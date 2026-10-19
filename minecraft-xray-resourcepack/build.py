#!/usr/bin/env python3
"""Build an anime-themed block texture pack for Minecraft Java 1.21.10."""

from __future__ import annotations

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "dist" / "AnimeGirlBlocks-1.21.10.zip"
BLOCK_IDS = ROOT / "block_ids.json"
PACK_META = ROOT / "pack.mcmeta"
TEXTURE = ROOT / "assets" / "anime_girl.png"
MODEL_PATH = "assets/minecraft/models/block/anime_girl_cube.json"
MODEL = {
    "parent": "minecraft:block/cube_all",
    "textures": {"all": "minecraft:block/anime_girl"},
}
ITEM_MODEL = {"parent": "minecraft:block/anime_girl_cube"}
BLOCKSTATE = {
    "multipart": [
        {"apply": {"model": "minecraft:block/anime_girl_cube"}}
    ]
}
FLUID_TEXTURES = (
    "water_still.png",
    "water_flow.png",
    "water_overlay.png",
    "lava_still.png",
    "lava_flow.png",
)


def main() -> None:
    if not PACK_META.is_file() or not BLOCK_IDS.is_file() or not TEXTURE.is_file():
        raise SystemExit("pack.mcmeta, block_ids.json, or anime_girl.png is missing")

    metadata = json.loads(PACK_META.read_text(encoding="utf-8"))
    pack = metadata.get("pack", {})
    if pack.get("min_format") != [69, 0] or pack.get("max_format") != [69, 0]:
        raise SystemExit("pack.mcmeta must target resource pack format 69.0 (Java 1.21.10)")

    block_ids = json.loads(BLOCK_IDS.read_text(encoding="utf-8"))
    if len(block_ids) < 1000 or len(block_ids) != len(set(block_ids)):
        raise SystemExit("block_ids.json must contain a unique list of Minecraft block IDs")
    if any(not name or "/" in name or ":" in name for name in block_ids):
        raise SystemExit("Block IDs must be unnamespaced names without path separators")

    texture_bytes = TEXTURE.read_bytes()
    if not texture_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        raise SystemExit("anime_girl.png is not a valid PNG")
    blocks_to_replace = [block_id for block_id in block_ids if block_id != "air"]
    blockstate_bytes = json.dumps(BLOCKSTATE, separators=(",", ":")).encode("utf-8")
    model_bytes = json.dumps(MODEL, separators=(",", ":")).encode("utf-8")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(OUTPUT, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr("pack.mcmeta", PACK_META.read_bytes())
        archive.writestr("pack.png", texture_bytes)
        archive.writestr(MODEL_PATH, model_bytes)
        archive.writestr("assets/minecraft/textures/block/anime_girl.png", texture_bytes)
        item_model_bytes = json.dumps(ITEM_MODEL, separators=(",", ":")).encode("utf-8")
        for block_id in blocks_to_replace:
            archive.writestr(f"assets/minecraft/blockstates/{block_id}.json", blockstate_bytes)
            archive.writestr(f"assets/minecraft/models/item/{block_id}.json", item_model_bytes)
        for texture in FLUID_TEXTURES:
            archive.writestr(f"assets/minecraft/textures/block/{texture}", texture_bytes)

    with ZipFile(OUTPUT) as archive:
        names = set(archive.namelist())
        required = {
            "pack.mcmeta",
            "pack.png",
            MODEL_PATH,
            "assets/minecraft/textures/block/anime_girl.png",
            "assets/minecraft/blockstates/stone.json",
            "assets/minecraft/blockstates/diamond_ore.json",
            "assets/minecraft/blockstates/chest.json",
            "assets/minecraft/models/item/stone.json",
            "assets/minecraft/models/item/diamond_ore.json",
        }
        required.update(f"assets/minecraft/textures/block/{texture}" for texture in FLUID_TEXTURES)
        missing = required - names
        if missing:
            raise SystemExit(f"Archive is missing required files: {sorted(missing)}")
        if "assets/minecraft/blockstates/air.json" in names:
            raise SystemExit("Air must not be replaced")
        for name in names:
            if name.endswith(".json"):
                json.loads(archive.read(name))

    print(
        f"Built {OUTPUT.relative_to(ROOT)} "
        f"({OUTPUT.stat().st_size} bytes; {len(blocks_to_replace)} block types replaced)"
    )


if __name__ == "__main__":
    main()
