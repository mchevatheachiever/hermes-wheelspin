"""WheelSpin core — shared by the agent tool half and the dashboard API half.

Deliberately dependency-free (stdlib only) so it can be imported by
``__init__.py`` inside the plugin package and by ``dashboard/plugin_api.py``
loaded from a file path.

State lives in ``<hermes home>/plugin-data/wheelspin/wheels.json`` and is
written atomically (tmp file + ``os.replace``) under an advisory file lock, so
the tool and the API can both write without truncating each other.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import secrets
import tempfile
import time
from contextlib import contextmanager
from typing import Any, Iterable, Iterator, Mapping, Sequence

try:  # POSIX advisory locking; absent on Windows, where we degrade to no lock.
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None  # type: ignore[assignment]

SCHEMA_VERSION = 1
MAX_ITEMS = 2000
MAX_LABEL_CHARS = 120
MAX_WEIGHT = 1000
MAX_HISTORY = 200
MAX_NAME_CHARS = 60
MAX_JACKPOTS = 3
JACKPOT_SHARE = 0.2  # roughly one hidden jackpot per five options
MAX_SECTORS = 8  # largest wheel that is still readable on screen

_SLUG_RE = re.compile(r"[^a-z0-9]+")
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")


class WheelError(ValueError):
    """Raised for bad user input; callers turn this into a tool_error."""


def plugin_data_dir(name: str = "wheelspin"):
    from plugins.plugin_storage import plugin_data_dir as _dir

    return _dir(name)


# --------------------------------------------------------------------------- #
# item normalisation
# --------------------------------------------------------------------------- #


def _clean_label(raw: Any) -> str:
    if not isinstance(raw, str):
        raise WheelError("every item needs a text label")
    label = _CTRL_RE.sub(" ", raw).strip()
    if not label:
        raise WheelError("item labels cannot be empty")
    return label[:MAX_LABEL_CHARS]


def _clean_weight(raw: Any) -> int:
    if raw is None:
        return 1
    try:
        weight = int(raw)
    except (TypeError, ValueError):
        raise WheelError("weight must be a whole number") from None
    if weight < 1:
        raise WheelError("weight must be at least 1")
    return min(weight, MAX_WEIGHT)


def normalise_items(raw_items: Any) -> list[dict[str, Any]]:
    """Accept ``["a", "b"]`` or ``[{"label": "a", "weight": 3}]`` -> canonical list.

    Duplicate labels are collapsed, summing their weights, because two identical
    sectors are indistinguishable on screen and the second one would never be
    recognised as the winner.
    """
    if isinstance(raw_items, str):
        raw_items = [line for line in raw_items.splitlines()]
    if not isinstance(raw_items, Iterable):
        raise WheelError("items must be a list of labels")

    merged: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for raw in raw_items:
        if isinstance(raw, dict):
            label = _clean_label(raw.get("label", raw.get("text", raw.get("name"))))
            weight = _clean_weight(raw.get("weight"))
        else:
            label = _clean_label(raw)
            weight = 1
        key = label.casefold()
        if key in merged:
            merged[key]["weight"] = min(MAX_WEIGHT, merged[key]["weight"] + weight)
            continue
        merged[key] = {"label": label, "weight": weight}
        order.append(key)
        if len(order) > MAX_ITEMS:
            raise WheelError(f"a wheel holds at most {MAX_ITEMS} items")

    if not order:
        raise WheelError("a wheel needs at least one item")
    return [merged[key] for key in order]


def slugify(name: str) -> str:
    """Stable key for a wheel name.

    The display name is bounded at 60 chars, so slugging a *truncated* name lets
    two long names that differ only in the tail collapse onto one key — the
    second wheel then overwrites the first, silently. Shorten with a hash of the
    full slug instead, so the distinguishing tail still decides the id.
    """
    slug = _SLUG_RE.sub("-", str(name).strip().lower()).strip("-")
    if len(slug) > 48:
        digest = hashlib.sha1(slug.encode("utf-8")).hexdigest()[:8]
        slug = f"{slug[:39].rstrip('-')}-{digest}"
    return slug or "wheel"


def clean_name(name: Any, *, default: str = "wheel") -> str:
    if name is None:
        return default
    if not isinstance(name, str):
        raise WheelError("wheel name must be text")
    text = _CTRL_RE.sub(" ", name).strip()
    if not text:
        return default
    return text[:MAX_NAME_CHARS]


# --------------------------------------------------------------------------- #
# drawing
# --------------------------------------------------------------------------- #


def total_weight(items: Sequence[dict[str, Any]]) -> int:
    return sum(int(item["weight"]) for item in items)


def draw_index(items: Sequence[dict[str, Any]], rng: Any = None) -> int:
    """Weighted draw returning the winning index.

    ``rng`` is anything with ``randrange(n)`` (a ``random.Random`` in tests);
    ``None`` uses ``secrets.randbelow`` for an unbiased cryptographic draw.
    Weights are integer tickets: an item with weight 3 owns 3 of the
    ``total_weight`` tickets. No float maths, so there is no rounding bias.
    """
    if not items:
        raise WheelError("cannot spin an empty wheel")
    total = total_weight(items)
    pick = secrets.randbelow(total) if rng is None else int(rng.randrange(total))
    upto = 0
    for index, item in enumerate(items):
        upto += int(item["weight"])
        if pick < upto:
            return index
    return len(items) - 1  # unreachable for valid weights; keeps the type honest


# --------------------------------------------------------------------------- #
# jackpots
# --------------------------------------------------------------------------- #


def jackpot_count(item_count: int) -> int:
    """How many hidden jackpots a wheel of this size carries (at least one)."""
    if item_count < 2:
        return 0
    return max(1, min(MAX_JACKPOTS, round(item_count * JACKPOT_SHARE)))


def choose_jackpots(item_count: int, rng: Any = None) -> list[int]:
    """Pick distinct hidden jackpot indices uniformly, without replacement.

    Jackpots are cosmetic: they never change the draw. The winner is picked by
    weight first, then simply *revealed* as a jackpot if it happens to be one.
    """
    wanted = jackpot_count(item_count)
    if wanted == 0:
        return []
    pool = list(range(item_count))
    chosen: list[int] = []
    for _ in range(wanted):
        pick = secrets.randbelow(len(pool)) if rng is None else int(rng.randrange(len(pool)))
        chosen.append(pool.pop(pick))
    return sorted(chosen)


def _as_float(value: Any, default: float = 0.0) -> float:
    """Coerce a stored timestamp. A bad value must not raise out of read()."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(number):
        return default
    return number or default


