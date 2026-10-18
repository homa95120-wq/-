#!/usr/bin/env python3
"""Build dist/CampaignThreatRadar.zip - the script (ZIP) version of the mod.

The archive contains exactly two files, in the archive root:

    mod.hjson          (from scriptmod/mod.hjson, NOT the Java mod's one:
                        no `main`, no `java: true`, different internal name)
    scripts/main.js    (from scriptmod/scripts/main.js)

Why a .zip works: Mindustry's Mods.load() keeps every entry of the mods
folder that is a *.jar, a *.zip, or a directory containing a mod meta
file (core/src/mindustry/mod/Mods.java in v160.7), and loadScripts()
then runs scripts/main.js of every enabled mod. Java is not involved.

The build is reproducible: entries are written in a fixed order with a
fixed timestamp, so rebuilding the same sources gives the same SHA-256.

Usage:  python3 scriptmod/build.py [--output PATH]
"""

import argparse
import hashlib
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent

ENTRIES = [
    (HERE / "mod.hjson", "mod.hjson"),
    (HERE / "scripts" / "main.js", "scripts/main.js"),
]

# Fixed DOS timestamp (the ZIP epoch) for reproducibility.
FIXED_DATE = (1980, 1, 1, 0, 0, 0)


def fail(message: str) -> "SystemExit":
    return SystemExit(f"build.py: error: {message}")


def check_sources() -> None:
    for source, _ in ENTRIES:
        if not source.is_file():
            raise fail(f"missing source file: {source}")

    meta = (HERE / "mod.hjson").read_text(encoding="utf-8")
    # A script mod must NOT declare a Java entry point: with `main` or
    # `java: true` the loader treats it as a Java mod (LoadedMod.isJava())
    # and tries to load a class that is not in the archive.
    for forbidden in ("main:", "java:"):
        if any(line.strip().startswith(forbidden) for line in meta.splitlines()):
            raise fail(f"script mod.hjson must not contain '{forbidden}' - it would be loaded as a Java mod")
    if "name: campaign-threat-radar-zip" not in meta:
        raise fail("script mod.hjson must keep the internal name 'campaign-threat-radar-zip' "
                   "(it must differ from the Java mod, or the game refuses the second one)")


def build(output: Path) -> Path:
    check_sources()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source, arcname in ENTRIES:
            info = zipfile.ZipInfo(arcname, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, source.read_bytes())
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=REPO / "dist" / "CampaignThreatRadar.zip")
    args = parser.parse_args()

    output = build(args.output)
    data = output.read_bytes()
    print(f"{output}  {len(data)} bytes  sha256={hashlib.sha256(data).hexdigest()}")
    with zipfile.ZipFile(output) as archive:
        for name in archive.namelist():
            print(f"  {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
