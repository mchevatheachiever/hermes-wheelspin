"""Tool handlers for wheelspin.

Every handler returns a JSON string (``tool_result`` / ``tool_error``) and never
raises — a raise here would surface as a broken tool call, not a helpful message.

The agent-facing payload carries a ``display`` field: a plain-text wheel drawn
with block characters, so the same wheel is visible in the CLI and gateway chats
that have no Desktop canvas.
"""

from __future__ import annotations

import logging
from typing import Any

from tools.registry import tool_error, tool_result

from . import art, core

logger = logging.getLogger(__name__)


def _store() -> core.WheelStore:
    return core.WheelStore()


def _pane_hint(wheel: dict[str, Any]) -> str:
    count = len(wheel["items"])
    total = core.total_weight(wheel["items"])
    tickets = f"{count} options" if total == count else f"{count} options ({total} tickets)"
    return (
        f"{tickets} are on the wheel '{wheel['name']}'. "
        "Open the Wheel pane in Hermes Desktop and press Try your luck."
    )


def wheelspin_load(args: dict, **kwargs: Any) -> str:
    del kwargs
    try:
        wheel = _store().upsert(
            args.get("name") or "wheel",
            args.get("items"),
            mode=str(args.get("mode") or "replace"),
            source=str(args.get("source") or ""),
        )
    except core.WheelError as exc:
        return tool_error(str(exc))
    except OSError as exc:
        return tool_error(f"could not save the wheel: {exc}")

    logger.debug("wheelspin: loaded wheel %s with %d items", wheel["id"], len(wheel["items"]))
    return tool_result(
        {
            "success": True,
            "wheel": wheel["name"],
            "wheel_id": wheel["id"],
            "items": [item["label"] for item in wheel["items"]],
            "total_weight": core.total_weight(wheel["items"]),
            "hint": _pane_hint(wheel),
            "display": art.render_art(wheel["items"], title=f"wheel: {wheel['name']} — not spun yet"),
        }
    )


def wheelspin_spin(args: dict, **kwargs: Any) -> str:
    del kwargs
    store = _store()
    try:
        count = int(args.get("count") or 1)
    except (TypeError, ValueError, OverflowError):
        return tool_error("count must be a whole number")
    try:
        if args.get("items"):
            loaded = store.upsert(args.get("name") or "wheel", args["items"])
            result = store.spin(loaded["id"], count=count)
        else:
            result = store.spin(args.get("name"), count=count)
    except core.WheelError as exc:
        return tool_error(str(exc))
    except OSError as exc:
        return tool_error(f"could not read the wheel: {exc}")

    payload = {
        "success": True,
        **result,
    }
    payload["display"] = art.render_result(payload)
    payload["answer"] = payload["winners"][0]["label"] if len(payload["winners"]) == 1 else [
        winner["label"] for winner in payload["winners"]
    ]
    return tool_result(payload)


def wheelspin_list(args: dict, **kwargs: Any) -> str:
    del args, kwargs
    store = _store()
    try:
        summary = store.summary()
        displays = {}
        for entry in summary["wheels"]:
            try:
                wheel = store.get(entry["id"])
                displays[entry["id"]] = art.render_art(
                    wheel["items"], title=f"wheel: {wheel['name']}"
                )
            except core.WheelError:  # pragma: no cover - raced deletion
                continue
    except OSError as exc:
        return tool_error(f"could not read the wheel store: {exc}")

    if not summary["wheels"]:
        return tool_result(
            {
                "success": True,
                "wheels": [],
                "hint": "No wheels loaded. Call wheelspin_load with a list of options.",
            }
        )
    return tool_result({"success": True, **summary, "displays": displays})


def wheelspin_delete(args: dict, **kwargs: Any) -> str:
    del kwargs
    name = args.get("name")
    if not name:
        return tool_error("name is required")
    try:
        wheel = _store().delete(str(name))
    except core.WheelError as exc:
        return tool_error(str(exc))
    except OSError as exc:
        return tool_error(f"could not update the wheel store: {exc}")
    return tool_result({"success": True, "removed": wheel["name"], "items": len(wheel["items"])})
