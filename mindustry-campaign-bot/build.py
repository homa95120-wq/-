#!/usr/bin/env python3
"""Build SerpuloCampaignBot.zip — the standalone script (ZIP) version of the mod.

The archive contains exactly two files at its root:
    mod.hjson        (from mindustry-campaign-bot/scriptmod/mod.hjson)
    scripts/main.js  (from mindustry-campaign-bot/scriptmod/scripts/main.js)

Reproducible build: fixed DOS epoch timestamp and entry order produce an
identical SHA-256 on every run.
"""

import argparse
import hashlib
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPTMOD = HERE / "scriptmod"

ENTRIES = [
    (SCRIPTMOD / "mod.hjson", "mod.hjson"),
    (SCRIPTMOD / "scripts" / "main.js", "scripts/main.js"),
]

FIXED_DATE = (1980, 1, 1, 0, 0, 0)


def fail(message: str) -> SystemExit:
    return SystemExit(f"build.py: error: {message}")


def check_sources() -> None:
    for source, _ in ENTRIES:
        if not source.is_file():
            raise fail(f"missing source file: {source}")

    meta = (SCRIPTMOD / "mod.hjson").read_text(encoding="utf-8")
    for forbidden in ("main:", "java:"):
        if any(line.strip().startswith(forbidden) for line in meta.splitlines()):
            raise fail(f"script mod.hjson must not contain '{forbidden}'")
    if "name: serpulo-campaign-bot-zip" not in meta:
        raise fail("script mod.hjson must declare 'name: serpulo-campaign-bot-zip'")
    if "hidden: true" not in meta:
        raise fail("script mod.hjson must declare 'hidden: true'")


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
    parser.add_argument(
        "--output",
        type=Path,
        default=HERE / "release" / "SerpuloCampaignBot.zip",
    )
    args = parser.parse_args()

    output = build(args.output)
    data = output.read_bytes()
    names = zipfile.ZipFile(output).namelist()
    if names != ["mod.hjson", "scripts/main.js"]:
        raise fail(f"unexpected zip entries: {names}")

    print(f"{output}  {len(data)} bytes  sha256={hashlib.sha256(data).hexdigest()}")
    for name in names:
        print(f"  {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
