#!/usr/bin/env python3
"""Build an animated video-texture pack for Minecraft Java 1.21.10.

Every block (plus water and lava) shows the same animated texture: a
vertical strip of video frames with a .mcmeta animation file. The video's
audio track is installed as the sound of every block interaction
(break/place/step/hit/fall) and of every music disc.

The texture strips and the .ogg are produced by make_animated_texture.py;
this script only validates and packages them (stdlib only, no ffmpeg).
"""

from __future__ import annotations

import json
import struct
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "dist" / "AnimeGirlBlocks-1.21.10.zip"
BLOCK_IDS = ROOT / "block_ids.json"
SOUND_EVENTS = ROOT / "sound_events.json"
PACK_META = ROOT / "pack.mcmeta"
TEXTURE = ROOT / "assets" / "anime_girl.png"
TEXTURE_META = ROOT / "assets" / "anime_girl.png.mcmeta"
FLUID_TEXTURE = ROOT / "assets" / "anime_girl_fluid.png"
POSTER = ROOT / "assets" / "poster.png"
AUDIO = ROOT / "assets" / "video.ogg"
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

# --- Sound toggles -----------------------------------------------------------
# The video audio replaces these sounds. Flip a flag (or drop a verb, e.g.
# "step", if footsteps restarting the track get too chaotic) and rebuild.
ENABLE_BLOCK_SOUNDS = True
ENABLE_DISC_SOUNDS = True
BLOCK_SOUND_VERBS = ("break", "place", "step", "hit", "fall")
SOUND_NAME = "minecraft:video"  # -> assets/minecraft/sounds/video.ogg
SOUND_PATH = "assets/minecraft/sounds/video.ogg"
SOUNDS_JSON_PATH = "assets/minecraft/sounds.json"


def png_frames(data: bytes, label: str) -> int:
    """Return the frame count of a vertical-strip PNG (height / width)."""
    if not data.startswith(b"\x89PNG\r\n\x1a\n") or data[12:16] != b"IHDR":
        raise SystemExit(f"{label} is not a valid PNG")
    width, height = struct.unpack(">II", data[16:24])
    if width == 0 or height % width != 0:
        raise SystemExit(
            f"{label} must be a vertical strip of square frames, got {width}x{height}"
        )
    return height // width


def build_sounds_json(block_events: list[str], disc_events: list[str]) -> bytes:
    sounds: dict[str, object] = {}
    if ENABLE_BLOCK_SOUNDS:
        for event in block_events:
            if event.rsplit(".", 1)[1] in BLOCK_SOUND_VERBS:
                sounds[event] = {
                    "sounds": [{"name": SOUND_NAME}],
                    "replace": True,
                }
    if ENABLE_DISC_SOUNDS:
        for event in disc_events:
            sounds[event] = {
                "sounds": [{"name": SOUND_NAME, "stream": True}],
                "replace": True,
            }
    if not sounds:
        raise SystemExit("no sound events selected; check the sound toggles")
    return json.dumps(sounds, separators=(",", ":")).encode("utf-8")


