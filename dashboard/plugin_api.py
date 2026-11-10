"""WheelSpin backend routes — mounted at /api/plugins/wheelspin/.

The Desktop pane and the agent tools share one store, so a list the model loads
shows up on the wheel with no hand-off, and a spin started by a click is the
same draw the agent would have made.

Note: no ``from __future__ import annotations`` here on purpose — pydantic
resolves model annotations at class-creation time, and stringised annotations
break when the module is imported by file path (which is how plugin APIs load).
"""

import importlib.util
import logging
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

PLUGIN_ROOT = Path(__file__).resolve().parent.parent


def _load_core() -> Any:
    """Import core.py by path.

    Deliberate, not a workaround to be tidied away: the dashboard loads this
    module outside the plugin package, so a relative import cannot resolve. The
    module is cached under a fixed name so repeated calls reuse one instance.
    """
    existing = sys.modules.get("wheelspin_core")
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location("wheelspin_core", PLUGIN_ROOT / "core.py")
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise ImportError("cannot load wheelspin core")
    module = importlib.util.module_from_spec(spec)
    sys.modules["wheelspin_core"] = module
    spec.loader.exec_module(module)
    return module


core = _load_core()
router = APIRouter()
logger = logging.getLogger(__name__)


class WheelPayload(BaseModel):
    name: str = Field(default="wheel", max_length=60)
    items: Any = Field(default_factory=list)
    mode: str = Field(default="replace", pattern="^(replace|append)$")
    source: str = Field(default="", max_length=200)


class SpinPayload(BaseModel):
    count: int = Field(default=1, ge=1, le=10)


def _store() -> Any:
    return core.WheelStore()


def _state(selected: str | None = None) -> dict[str, Any]:
    """Pane state, one payload per poll.

    Every wheel is listed as a summary (the chip strip needs names and counts,
    nothing else); the full item list is carried only for the wheel that is on
    screen. Sending every item of every wheel made a 22-wheel store a 157 KB
    response every three seconds, almost all of it for wheels nobody was
    looking at.
    """
    state = _store().read()
    wheels = list(state["wheels"].values())
    wheels.sort(key=lambda wheel: wheel["updated_at"], reverse=True)
    chosen = selected if selected in state["wheels"] else state["active"]
    if chosen not in state["wheels"]:
        chosen = wheels[0]["id"] if wheels else ""
    entries: list[dict[str, Any]] = []
    for wheel in wheels:
        entry = {
            "id": wheel["id"],
            "name": wheel["name"],
            "item_count": len(wheel["items"]),
            "source": wheel["source"],
            "updated_at": wheel["updated_at"],
            "total_weight": core.total_weight(wheel["items"]),
        }
        if wheel["id"] == chosen:
            entry["items"] = wheel["items"]
        entries.append(entry)
    return {
        "active": state["active"],
        "items_for": chosen,
        "wheels": entries,
        "history": state["history"][-12:],
    }


@router.get("/wheels")
async def list_wheels(wheel: str | None = None) -> dict[str, Any]:
    try:
        return {"ok": True, **_state(wheel)}
    except OSError as exc:
        logger.warning("wheelspin: wheel store unreadable: %s", exc)
        raise HTTPException(status_code=500, detail="wheel store unreadable") from exc


@router.post("/wheels")
async def upsert_wheel(payload: WheelPayload) -> dict[str, Any]:
    try:
        wheel = _store().upsert(
            payload.name, payload.items, mode=payload.mode, source=payload.source
        )
    except core.WheelError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        logger.warning("wheelspin: wheel store unwritable: %s", exc)
        raise HTTPException(status_code=500, detail="wheel store unwritable") from exc
    # The store's write path answers with the wheel as written, jackpots
    # included. The pane redraws from the next GET anyway, so say what changed
    # without repeating the one thing the tools are supposed to keep quiet.
    public = {k: v for k, v in wheel.items() if k != "jackpots"}
    return {"ok": True, "wheel": public, **_state(wheel["id"])}


@router.post("/wheels/{wheel_id}/spin")
async def spin_wheel(wheel_id: str, payload: SpinPayload | None = None) -> dict[str, Any]:
    count = (payload or SpinPayload()).count
    try:
        result = _store().spin(wheel_id, count=count)
    except core.WheelNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except core.WheelError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        logger.warning("wheelspin: wheel store unreadable: %s", exc)
        raise HTTPException(status_code=500, detail="wheel store unreadable") from exc
    return {"ok": True, **result}


@router.delete("/wheels/{wheel_id}")
async def delete_wheel(wheel_id: str) -> dict[str, Any]:
    try:
        wheel = _store().delete(wheel_id)
    except core.WheelNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except core.WheelError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        logger.warning("wheelspin: store delete failed: %s", exc)
        raise HTTPException(status_code=500, detail="wheel store unwritable") from exc
    return {"ok": True, "removed": wheel["name"], **_state()}


@router.get("/health")
async def health() -> dict[str, Any]:
    """Cheap probe: can the store be read at all, and was it damaged?

    Reports ``corrupt``/``unreadable`` as ``ok: false`` — an empty store and an
    unreadable one must not look the same to a monitor. Never carries exception
    text, because an OSError quotes the store's absolute path.
    """
    try:
        return _store().health()
    except Exception:  # noqa: BLE001 - reported, not raised
        logger.warning("wheelspin: health probe failed", exc_info=True)
        return {"ok": False, "status": "unreadable", "wheels": 0, "error": "wheel store could not be read"}