def _as_name(value: Any, default: str) -> str:
    """A stored name that is not text must not raise out of read()."""
    if isinstance(value, str):
        return clean_name(value, default=default)
    return default


def _as_int(value: Any, default: int) -> int:
    """Finite ints only — `int(nan)` and `int(inf)` raise."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(number):
        return default
    return int(number)


def _salvage_items(raw_items: Any) -> list[dict[str, Any]]:
    """Best-effort item list: skip a broken entry, never drop the wheel.

    `normalise_items` is for input and raises on anything it dislikes. A wheel
    that is already stored is not input: losing it would lose the user's data on
    the next write, so a bad row is skipped and the rest are kept.
    """
    if isinstance(raw_items, str):
        raw_items = raw_items.splitlines()
    if not isinstance(raw_items, Iterable) or isinstance(raw_items, Mapping):
        return []
    merged: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for raw in raw_items:
        try:
            if isinstance(raw, dict):
                label = _clean_label(raw.get("label", raw.get("text", raw.get("name"))))
                weight = _clean_weight(raw.get("weight"))
            else:
                label = _clean_label(raw)
                weight = 1
        except WheelError:
            continue
        key = label.casefold()
        if key in merged:
            merged[key]["weight"] = min(MAX_WEIGHT, merged[key]["weight"] + weight)
            continue
        merged[key] = {"label": label, "weight": weight}
        order.append(key)
        if len(order) >= MAX_ITEMS:
            break
    return [merged[key] for key in order]


def _clean_jackpots(raw: Any, item_count: int) -> list[int]:
    if not isinstance(raw, list):
        return choose_jackpots(item_count)
    values = sorted(
        {
            _as_int(v, -1)
            for v in raw
            if _as_int(v, -1) >= 0 and _as_int(v, -1) < item_count
        }
    )
    if not values and item_count >= 2:
        # Every wheel of 2+ options carries at least one jackpot, so an empty or
        # unreadable list is damage, not a decision — re-roll rather than ship a
        # wheel whose jackpot can never fire.
        return choose_jackpots(item_count)
    return values[:MAX_JACKPOTS]


# --------------------------------------------------------------------------- #
# magazines — big wheels feed in belts, like an LMG
# --------------------------------------------------------------------------- #


def magazines(items: Sequence[dict[str, Any]], per: int = MAX_SECTORS) -> list[list[dict[str, Any]]]:
    """Split a wheel into belt-loads of at most ``per`` sectors, order preserved."""
    if per < 2:
        per = 2
    return [list(items[start : start + per]) for start in range(0, len(items), per)]


def draw_hierarchical(
    items: Sequence[dict[str, Any]],
    rng: Any = None,
    per: int = MAX_SECTORS,
) -> dict[str, Any]:
    """Draw one winner, feeding through magazines as needed.

    Picking a magazine by its total weight and then an item inside it by weight is
    an identity, not an approximation::

        P(item) = (W_magazine / W_all) * (w_item / W_magazine) = w_item / W_all

    so a 300-option wheel draws exactly as one flat weighted draw would, while
    never putting more than ``per`` sectors on screen at once.
    """
    if not items:
        raise WheelError("cannot spin an empty wheel")

    per = max(2, _as_int(per, MAX_SECTORS))
    if len(items) <= per:
        index = draw_index(items, rng)
        return {
            "index": index,
            "depth": 1,
            "path": [
                {
                    "kind": "items",
                    "labels": [item["label"] for item in items],
                    "weights": [int(item["weight"]) for item in items],
                    "chosen": index,
                }
            ],
        }

    belts = magazines(items, per)
    belt_items = [
        {"label": f"belt {number + 1}", "weight": total_weight(belt)}
        for number, belt in enumerate(belts)
    ]
    # Stage one: pick the belt. Recursive, so a 2000-option wheel still never
    # puts more than `per` belts on screen at any level.
    belt_draw = draw_hierarchical(belt_items, rng, per)
    belt_index = belt_draw["index"]
    inner = draw_hierarchical(belts[belt_index], rng, per)
    offset = sum(len(belt) for belt in belts[:belt_index])
    path = [
        *belt_draw["path"],
        *inner["path"],
    ]
    return {"index": offset + inner["index"], "depth": belt_draw["depth"] + inner["depth"], "path": path}


# --------------------------------------------------------------------------- #
# store
# --------------------------------------------------------------------------- #


def _empty_state() -> dict[str, Any]:
    return {"version": SCHEMA_VERSION, "active": "", "wheels": {}, "history": []}


class WheelStore:
    """JSON-backed, lock-guarded wheel store."""

    def __init__(self, root=None):
        self.root = root if root is not None else plugin_data_dir("wheelspin")
        self.path = self.root / "wheels.json"
        self.lock_path = self.root / "wheels.lock"

    # -- plumbing ---------------------------------------------------------- #

    @contextmanager
    def _locked(self) -> Iterator[None]:
        self.root.mkdir(parents=True, exist_ok=True)
        handle = open(self.lock_path, "a+")
        try:
            if fcntl is not None:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            yield
        finally:
            try:
                if fcntl is not None:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            finally:
                handle.close()

    def _quarantine(self, *, locked: bool = False) -> None:
        """Move an unreadable store aside so the next write cannot erase it.

        Runs under the store lock unless the caller already holds it: a reader
        that quarantines the file while a writer is mid-replace would otherwise
        move the *fresh* store aside and reset the active path.
        """
        try:
            target = self.path.with_name(f"{self.path.name}.corrupt-{time.time_ns()}")
            if locked:
                os.replace(self.path, target)
            else:
                with self._locked():
                    os.replace(self.path, target)
        except OSError:
            pass

    def _read_state(self, *, locked: bool = False) -> tuple[dict[str, Any], str]:
        """Read the store, reporting *why* it is empty when it is not readable.

        ``status`` is ``ok``, ``corrupt`` (bytes did not decode as the store) or
        ``unreadable`` (the file exists but could not be opened). A corrupt file
        is moved aside before returning, so returning an empty state never
        authorises the next write to overwrite the user's only copy.
        """
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return _empty_state(), "ok"
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._quarantine(locked=locked)
            return _empty_state(), "corrupt"
        except OSError:
            return _empty_state(), "unreadable"
        if not isinstance(raw, dict):
            self._quarantine(locked=locked)
            return _empty_state(), "corrupt"
        state = _empty_state()
        state["active"] = str(raw.get("active") or "")
        history = raw.get("history")
        state["history"] = history[-MAX_HISTORY:] if isinstance(history, list) else []
        wheels = raw.get("wheels")
        if isinstance(wheels, dict):
            for key, wheel in wheels.items():
                clean = self._clean_wheel(str(key), wheel)
                if clean is not None:
                    state["wheels"][clean["id"]] = clean
        if state["active"] not in state["wheels"]:
            state["active"] = next(iter(state["wheels"]), "")
        return state, "ok"

    def read(self, *, locked: bool = False) -> dict[str, Any]:
        return self._read_state(locked=locked)[0]

    def _corrupt_backups(self) -> list[str]:
        try:
            return sorted(p.name for p in self.root.glob(f"{self.path.name}.corrupt-*"))
        except OSError:  # pragma: no cover - unreadable directory
            return []

    def health(self) -> dict[str, Any]:
        """Probe that can tell an empty store from one that just lost its file.

        ``status`` is only honest on the read that discovers the damage — the
        file is gone by the next call — so the quarantine leftovers are reported
        too: ``corrupt_backups: 0`` means nothing was ever moved aside.
        """
        state, status = self._read_state()
        backups = self._corrupt_backups()
        report: dict[str, Any] = {
            "ok": status == "ok",
            "status": status,
            "wheels": len(state["wheels"]),
            "corrupt_backups": len(backups),
        }
        if status == "corrupt":
            # Never the exception text: an OSError carries the store's path.
            report["error"] = "wheel store was corrupt and has been moved aside"
        elif status == "unreadable":
            report["error"] = "wheel store could not be read"
        return report

    @staticmethod
    def _clean_wheel(key: str, wheel: Any) -> dict[str, Any] | None:
        """Coerce a stored wheel without raising, and without dropping it.

        `clean_name` and `_clean_jackpots` used to raise on a non-string name or a
        NaN jackpot, which took the whole read down; and a wheel whose items
        failed normalisation was returned as `None`, so the next write erased it.
        Only a value that is not an object at all is discarded now.
        """
        if not isinstance(wheel, dict):
            return None
        items = _salvage_items(wheel.get("items"))
        return {
            "id": key,
            "name": _as_name(wheel.get("name"), default=key),
            "items": items,
            "jackpots": _clean_jackpots(wheel.get("jackpots"), len(items)),
            "source": str(wheel.get("source") or "")[:200],
            "created_at": _as_float(wheel.get("created_at"), time.time()),
            "updated_at": _as_float(wheel.get("updated_at"), time.time()),
        }

    def write(self, state: dict[str, Any]) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        state["history"] = state.get("history", [])[-MAX_HISTORY:]
        payload = json.dumps(state, indent=2, ensure_ascii=False)
        fd, tmp = tempfile.mkstemp(dir=str(self.root), prefix=".wheels-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, self.path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    # -- operations -------------------------------------------------------- #

    def upsert(
        self,
        name: str,
        items: Any,
        *,
        mode: str = "replace",
        source: str = "",
    ) -> dict[str, Any]:
        if mode not in {"replace", "append"}:
            raise WheelError("mode must be 'replace' or 'append'")
        display = clean_name(name)
        normalised = normalise_items(items)

        with self._locked():
            state = self.read(locked=True)
            # Resolve by key *and* by display name: a wheel written under the old
            # truncated slug would otherwise be duplicated by a re-load under the
            # hashed key.
            wheel_id, existing = self._resolve(state, name)
            now = time.time()
            if existing is not None and mode == "append":
                merged: list[dict[str, Any]] = list(existing["items"])
                index = {item["label"].casefold(): item for item in merged}
                for item in normalised:
                    key = item["label"].casefold()
                    if key in index:
                        index[key]["weight"] = min(
                            MAX_WEIGHT, index[key]["weight"] + item["weight"]
                        )
                    else:
                        merged.append(item)
                        index[key] = item
                items_final = merged[:MAX_ITEMS]
            else:
                items_final = normalised

            wheel = {
                "id": wheel_id,
                "name": display,
                "items": items_final,
                # Jackpots stay put while the options are identical, so a spin
                # cannot be re-rolled by re-loading the same list.
                "jackpots": (
                    existing["jackpots"]
                    if existing and [i["label"] for i in existing["items"]] == [
                        i["label"] for i in items_final
                    ]
                    else choose_jackpots(len(items_final))
                ),
                "source": (source or (existing or {}).get("source") or "")[:200],
                "created_at": (existing or {}).get("created_at") or now,
                "updated_at": now,
            }
            state["wheels"][wheel_id] = wheel
            state["active"] = wheel_id
            self.write(state)
        return wheel

    @staticmethod
    def _resolve(state: dict[str, Any], name: str) -> tuple[str, dict[str, Any] | None]:
        """Find a wheel by key, then by the display name the user can read.

        The second pass is what keeps wheels written before the slug change —
        and any name whose key was cut differently — reachable by their name.
        """
        wanted = clean_name(name)
        wheel_id = slugify(wanted)
        wheel = state["wheels"].get(wheel_id)
        if wheel is None:
            folded = wanted.casefold()
            for key, candidate in state["wheels"].items():
                if candidate["name"].casefold() == folded:
                    return key, candidate
        return wheel_id, wheel

    def get(self, name: str | None = None) -> dict[str, Any]:
        state = self.read()
        wheels = state["wheels"]
        if not wheels:
            raise WheelError("no wheel has been loaded yet")
        if name is None:
            wheel = wheels.get(state["active"]) or next(iter(wheels.values()))
            return wheel
        _, wheel = self._resolve(state, name)
        if wheel is None:
            known = ", ".join(sorted(w["name"] for w in wheels.values()))
            raise WheelError(f"no wheel called {name!r}; known wheels: {known}")
        return wheel

    def delete(self, name: str) -> dict[str, Any]:
        with self._locked():
            state = self.read(locked=True)
            wheel_id, _known = self._resolve(state, name)
            wheel = state["wheels"].pop(wheel_id, None)
            if wheel is None:
                raise WheelError(f"no wheel called {name!r}")
            if state["active"] == wheel_id:
                state["active"] = next(iter(state["wheels"]), "")
            self.write(state)
        return wheel

    def spin(self, name: str | None = None, count: int = 1) -> dict[str, Any]:
        count = max(1, min(10, _as_int(count, 1)))
        wheel = self.get(name)
        draws = [draw_hierarchical(wheel["items"]) for _ in range(count)]
        winners = [draw["index"] for draw in draws]
        now = time.time()
        records = [
            {
                "wheel": wheel["id"],
                "label": wheel["items"][index]["label"],
                "index": index,
                "at": now + position * 1e-6,
            }
            for position, index in enumerate(winners)
        ]
        # Record the draw only when it is unique, so a repeat of the same wheel
        # during a burst does not rewrite the file per spin.
        try:
            with self._locked():
                state = self.read(locked=True)
                state["history"].extend(records)
                self.write(state)
        except OSError:  # read-only home: the draw still stands
            pass
        return {
            "wheel": wheel["name"],
            "wheel_id": wheel["id"],
            "items": len(wheel["items"]),
            "jackpot": any(index in wheel["jackpots"] for index in winners),
            "belts": len(magazines(wheel["items"])) if len(wheel["items"]) > MAX_SECTORS else 1,
            # The UI replays this: one entry per stage, last entry holds the winner.
            "path": draws[0]["path"],
            "winners": [
                {
                    "label": wheel["items"][index]["label"],
                    "index": index,
                    "weight": int(wheel["items"][index]["weight"]),
                    "jackpot": index in wheel["jackpots"],
                    "probability": round(
                        int(wheel["items"][index]["weight"]) / total_weight(wheel["items"]), 6
                    ),
                }
                for index in winners
            ],
        }

    def summary(self) -> dict[str, Any]:
        state = self.read()
        return {
            "active": state["active"],
            "wheels": [
                {
                    "id": wheel["id"],
                    "name": wheel["name"],
                    "items": len(wheel["items"]),
                    "total_weight": total_weight(wheel["items"]),
                    "updated_at": wheel["updated_at"],
                    "source": wheel["source"],
                }
                for wheel in state["wheels"].values()
            ],
            "recent_spins": state["history"][-10:],
        }
