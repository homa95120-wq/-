#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""
check_no_float.py — Статический CI-гейт детерминизма для simcore/.
Запрещает float, double, long double, malloc/calloc/realloc/free, new/delete,
rand/srand, std::chrono, std::vector/string/map/unordered_map в simcore/.
"""

from __future__ import annotations
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SIMCORE_DIR = ROOT / "simcore"

STRIP_COMMENTS_STRINGS = re.compile(
    r'//.*?$|/\*.*?\*/|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'',
    re.DOTALL | re.MULTILINE,
)

FORBIDDEN_PATTERNS = [
    (r"\bfloat\b", "forbidden floating-point type 'float'"),
    (r"\bdouble\b", "forbidden floating-point type 'double'"),
    (r"\bmalloc\b|\bcalloc\b|\brealloc\b|\bfree\b", "forbidden C heap allocation"),
    (r"\bnew\b|\bdelete\b", "forbidden C++ heap allocation"),
    (r"\brand\s*\(|\bsrand\s*\(", "forbidden non-deterministic C RNG"),
    (r"std::chrono", "forbidden host wall-clock dependency std::chrono"),
    (r"std::(vector|string|map|unordered_map|list|deque)\b", "forbidden heap-backed STL container"),
    (r"#include\s*<(cmath|math\.h|chrono|vector|string|map|unordered_map|iostream|fstream)>", "forbidden header in simcore"),
]


def check_file(path: Path) -> list[str]:
    raw = path.read_text(encoding="utf-8")
    # Заменяем комментарии и строковые литералы пробелами с сохранением переводов строк
    def repl(m: re.Match[str]) -> str:
        s = m.group(0)
        return "".join("\n" if ch == "\n" else " " for ch in s)

    cleaned = STRIP_COMMENTS_STRINGS.sub(repl, raw)
    errors: list[str] = []
    for line_no, line in enumerate(cleaned.splitlines(), start=1):
        for pat, desc in FORBIDDEN_PATTERNS:
            if re.search(pat, line):
                errors.append(f"{path.relative_to(ROOT)}:{line_no}: {desc}: {line.strip()}")
    return errors


def main() -> int:
    files = sorted(
        list(SIMCORE_DIR.rglob("*.hpp"))
        + list(SIMCORE_DIR.rglob("*.h"))
        + list(SIMCORE_DIR.rglob("*.cpp"))
    )
    if not files:
        print("[check_no_float] ERROR: no simcore source/header files found!", file=sys.stderr)
        return 1

    all_errors: list[str] = []
    for f in files:
        all_errors.extend(check_file(f))

    if all_errors:
        print(f"[check_no_float] FAILED with {len(all_errors)} violation(s):", file=sys.stderr)
        for err in all_errors:
            print("  ", err, file=sys.stderr)
        return 1

    print(f"[check_no_float] PASS: {len(files)} simcore files verified (0 float/heap/OS violations).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
