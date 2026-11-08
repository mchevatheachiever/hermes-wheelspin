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



HOOK = re.compile(r"\b(use[A-Z][A-Za-z0-9]*)\s*\(")
REACT_IMPORT = re.compile(r"import\s*\{([^}]*)\}\s*from\s*'react'")
SDK_IMPORT = re.compile(r"import\s*\{([^}]*)\}\s*from\s*'@hermes/plugin-sdk'")
HOOK_GLOBALS = {"useMemo"}  # add exceptions here if a hook arrives another way


def check_hooks(path: Path) -> list[str]:
    """Every useX() call must be imported — an unimported hook throws on mount.

    This is the second variant of the same failure: the file is valid syntax,
    `node --check` is happy, and the pane only explodes when it renders.
    """
    source = path.read_text(encoding="utf-8")
    imported = set()
    for pattern in (REACT_IMPORT, SDK_IMPORT):
        for match in pattern.finditer(source):
            for name in match.group(1).split(","):
                imported.add(name.split(" as ")[-1].strip())
    problems = []
    for name in sorted(set(HOOK.findall(source))):
        if name in imported or name in HOOK_GLOBALS:
            continue
        line = next((n for n, text in enumerate(source.splitlines(), 1) if f"{name}(" in text), 0)
        problems.append(f"{path}:{line}: {name}() is called but never imported")
    return problems



AREA_USE = re.compile(r"area:\s*([A-Z][A-Z0-9_]+)")
IDENT_DECL = re.compile(r"(?:const|let|var|function)\s+([A-Z][A-Z0-9_]*)")


def check_sdk_constants(path: Path) -> list[str]:
    """`area: SOME_CONSTANT` must resolve — an unimported one throws inside register().

    That throw happens *after* earlier registrations have landed, so the plugin
    half-works: the pane appears and the palette command silently never does.
    """
    source = path.read_text(encoding="utf-8")
    imported = set()
    for pattern in (REACT_IMPORT, SDK_IMPORT):
        for match in pattern.finditer(source):
            for name in match.group(1).split(","):
                imported.add(name.split(" as ")[-1].strip())
    declared = set(IDENT_DECL.findall(source))
    problems = []
    for name in sorted(set(AREA_USE.findall(source))):
        if name in imported or name in declared:
            continue
        line = next((n for n, text in enumerate(source.splitlines(), 1) if f"area: {name}" in text), 0)
        problems.append(f"{path}:{line}: area: {name} is not imported or declared")
    return problems



QUOTED_CONST = re.compile(r"area:\s*'([A-Z][A-Z0-9_]*)'")


def check_quoted_areas(path: Path) -> list[str]:
    """`area: 'SOME_CONSTANT'` is a string, not the constant — it silently lands
    in an area nobody reads, so the contribution just never appears."""
    source = path.read_text(encoding="utf-8")
    return [
        f"{path}:{n}: area: '{name}' is a string literal — pass the constant"
        for n, text in enumerate(source.splitlines(), 1)
        for name in QUOTED_CONST.findall(text)
    ]


def main() -> int:
    targets = [Path(arg) for arg in sys.argv[1:]] or [Path("desktop/plugin.js")]
    problems: list[str] = []
    for target in targets:
        if target.exists():
            problems.extend(check(target))
            problems.extend(check_hooks(target))
            problems.extend(check_sdk_constants(target))
            problems.extend(check_quoted_areas(target))
    for problem in problems:
        print(problem)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
