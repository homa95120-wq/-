#!/usr/bin/env python3
"""Convert a video into animated Minecraft textures + sound for this pack.

Outputs (written into assets/ next to this script):
  anime_girl.png         vertical frame strip used on every block
                         (SIZE x SIZE*frames pixels)
  anime_girl.png.mcmeta  animation timing (frametime in game ticks, 20/s)
  anime_girl_fluid.png   smaller copy of the strip for water/lava textures
                         (fluids are tinted and distorted in game, and the
                         same bytes are shipped five times inside the pack)
  poster.png             one square still frame, used as pack.png
  video.ogg              mono Ogg Vorbis, trimmed to exactly one
                         animation loop so picture and sound stay in sync

After running this, rebuild the pack with:  python3 build.py

Requirements: ffmpeg (on PATH, or `pip install imageio-ffmpeg`) and Pillow
(`pip install pillow`). build.py itself needs neither.

Examples:
  python3 make_animated_texture.py IMG_2145.MOV
  python3 make_animated_texture.py clip.mp4 --size 64 --fps 10 --crop-pos 0.5
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
TICKS_PER_SECOND = 20  # Minecraft runs texture animations at 20 ticks/s


def find_ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        raise SystemExit(
            "ffmpeg not found. Install ffmpeg or run: pip install imageio-ffmpeg"
        )


def run(cmd: list[str]) -> None:
    print("+", " ".join(cmd))
    subprocess.run(cmd, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("video", type=Path, help="input video file")
    parser.add_argument("--size", type=int, default=128,
                        help="block texture size in pixels (default 128)")
    parser.add_argument("--fluid-size", type=int, default=32,
                        help="water/lava texture size in pixels (default 32)")
    parser.add_argument("--fps", type=int, default=10,
                        help="frames per second; must divide 20 (default 10)")
    parser.add_argument("--crop-pos", type=float, default=0.36,
                        help="where the square crop sits along the long side:"
                             " 0 = top/left, 0.5 = center, 1 = bottom/right"
                             " (default 0.36)")
    args = parser.parse_args()

    if not args.video.is_file():
        raise SystemExit(f"video not found: {args.video}")
    if args.fps <= 0 or TICKS_PER_SECOND % args.fps != 0:
        raise SystemExit("--fps must divide 20 (1, 2, 4, 5, 10 or 20), "
                         "because Minecraft frametime is a whole game tick")
    if not 0.0 <= args.crop_pos <= 1.0:
        raise SystemExit("--crop-pos must be between 0 and 1")
    frametime = TICKS_PER_SECOND // args.fps

    try:
        from PIL import Image
    except ImportError:
        raise SystemExit("Pillow not found. Run: pip install pillow")

    ffmpeg = find_ffmpeg()

    # Fail early with a clear message if the video has no audio track.
    probe = subprocess.run([ffmpeg, "-hide_banner", "-i", str(args.video)],
                           capture_output=True, text=True)
    if "Audio:" not in probe.stderr:
        raise SystemExit("video has no audio track; nothing to put in video.ogg")

    # Square crop along the long side (x range is 0 for portrait video and
    # y range is 0 for landscape, so one position value works for both).
    crop = (
        "crop=w='min(iw,ih)':h='min(iw,ih)'"
        f":x='(iw-min(iw,ih))*{args.crop_pos}':y='(ih-min(iw,ih))*{args.crop_pos}'"
    )

    ASSETS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="frames_") as tmp:
        frames_dir = Path(tmp)
        run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
             "-i", str(args.video),
             "-vf", f"fps={args.fps},{crop},scale={args.size}:{args.size}:flags=lanczos",
             str(frames_dir / "%04d.png")])

        frame_paths = sorted(frames_dir.glob("*.png"))
        if len(frame_paths) < 2:
            raise SystemExit(f"only {len(frame_paths)} frame(s) extracted; "
                             "video too short for an animation")
        count = len(frame_paths)
        frames = [Image.open(p).convert("RGB") for p in frame_paths]
        if any(f.size != (args.size, args.size) for f in frames):
            raise SystemExit("unexpected frame size after scaling")

        strip = Image.new("RGB", (args.size, args.size * count))
        for i, frame in enumerate(frames):
            strip.paste(frame, (0, i * args.size))
        strip.save(ASSETS / "anime_girl.png", optimize=True)

        fluid = Image.new("RGB", (args.fluid_size, args.fluid_size * count))
        for i, frame in enumerate(frames):
            fluid.paste(frame.resize((args.fluid_size, args.fluid_size),
                                     Image.LANCZOS), (0, i * args.fluid_size))
        fluid.save(ASSETS / "anime_girl_fluid.png", optimize=True)

        frames[round(count * 0.55)].save(ASSETS / "poster.png", optimize=True)

    mcmeta = {"animation": {"frametime": frametime}}
    (ASSETS / "anime_girl.png.mcmeta").write_text(
        json.dumps(mcmeta, indent=2) + "\n", encoding="utf-8")

    # One animation loop lasts count*frametime ticks; trim/pad the audio to
    # exactly that many seconds so the sound does not drift against frames.
    loop_seconds = count * frametime / TICKS_PER_SECOND
    run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
         "-i", str(args.video), "-vn", "-ac", "1", "-ar", "44100",
         "-af", "loudnorm=I=-15:TP=-1.5:LRA=11,apad",
         "-t", f"{loop_seconds:.3f}",
         "-c:a", "libvorbis", "-q:a", "5",
         str(ASSETS / "video.ogg")])

    for name in ("anime_girl.png", "anime_girl.png.mcmeta",
                 "anime_girl_fluid.png", "poster.png", "video.ogg"):
        path = ASSETS / name
        print(f"{name:24} {path.stat().st_size:>10} bytes")
    print(f"frames: {count} @ {args.fps} fps (frametime {frametime} ticks), "
          f"loop = {loop_seconds:.2f} s")
    print("Now rebuild the pack: python3 build.py")


if __name__ == "__main__":
    main()
