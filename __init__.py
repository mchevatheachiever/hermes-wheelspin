"""wheelspin — a real spinning wheel for Hermes.

Agent half: four tools plus an ASCII rendering so the spin is visible in the
CLI, TUI, gateway chat and Discord. Desktop half: `desktop/plugin.js` draws the
animated canvas wheel and announces the winner back into the conversation.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from . import art, core, schemas
from .tools import wheelspin_delete, wheelspin_list, wheelspin_load, wheelspin_spin

logger = logging.getLogger(__name__)

_ID = "wheelspin"


def _slash_wheel(raw_args: str = "") -> str:
    """`/wheel [name]` — draw and render the text wheel, no model turn involved."""
    name = (raw_args or "").strip() or None
    try:
        store = core.WheelStore()
        result = store.spin(name, count=1)
    except core.WheelError as exc:
        return f"wheel: {exc}"
    except OSError as exc:
        return f"wheel: could not read the store ({exc})"
    payload = {**result}
    return art.render_result(payload)


def register(ctx: Any) -> None:
    ctx.register_tool(
        name="wheelspin_load",
        toolset="wheelspin",
        schema=schemas.LOAD,
        handler=wheelspin_load,
        description="Load a list of options onto the animated Wheel pane in Hermes Desktop.",
    )
    ctx.register_tool(
        name="wheelspin_spin",
        toolset="wheelspin",
        schema=schemas.SPIN,
        handler=wheelspin_spin,
        description="Draw an answer from a loaded wheel right now (CLI/gateway safe, no UI needed).",
    )
    ctx.register_tool(
        name="wheelspin_list",
        toolset="wheelspin",
        schema=schemas.LIST,
        handler=wheelspin_list,
        description="List loaded wheels, their items and recent spin results.",
    )
    ctx.register_tool(
        name="wheelspin_delete",
        toolset="wheelspin",
        schema=schemas.DELETE,
        handler=wheelspin_delete,
        description="Remove a loaded wheel by name.",
    )

    # Bundle the walkthrough skill under the plugin namespace (opt-in load).
    skill_file = Path(__file__).resolve().parent / "skills" / _ID / "SKILL.md"
    if skill_file.exists():
        try:
            ctx.register_skill(_ID, skill_file)
        except Exception as exc:  # pragma: no cover - older Hermes without register_skill
            logger.debug("wheelspin: skill registration skipped: %s", exc)

    # /wheel — draw and print the text wheel without spending a model turn.
    ctx.register_command(
        "wheel",
        _slash_wheel,
        description="Spin a loaded wheel and print it in the transcript",
        args_hint="[wheel name]",
    )

    logger.debug("wheelspin: registered 4 tools (store=%s)", _safe_store_root())


def _safe_store_root() -> str:
    try:
        return str(core.plugin_data_dir(_ID))
    except Exception:  # pragma: no cover - diagnostics only
        return "unresolved"