def main() -> None:
    required_files = (
        PACK_META, BLOCK_IDS, SOUND_EVENTS, TEXTURE, TEXTURE_META,
        FLUID_TEXTURE, POSTER, AUDIO,
    )
    missing_files = [p.name for p in required_files if not p.is_file()]
    if missing_files:
        raise SystemExit(
            f"missing input files: {missing_files} "
            "(regenerate textures/sound with make_animated_texture.py)"
        )

    metadata = json.loads(PACK_META.read_text(encoding="utf-8"))
    pack = metadata.get("pack", {})
    if pack.get("min_format") != [69, 0] or pack.get("max_format") != [69, 0]:
        raise SystemExit("pack.mcmeta must target resource pack format 69.0 (Java 1.21.10)")

    block_ids = json.loads(BLOCK_IDS.read_text(encoding="utf-8"))
    if len(block_ids) < 1000 or len(block_ids) != len(set(block_ids)):
        raise SystemExit("block_ids.json must contain a unique list of Minecraft block IDs")
    if any(not name or "/" in name or ":" in name for name in block_ids):
        raise SystemExit("Block IDs must be unnamespaced names without path separators")

    sound_events = json.loads(SOUND_EVENTS.read_text(encoding="utf-8"))
    block_events = sound_events.get("block", [])
    disc_events = sound_events.get("discs", [])
    if len(block_events) < 100 or not disc_events:
        raise SystemExit("sound_events.json must list block and disc sound events")

    animation = json.loads(TEXTURE_META.read_text(encoding="utf-8")).get("animation", {})
    frametime = animation.get("frametime")
    if not isinstance(frametime, int) or frametime < 1:
        raise SystemExit("anime_girl.png.mcmeta must define animation.frametime >= 1")

    texture_bytes = TEXTURE.read_bytes()
    fluid_bytes = FLUID_TEXTURE.read_bytes()
    poster_bytes = POSTER.read_bytes()
    frames = png_frames(texture_bytes, "anime_girl.png")
    if frames < 2:
        raise SystemExit("anime_girl.png must contain at least 2 animation frames")
    if png_frames(fluid_bytes, "anime_girl_fluid.png") != frames:
        raise SystemExit("fluid strip must have the same frame count as the block strip")
    png_frames(poster_bytes, "poster.png")

    audio_bytes = AUDIO.read_bytes()
    if not audio_bytes.startswith(b"OggS"):
        raise SystemExit("video.ogg is not an Ogg file")

    meta_bytes = TEXTURE_META.read_bytes()
    sounds_bytes = build_sounds_json(block_events, disc_events)
    sound_event_total = len(json.loads(sounds_bytes))

    blocks_to_replace = [block_id for block_id in block_ids if block_id != "air"]
    blockstate_bytes = json.dumps(BLOCKSTATE, separators=(",", ":")).encode("utf-8")
    model_bytes = json.dumps(MODEL, separators=(",", ":")).encode("utf-8")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(OUTPUT, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr("pack.mcmeta", PACK_META.read_bytes())
        archive.writestr("pack.png", poster_bytes)
        archive.writestr(MODEL_PATH, model_bytes)
        archive.writestr("assets/minecraft/textures/block/anime_girl.png", texture_bytes)
        archive.writestr("assets/minecraft/textures/block/anime_girl.png.mcmeta", meta_bytes)
        item_model_bytes = json.dumps(ITEM_MODEL, separators=(",", ":")).encode("utf-8")
        for block_id in blocks_to_replace:
            archive.writestr(f"assets/minecraft/blockstates/{block_id}.json", blockstate_bytes)
            archive.writestr(f"assets/minecraft/models/item/{block_id}.json", item_model_bytes)
        for texture in FLUID_TEXTURES:
            archive.writestr(f"assets/minecraft/textures/block/{texture}", fluid_bytes)
            archive.writestr(f"assets/minecraft/textures/block/{texture}.mcmeta", meta_bytes)
        archive.writestr(SOUND_PATH, audio_bytes)
        archive.writestr(SOUNDS_JSON_PATH, sounds_bytes)

    with ZipFile(OUTPUT) as archive:
        names = set(archive.namelist())
        required = {
            "pack.mcmeta",
            "pack.png",
            MODEL_PATH,
            "assets/minecraft/textures/block/anime_girl.png",
            "assets/minecraft/textures/block/anime_girl.png.mcmeta",
            "assets/minecraft/blockstates/stone.json",
            "assets/minecraft/blockstates/diamond_ore.json",
            "assets/minecraft/blockstates/chest.json",
            "assets/minecraft/models/item/stone.json",
            "assets/minecraft/models/item/diamond_ore.json",
            SOUND_PATH,
            SOUNDS_JSON_PATH,
        }
        for texture in FLUID_TEXTURES:
            required.add(f"assets/minecraft/textures/block/{texture}")
            required.add(f"assets/minecraft/textures/block/{texture}.mcmeta")
        missing = required - names
        if missing:
            raise SystemExit(f"Archive is missing required files: {sorted(missing)}")
        if "assets/minecraft/blockstates/air.json" in names:
            raise SystemExit("Air must not be replaced")
        for name in names:
            if name.endswith((".json", ".mcmeta")):
                json.loads(archive.read(name))
        packed_sounds = json.loads(archive.read(SOUNDS_JSON_PATH))
        if len(packed_sounds) != sound_event_total:
            raise SystemExit("sounds.json event count mismatch in archive")
        for event, entry in packed_sounds.items():
            if entry.get("replace") is not True or not entry.get("sounds"):
                raise SystemExit(f"sounds.json entry {event} must replace vanilla sounds")

    loop_seconds = frames * frametime / 20
    print(
        f"Built {OUTPUT.relative_to(ROOT)} "
        f"({OUTPUT.stat().st_size} bytes; {len(blocks_to_replace)} block types replaced; "
        f"{frames} frames, loop {loop_seconds:.1f} s; {sound_event_total} sound events)"
    )


if __name__ == "__main__":
    main()
