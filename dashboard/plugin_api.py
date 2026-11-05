"""WheelSpin backend routes — mounted at /api/plugins/wheelspin/.

The Desktop pane and the agent tools share one store, so a list the model loads
shows up on the wheel with no hand-off, and a spin started by a click is the
same draw the agent would have made.

Note: no ``from __future__ import annotations`` here on purpose — pydantic
resolves model annotations at class-creation time, and stringised annotations
break when the module is imported by file path (which is how plugin APIs load).
"""

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

PLUGIN_ROOT = Path(__file__).resolve().parent.parent


def _load_core() -> Any:
    """Import core.py by path — plugin_api is loaded outside the plugin package."""
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


class WheelPayload(BaseModel):
    name: str = Field(default="wheel", max_length=60)
    items: Any = Field(default_factory=list)
    mode: str = Field(default="replace", pattern="^(replace|append)$")
    source: str = Field(default="", max_length=200)


class SpinPayload(BaseModel):
    count: int = Field(default=1, ge=1, le=10)


def _store() -> Any:
    return core.WheelStore()


def _state() -> dict[str, Any]:
    state = _store().read()
    wheels = list(state["wheels"].values())
    wheels.sort(key=lambda wheel: wheel["updated_at"], reverse=True)
    return {
        "active": state["active"],
        "wheels": [
            {
                "id": wheel["id"],
                "name": wheel["name"],
                "items": wheel["items"],
                "source": wheel["source"],
                "updated_at": wheel["updated_at"],
                "total_weight": core.total_weight(wheel["items"]),
            }
            for wheel in wheels
        ],
        "history": state["history"][-12:],
    }


@router.get("/wheels")
async def list_wheels() -> dict[str, Any]:
    try:
        return {"ok": True, **_state()}
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"wheel store unreadable: {exc}") from exc


@router.post("/wheels")
async def upsert_wheel(payload: WheelPayload) -> dict[str, Any]:
    try:
        wheel = _store().upsert(
            payload.name, payload.items, mode=payload.mode, source=payload.source
        )
    except core.WheelError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"wheel store unwritable: {exc}") from exc
    return {"ok": True, "wheel": wheel, **_state()}


@router.post("/wheels/{wheel_id}/spin")
async def spin_wheel(wheel_id: str, payload: SpinPayload | None = None) -> dict[str, Any]:
    count = (payload or SpinPayload()).count
    try:
        result = _store().spin(wheel_id, count=count)
    except core.WheelError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"wheel store unreadable: {exc}") from exc
    return {"ok": True, **result}


@router.delete("/wheels/{wheel_id}")
async def delete_wheel(wheel_id: str) -> dict[str, Any]:
    try:
        wheel = _store().delete(wheel_id)
    except core.WheelError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"wheel store unwritable: {exc}") from exc
    return {"ok": True, "removed": wheel["name"], **_state()}


@router.get("/health")
async def health() -> dict[str, Any]:
    """Cheap probe the pane uses to tell 'no wheels' from 'no backend'."""
    try:
        state = _store().read()
        json.dumps(state["wheels"], default=str)
    except Exception as exc:  # noqa: BLE001 - reported, not raised
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "wheels": len(state["wheels"])}
