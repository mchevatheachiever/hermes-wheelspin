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
    width: int = 48,
    title: str = "",
    jackpot: bool = False,
) -> str:
    """Render a pointer-over-strip wheel plus a legend. Returns plain text."""
    if not items:
        return "(empty wheel)"

    weights = [int(item["weight"]) for item in items]
    total = sum(weights) or 1
    cells = _allocate(weights, width)

    # Sector bodies: alternating shades so adjacent sectors never merge, winner solid.
    body = "".join(
        (
            "█" * max(cell, 0)
            if index == winner_index
            else ("▓" if index % 2 == 0 else "░") * max(cell, 0)
        )
        for index, cell in enumerate(cells)
    )
    if len(body) > width:
        body = body[:width]
    else:
        body = body.ljust(width, "·")

    # Pointer column = centre of the winning sector (0-based within the strip).
    pointer = ""
    marker = ""
    if winner_index is not None and 0 <= winner_index < len(cells):
        start = sum(cells[:winner_index])
        centre = start + max(1, cells[winner_index]) // 2
        column = min(max(centre, 0), width - 1)
        # 3 chars: two spaces then the box's '│', so the glyph lines up with the strip.
        pointer = "   " + " " * column + "▼"
        marker = "   " + " " * column + "★"

    lines = []
    if title:
        lines.append(f"  {title}")
    if pointer:
        lines.append(pointer)
    lines.append("  ┌" + "─" * width + "┐")
    lines.append("  │" + body + "│")
    lines.append("  └" + ("─" * width) + "┘")
    if marker:
        lines.append(marker)

    # Legend: winner first, then by weight, capped so a 200-item wheel stays readable.
    ranked = sorted(range(len(items)), key=lambda i: (-weights[i], i))
    if winner_index is not None and winner_index in ranked:
        ranked.remove(winner_index)
        ranked.insert(0, winner_index)

    shown = ranked[:8]
    label_width = min(28, max((len(str(items[i]["label"])) for i in shown), default=4))
    bar_width = 12
    for index in shown:
        share = weights[index] / total
        filled = max(0, min(bar_width, round(share * bar_width)))
        star = "★" if index == winner_index else " "
        number = f"{index + 1:>2}"
        label = str(items[index]["label"])[:label_width].ljust(label_width)
        lines.append(
            f"  {star}{number} {label}  {'█' * filled}{'·' * (bar_width - filled)}"
            f"  {share * 100:5.1f}%"
        )
    if len(items) > len(shown):
        lines.append(f"      … and {len(items) - len(shown)} more")

    if jackpot:
        inner = 34
        text = "✦ ✦ ✦  JACKPOT!!!  ✦ ✦ ✦"
        pad = max(0, inner - len(text))
        left = pad // 2
        lines.append("")
        lines.append("  ╔" + "═" * inner + "╗")
        lines.append("  ║" + " " * left + text + " " * (pad - left) + "║")
        lines.append("  ╚" + "═" * inner + "╝")

    return "\n".join(lines)


def render_result(spin: dict[str, Any]) -> str:
    """Full text block for one spin result: art + headline."""
    wheel_items = spin.get("items_detail") or []
    winner = spin["winners"][0]
    is_jackpot = bool(spin.get("jackpot"))
    art_text = (
        render_art(
            wheel_items,
            winner["index"],
            title=f"wheel: {spin['wheel']}",
            jackpot=is_jackpot,
        )
        if wheel_items
        else ""
    )
    if len(spin["winners"]) > 1:
        headline = "★ The wheel says: " + ", ".join(w["label"] for w in spin["winners"])
    elif is_jackpot:
        headline = f"JACKPOT!!! ★ The wheel says: {winner['label']}"
    else:
        headline = f"★ The wheel says: {winner['label']}"
    return (art_text + "\n\n" + headline).strip() if art_text else headline
