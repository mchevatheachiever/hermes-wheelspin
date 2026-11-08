#!/usr/bin/env python3
"""Catch dead React setters in a desktop plugin before the renderer does.

The failure this exists for: a `setFoo(...)` call outlives the
`const [foo, setFoo] = useState(...)` line it belonged to. `node --check` sees
valid syntax; the ReferenceError only fires when the component mounts, and the
user sees "failed to render".

Usage: python3 scripts/check_setters.py [plugin.js]  (exit 1 on a dead setter)
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

DECL = re.compile(r"const\s*\[\s*\w+\s*,\s*(set[A-Z]\w*)\s*\]\s*=\s*useState")
# A setter may also be a useCallback wrapper (persisting a preference, etc.).
DECL_CB = re.compile(r"const\s+(set[A-Z]\w*)\s*=\s*useCallback")
CALL = re.compile(r"\b(set[A-Z]\w*)\s*\(")

# Browser/DOM/WebAudio APIs that merely share the setX shape.
GLOBALS = {
    "setInterval", "setTimeout", "setTransform", "setValueAtTime",
    "setTargetAtTime", "setLineDash", "setAttribute", "setProperty",
    "setItem", "setRequestHeader", "setSelectionRange", "setRangeText",
}


def check(path: Path) -> list[str]:
    source = path.read_text(encoding="utf-8")
    declared = set(DECL.findall(source)) | set(DECL_CB.findall(source))
    problems = []
    for name in sorted(set(CALL.findall(source)) - declared - GLOBALS):
        # A setter may legitimately come from somewhere else (props/context);
        # only flag names that look like a hook setter for a state the file
        # itself declares nowhere and never receives.
        if f"[{name[3:].lower()}" in source:
            continue
        line = next(
            (number for number, text in enumerate(source.splitlines(), 1) if f"{name}(" in text),
            0,
        )
        problems.append(f"{path}:{line}: {name}() is called but never declared with useState")
    return problems


def main() -> int:
    targets = [Path(arg) for arg in sys.argv[1:]] or [Path("desktop/plugin.js")]
    problems: list[str] = []
    for target in targets:
        if target.exists():
            problems.extend(check(target))
    for problem in problems:
        print(problem)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
