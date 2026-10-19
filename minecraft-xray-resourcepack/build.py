#!/usr/bin/env python3
"""Build a Java 1.21.10 client-side see-through-blocks resource pack."""

from __future__ import annotations

import json
import struct
import zlib
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "dist" / "ClientSeeThrough-1.21.10.zip"
BLOCK_IDS = ROOT / "block_ids.json"
PACK_META = ROOT / "pack.mcmeta"
EMPTY_MODEL = {
    "ambientocclusion": False,
    "textures": {},
    "elements": [],
}
BLOCKSTATE = {
    "multipart": [
        {"apply": {"model": "minecraft:block/freeview_empty"}}
    ]
}
FLUID_TEXTURES = (
    "water_still.png",
    "water_flow.png",
    "water_overlay.png",
    "lava_still.png",
    "lava_flow.png",
)


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def transparent_png(size: int = 16) -> bytes:
    """Return a valid transparent RGBA PNG without third-party libraries."""
    scanlines = b"".join(b"\x00" + bytes(size * 4) for _ in range(size))
    header = struct.pack(">2I5B", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", header)
        + png_chunk(b"IDAT", zlib.compress(scanlines, level=9))
        + png_chunk(b"IEND", b"")
    )


def main() -> None:
    if not PACK_META.is_file() or not BLOCK_IDS.is_file():
        raise SystemExit("pack.mcmeta or block_ids.json is missing")

    metadata = json.loads(PACK_META.read_text(encoding="utf-8"))
    pack = metadata.get("pack", {})
    if pack.get("min_format") != [69, 0] or pack.get("max_format") != [69, 0]:
        raise SystemExit("pack.mcmeta must target resource pack format 69.0 (Java 1.21.10)")

    block_ids = json.loads(BLOCK_IDS.read_text(encoding="utf-8"))
    if len(block_ids) < 1000 or len(block_ids) != len(set(block_ids)):
        raise SystemExit("block_ids.json must contain a unique list of Minecraft block IDs")
    if any(not name or "/" in name or ":" in name for name in block_ids):
        raise SystemExit("Block IDs must be unnamespaced names without path separators")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    blockstate_bytes = json.dumps(BLOCKSTATE, separators=(",", ":")).encode("utf-8")
    model_bytes = json.dumps(EMPTY_MODEL, separators=(",", ":")).encode("utf-8")
    pack_meta_bytes = PACK_META.read_bytes()

    with ZipFile(OUTPUT, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr("pack.mcmeta", pack_meta_bytes)
        archive.writestr("assets/minecraft/models/block/freeview_empty.json", model_bytes)
        for block_id in block_ids:
            archive.writestr(f"assets/minecraft/blockstates/{block_id}.json", blockstate_bytes)
        transparent = transparent_png()
        for texture in FLUID_TEXTURES:
            archive.writestr(f"assets/minecraft/textures/block/{texture}", transparent)

    with ZipFile(OUTPUT) as archive:
        names = set(archive.namelist())
        required = {
            "pack.mcmeta",
            "assets/minecraft/models/block/freeview_empty.json",
            "assets/minecraft/blockstates/stone.json",
            "assets/minecraft/blockstates/deepslate.json",
            "assets/minecraft/blockstates/air.json",
        }
        required.update(f"assets/minecraft/textures/block/{texture}" for texture in FLUID_TEXTURES)
        missing = required - names
        if missing:
            raise SystemExit(f"Archive is missing required files: {sorted(missing)}")
        for name in names:
            if name.endswith(".json"):
                json.loads(archive.read(name))

    print(
        f"Built {OUTPUT.relative_to(ROOT)} "
        f"({OUTPUT.stat().st_size} bytes; {len(block_ids)} block overrides)"
    )


if __name__ == "__main__":
    main()
