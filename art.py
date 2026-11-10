"""Terminal rendering for wheelspin.

The Desktop pane draws a real canvas wheel; this module is the CLI/text half, so
the same spin is visible in the CLI, the TUI, Discord and a plain gateway chat.
Kept dependency-free and deterministic so it can be unit-tested.
"""

from __future__ import annotations

from typing import Any, Sequence

SHADES = "█▓▒░"


def _allocate(weights: Sequence[int], width: int) -> list[int]:
    """Split ``width`` cells across ``weights`` proportionally (largest remainder).

    Guarantees: the cells sum to exactly ``width`` when every item can get at
    least one, and every item gets at least one cell when ``len(weights) <= width``.
    """
    count = len(weights)
    if count == 0 or width <= 0:
        return [0] * count
    total = sum(weights) or 1
    exact = [weight * width / total for weight in weights]
    cells = [int(value) for value in exact]
    if count <= width:
        for index in range(count):
            if cells[index] == 0:
                cells[index] = 1
    remainder = width - sum(cells)
    if remainder > 0:
        order = sorted(range(count), key=lambda i: (-(exact[i] - int(exact[i])), i))
        for step in range(remainder):
            cells[order[step % count]] += 1
    elif remainder < 0:
        # Trim from the widest sectors first, never below one cell.
        order = sorted(range(count), key=lambda i: (-cells[i], i))
        for step in range(-remainder):
            index = order[step % count]
            if cells[index] > 1:
                cells[index] -= 1
    return cells


def render_art(
    items: Sequence[dict[str, Any]],
    winner_index: int | None = None,
    *,
    width: int = 44,
    title: str = "",
    jackpot: bool = False,
) -> str:
    """Render the wheel as a boxed strip plus a legend.

    Every line starts at column 0 and the pointer marker sits *inside* the strip,
    so the drawing survives a model re-typing it into a code fence: there is no
    leading-whitespace alignment to lose. Rendered here, verified in tests.
    """
    if not items:
        return "(empty wheel)"

    weights = [int(item["weight"]) for item in items]
    total = sum(weights) or 1
    cells = _allocate(weights, width)

    # Sector bodies: alternating shades so adjacent sectors never merge, winner solid.
    body = []
    for index, cell in enumerate(cells):
        if index == winner_index:
            body.append("█" * max(cell, 0))
        else:
            body.append((("▓") if index % 2 == 0 else ("░")) * max(cell, 0))
    strip = "".join(body)
    strip = strip[:width].ljust(width, "·")

    # Pointer lives in the strip itself: replace the winning cell with ▼.
    if winner_index is not None and 0 <= winner_index < len(cells):
        centre = sum(cells[:winner_index]) + max(1, cells[winner_index]) // 2
        column = min(max(centre, 0), width - 1)
        strip = strip[:column] + "▼" + strip[column + 1 :]

    header = title or "wheel"
    room = width - 4
    if len(header) > room:
        header = header[: room - 1] + "…"
    pad = width - len(header) - 2
    left = pad // 2
    right = pad - left

    lines = [
        "╭" + "─" * left + " " + header + " " + "─" * right + "╮",
        "│" + strip + "│",
        "╰" + "─" * width + "╯",
    ]

    # Legend: winner first, then by weight, capped so a 200-item wheel stays readable.
    ranked = sorted(range(len(items)), key=lambda i: (-weights[i], i))
    if winner_index is not None and winner_index in ranked:
        ranked.remove(winner_index)
        ranked.insert(0, winner_index)

    shown = ranked[:8]
    label_width = min(26, max((len(str(items[i]["label"])) for i in shown), default=4))
    bar_width = 10
    for index in shown:
        share = weights[index] / total
        filled = max(0, min(bar_width, round(share * bar_width)))
        star = "★" if index == winner_index else "·"
        number = f"{index + 1:>3}"
        raw_name = str(items[index]["label"]).upper()
        name = raw_name[:label_width]
        if len(raw_name) > label_width:
            name = (raw_name[: label_width - 1] + "…") if label_width > 1 else "…"
        name = name.ljust(label_width)
        lines.append(
            f"{star}{number} {name} {'█' * filled}{'·' * (bar_width - filled)} {share * 100:5.1f}%"
        )
    if len(items) > len(shown):
        lines.append(f"      … and {len(items) - len(shown)} more")

    if jackpot:
        inner = 32
        text = "✦ ✦ ✦  JACKPOT!!!  ✦ ✦ ✦"
        pad = max(0, inner - len(text))
        left_pad = pad // 2
        lines.append("")
        lines.append("╔" + "═" * inner + "╗")
        lines.append("║" + " " * left_pad + text + " " * (pad - left_pad) + "║")
        lines.append("╚" + "═" * inner + "╝")

    return "\n".join(lines)


def render_result(spin: dict[str, Any]) -> str:
    """Full text block for one spin result: art + headline."""
    path = spin.get("path") or []
    is_jackpot = bool(spin.get("jackpot"))

    # Big wheels feed through belts; the last stage holds the sector that won.
    # `draw_hierarchical` always sets `path`, so there is no fallback: a spin
    # result without one is a bug, not a case to render an empty belt for.
    if not path:
        raise KeyError("spin result has no path")
    stage = path[-1]
    shown = [
        {"label": label, "weight": weight}
        for label, weight in zip(stage["labels"], stage["weights"])
    ]
    stage_index = stage["chosen"]
    belts = int(spin.get("belts") or 1)
    title = f"wheel: {spin['wheel']}"
    if belts > 1 and path:
        chain = " › ".join(str(stage["chosen"] + 1) for stage in path[:-1])
        title += f" — belt {chain} of {belts}"

    art_text = (
        render_art(shown, stage_index, title=title, jackpot=is_jackpot) if shown else ""
    )
    labels = ", ".join(w["label"] for w in spin["winners"])
    if is_jackpot:
        # The proceedings flag is "any winner was a jackpot", so the headline
        # must not disappear just because the draw asked for more than one.
        headline = f"JACKPOT!!! ★ The wheel says: {labels}"
    else:
        headline = f"★ The wheel says: {labels}"
    return (art_text + "\n\n" + headline).strip() if art_text else headline
