#!/usr/bin/env python3
"""Package and validate the FreeView vanilla datapack."""

from pathlib import Path
import json
import zipfile

ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "dist" / "FreeViewVanilla-1.21.10.zip"
REQUIRED = [
    Path("pack.mcmeta"),
    Path("data/freeview/function/help.mcfunction"),
    Path("data/freeview/function/camera.mcfunction"),
    Path("data/freeview/function/survival.mcfunction"),
    Path("data/freeview/function/flight_on.mcfunction"),
    Path("data/freeview/function/flight_off.mcfunction"),
    Path("data/freeview/function/glow_on.mcfunction"),
    Path("data/freeview/function/glow_off.mcfunction"),
]


def main() -> None:
    for relative in REQUIRED:
        if not (ROOT / relative).is_file():
            raise SystemExit(f"Missing datapack file: {relative}")

    metadata = json.loads((ROOT / "pack.mcmeta").read_text(encoding="utf-8"))
    pack = metadata["pack"]
    if pack.get("min_format") != [88, 0] or pack.get("max_format") != [88, 0]:
        raise SystemExit("pack.mcmeta must target data pack format 88.0 (Minecraft 1.21.10)")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUTPUT, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for relative in REQUIRED:
            archive.write(ROOT / relative, relative.as_posix())

    with zipfile.ZipFile(OUTPUT) as archive:
        names = set(archive.namelist())
        missing = {relative.as_posix() for relative in REQUIRED} - names
        if missing:
            raise SystemExit(f"Archive is missing files: {sorted(missing)}")
        if "pack.mcmeta" not in names:
            raise SystemExit("pack.mcmeta must be at the archive root")

    print(f"Built {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
