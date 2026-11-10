# Changelog

## 1.2.8 — 2026-11-10

Final pre-publish pass: full read of both halves, README and bundled skill, and
the gates run exactly as the docs print them.

### Fixed
- **`items` accepted a mapping.** A dict is `Iterable`, so `{"items": {"text":
  "milk"}}` iterated its keys and stored an option literally named `text`. Input
  validation now refuses a `Mapping` with a message that says to wrap it in a list;
  the lenient stored-data path (`_salvage_items`) already rejected one.
- **A wheel that exists but cannot be drawn answered 404.** `spin` mapped every
  `WheelError` to 404, so an empty salvaged wheel said "not found" while it was
  right there. `WheelNotFound` is now a distinct error: unknown wheel → 404,
  undrawable wheel → 400.

### Docs
- README: the source-install line (`hermes plugins install <owner>/<repo>`), the
  🎡/🎰 display toggle, and a Development block whose commands were each run as
  written — `python3 -m unittest tests.test_core`, `tests.test_api` (the runtime
  venv has fastapi + httpx), `node --test tests/display.test.mjs`, and
  `hermes plugins validate . --install-deps`.
- Bundled skill version tracks the plugin.

## 1.2.7 — 2026-11-10

One regression from the 1.2.6 quarantine re-check, found in the same review thread.

### Fixed
- **N30 — a non-UTF-8 store raised instead of being quarantined.** `_still_unreadable`
  read the file with `read_text`, and `UnicodeDecodeError` is a `ValueError`, so it
  escaped the `except OSError` in the same method *and* the `OSError` guard around
  the quarantine — the original decode error then propagated out of `read()` and
  `GET /wheels` returned 500. Introduced by the 1.2.6 fix for N22; the earlier
  test used a valid-UTF-8 corrupt payload, so it never exercised this path. The
  decode failure is now treated as "still corrupt" and the file is quarantined as
  before. Tests: the decoder path in the store (bytes preserved in the backup) and
  at the API (`GET /wheels` 200 empty, `/health` reports the backup).

## 1.2.6 — 2026-11-10

Seventh-round fixes from the same review thread: N22 re-opened, N29 new.

### Fixed
- **N22 — the quarantine rename did not verify what it renamed.** Putting the
  rename under the lock was not enough: a reader parses outside the lock, so a
  writer can replace the bad bytes with a fresh store before the reader's rename,
  and the reader then quarantines the *good* file. `_quarantine` now re-checks
  under the lock (`_still_unreadable`) and leaves a store that parses alone.
  Tests: a late quarantine against a fresh store (must not move it) and the
  ordinary corrupt-file path (must still move it).
- **N29 — `OverflowError` escaped the coercers.** `int(float('inf'))` and
  `int(10**400)` raise `OverflowError`, which `_as_float`, `_as_int` and
  `_clean_weight` did not catch, so a valid-JSON store with `weight: 1e400`,
  `jackpots: [10**400]` or a 401-digit `created_at` still 500'd every route. All
  three catch it now; a stored weight that cannot be used falls back to 1 instead
  of costing the option, and `wheelspin_spin` rejects an overflowing `count`.
  Tests: the three stored fields, an input weight of `inf`, and a `count` of
  `1e400`.

### Small
- `render_result` raises `KeyError` on an empty `winners` list instead of
  rendering `★ The wheel says: ` — the same invariant as a missing `path`.
- On a multi-draw jackpot, the drawing now follows the draw the banner is about
  (`paths` + the winning draw's index) instead of always showing draw 1.

## 1.2.5 — 2026-11-10

Second review round (P2P review by monadbot, findings N19–N28). Every item was
reproduced before it was fixed.

### Fixed
- **N19 — the pane could animate a list the backend did not draw from.** A
  same-id load landing inside the 3 s poll window left `itemsRef` stale; an index
  past the end threw out of `sectorGeometry` and left the button on "Good luck…",
  and an equal-length list landed the pointer on the wrong sector. The pane now
  checks `list[target.index].label === target.label`, refetches and re-finds the
  winner by label (labels are unique), and fails cleanly with the spinner cleared.
  `paint()` is wrapped so a draw error can never leave a stuck button.
- **N20 — a manual display-mode choice leaked across wheels.** `userChose` was
  never reset, so after the first 🎰 press no other wheel restored its saved mode.
  It resets when the displayed wheel changes.
- **N21 — semantic corruption raised or was silently erased.** `name: 123` raised
  `WheelError` out of `read()`, `jackpots: [NaN]` raised `ValueError`, and a wheel
  whose items failed normalisation was dropped and then overwritten by the next
  write. Fields are now coerced through `_as_name` / `_as_int` / `_salvage_items`,
  which skip a bad row instead of losing the wheel.
- **N22 — quarantine ran outside the store lock.** A reader could move a freshly
  written store aside. `_quarantine` takes the advisory lock unless the caller
  already holds it (`read(locked=True)` from the write paths).
- **N23 — `/health` was only honest for the first reader.** It now reports
  `corrupt_backups`, so a monitor can tell "always empty" from "just lost its
  store" after the pane's poll has already quarantined the file.
- **N24 — `draw_hierarchical(per=1)` recursed forever.** `per` is clamped to 2 at
  entry, matching what `magazines` always did.
- **N25 — pegs recomputed `sectorGeometry` per peg per frame.** One
  `sectorStarts(items)` before the loop: 2000 items, 4.05 ms → 0.71 ms per frame.
- **N26 — re-loading a legacy long-named wheel duplicated it.** `upsert` resolved
  only by slug; it now adopts the key `_resolve` finds by display name.
- **N27 — a jackpot on a multi-draw was invisible.** `jackpot` is now true if any
  winner is one, and the `JACKPOT!!!` headline takes precedence over the
  multi-winner form in `art.render_result`.
- **N28 — a new `AudioContext` per spin, never closed.** One module-level context
  is shared by every spin.

### Small
- `drawWheel` clamps `radius` to ≥ 4; a squeezed canvas used to produce a negative
  radius and `ctx.arc` throws `IndexSizeError`.
- `wheelspin_spin` rejects a non-numeric `count` with a tool error instead of
  letting `int()` raise out of the handler.
- README: the one-belt description is scoped to spin results; loading a wheel
  prints the whole list.

## 1.2.4 — 2026-11-10

Review round over the whole plugin: data safety, payload size, keys, and the
parts of the pane nothing was testing.

### Fixed
- **A corrupt store was silently erased.** `read()` mapped a decode failure to an
  empty state, so the next write replaced the store with it. The unreadable file
  is now moved aside as `wheels.json.corrupt-<ns>` before an empty state is
  returned, and the write that follows cannot touch it. The old test asserted the
  wipe-prone read; it now asserts the bytes survive.
- **`/health` answered `ok: true` on a damaged store**, making an empty wheel list
  and an unreadable one indistinguishable. It now reports `status` as `ok`,
  `corrupt` or `unreadable`, and `ok: false` for the last two.
- **The pane polled every item of every wheel every three seconds** — 157 KB per
  poll against a 22-wheel store. Every wheel is now a summary (`item_count`,
  `total_weight`); only the wheel on screen carries `items`, selected with
  `?wheel=<id>`. Same store: 41.7 KB, and a few KB against a typical wheel.
- **Two long wheel names could collapse onto one key.** The slug was cut at 48
  chars after the display name was bounded at 60, so names differing only in the
  tail overwrote each other. Truncated slugs now carry a hash of the full name,
  and lookups fall back to the display name so wheels written under the old keys
  stay reachable.
- **HTTP error detail carried the store's absolute path.** `/health` returned
  `str(exc)` and the 500 handlers interpolated the OSError. The detail is now a
  fixed string and the exception is logged.
- **An empty stored `jackpots` list disabled the reveal permanently.** A wheel of
  2+ options always has at least one, so an empty or unreadable list is damage —
  it is now re-rolled instead of trusted.

### Changed
- Peg ticks are driven by the weighted sector boundaries the pegs are drawn at,
  not by `angle / TAU × item count`. A wheel with one 9/10 sector ticked ten
  times a turn; it now ticks once.
- The ticker arm pivots on the rim. It was drawn at a fixed `y = 6`, so on a tall
  pane — where the wheel is centred and smaller than the canvas — it floated in
  empty space above the wheel, pointing at nothing.
- The tape reel derives its cell from the same CSS box the painter uses, and
  re-aims if the pane is resized mid-spin. It read the canvas bitmap width
  (`element.width / devicePixelRatio`) for the target and `getBoundingClientRect`
  for the draw, so a resize between the two left the winning row a few pixels off
  the needle. A zero-sized canvas also produced a negative cabinet; geometry is
  clamped now.
- Removed the pane's unused `box`/`radius` state — the ResizeObserver re-rendered
  on every resize for a value nothing read — and an unused import.
- The pane tolerates a router that predates `items_for`: it falls back to the
  first entry carrying items, so a half-installed upgrade shows the wheel instead
  of "No wheel loaded".

## 1.2.3 — 2026-11-08

### Tests
- **The `render_result` invariant is now protected, not just declared.** N2 removed
  the fallback and made a missing `path` raise `KeyError`; nothing asserted it.
  Two tests: the raise, and a successful render so the guard can't pass by
  accident on a broken happy path.

## 1.2.2 — 2026-11-08

Second review pass (issue #1, N16–N18).

### Fixed
- **`_as_float` accepted `nan` / `inf`.** `float()` takes them happily, so a
  store containing `"created_at": "nan"` came back as NaN and `write()` then
  serialised the literal into `wheels.json` (`json.dumps` allows NaN by default),
  which a strict parser rejects. Non-finite values now fall back to the default.
  Two tests: the coercion itself, and a round-trip proving no `NaN`/`Infinity`
  reaches the file.
- **Duplicate `variant` key** on both mode buttons — the stale `'ghost'` above
  `onClick` was dead text that would eventually be edited by mistake.
- **A dead store read on every spin.** `store.get(result["wheel_id"])` existed
  only to populate `items_detail`; it re-read and re-parsed `wheels.json` outside
  the lock for nothing.

### Changed
- **`art.py` no longer has an unreachable fallback.** `draw_hierarchical` always
  sets `path`, so the `else` branch could only ever render an empty belt. A spin
  result without `path` now raises `KeyError` instead of drawing nothing.

## 1.2.1 — 2026-11-08

Review fixes (issue #1).

### Fixed
- **A bad stored timestamp 500'd every route.** `float()` on `created_at` raised
  `ValueError` straight out of `read()`. `_as_float()` now coerces, defaulting to
  the current time — a read path must never raise on user data. Test writes
  `"created_at": "yesterday"` and proves `read()` still returns the wheel.
- **The spin payload was 59KB for 1,000 items.** `items_detail` carried every item
  and nothing read it once `path` was set (58,903 → 995 bytes).
- **The POST response repeated which slots are jackpots.** Stripped; the pane
  redraws from the next GET anyway.
- **`variant: 'primary'` is not a Button variant in this build** — `default`.
- **Uncompiled class tokens** on the mode buttons and active chip: variants and
  `bg-(--ui-bg-quaternary)` instead, both of which core compiles.
- **`--ui-border` isn't a token here**; `--ui-stroke-secondary` is.
- **A stale error survived a successful paste** — `setError('')` on the success path.
- **Palette spin gave up too early**: the pane mounts a frame or two after
  `openWorkspace`, so the handler wasn't attached. Retries for ~400ms.
- **The text legend truncated with no marker** — now ellipsised.

### Docs
- Real interpreter instructions for the API tests, the `/health` docstring no
  longer claims the pane calls it, and a **Surfaces** note that the text wheel is
  one belt of at most 8 rows.

## 1.2.0 — 2026-11-08

### Changed
- **Auto never switches displays.** A dense wheel stays a wheel, the way the
  streamers' tool does it — labels shrink and truncate rather than the display
  changing shape under you. The reel is opt-in (🎰), and the "too many to label"
  offer row is gone with it.
- **Label size follows the slice, not the wheel**: `clamp(6, 20, radius × 0.062,
  arc × 0.30)`. A sector's arc is the room its label actually has, so a 30-item
  wheel on a wide pane gets big type and a 300-item one stays small.
- **Truncation is geometric**: text stops at the drawn hub or where the slice
  becomes narrower than the text is tall, whichever comes first — not at a fixed
  character count. The old 16-character cap is gone.
- **Greased friction**: K 5.2 → 0.35, MU 0.62 → 0.55. A spin now runs 2–3.4
  turns over ~5–6 seconds with a long slow tail, instead of stopping dead.
- **Every wheel is reachable from the pane.** The chip strip was `slice(0, 6)`,
  so any wheel past the sixth was invisible rather than off-screen. All wheels are
  listed, active first, in a strip that scrolls.

### Fixed
- **The landing didn't respect the pointer.** ±30% of a sector of landing jitter
  put the winner visibly beside the top marker; now ±8%.
- **The jerky finish.** The friction integral could travel past the target, and
  the settle step then pulled it backwards. The step is clamped to the remaining
  distance, so the wheel only ever approaches the target.
- **Labels vanished on long items.** The draw was `if (measured <= room) fillText`
  — with 120-character items that check always failed, so those wheels drew no
  labels at all. It shrinks and truncates now.
- **Rim seam**: sectors overlap by 0.002 rad and the rim is stroked once over the
  finished wheel, so the join where the last sector closes on the first is gone.
- **Stray fragments**: the wheel body is clipped to its rim circle.

### Noted, not fixed
- Faint trailing "ghost" text at 240Hz that does **not** appear in screenshots —
  it is in the compositor or the panel's response time, not the rendered bitmap.

### Tests
- `tests/display.test.mjs` — 14 cases. The four fit-rule tests were removed with
  `labelsFit`/`maxWheelItems`, which the pane no longer consults.

## 1.1.0 — 2026-11-08

### Added
- **Tape reel for wheels too dense to label.** Past the point where a sector is
  narrower than its own label, the pane can show a vertical slot-machine reel
  instead: cells scroll up past a fixed needle, land the winner dead centre, and
  wrap long items over several lines instead of truncating them. The draw itself
  is unchanged — same backend call, same weights, same hidden jackpots.
- **The choice belongs to the user and to the wheel.** `mode:<wheel id>` is
  stored per wheel, so a 6-item wheel stays a wheel after a 666-item one becomes
  a reel. Auto (label it if the sectors can carry labels) is the default; the
  header carries explicit 🎡 / 🎰 buttons, and a wheel that cannot be labelled
  offers "Reel it" / "Keep the bare wheel" once.
- **Status-bar chip** (`🎡`): opens and closes the pane's tab, dimmed when closed,
  `aria-pressed`, and tracking real state through the disposer `openWorkspace`
  returns.

### Changed
- The pane docks as a **sibling tab of the terminal pane**, so collapsing that
  zone takes the wheel with it and the rail gives it an entry. Older desktops
  without `host.openWorkspace` still get a plain right-docked pane.
- The palette command **opens the pane then spins**, instead of reporting that
  the pane is closed.
- Result type is solved from the space available (`sqrt(H·W / (0.58·1.16·chars))`)
  and then verified against the render, so a long verse shrinks to fit rather
  than clipping.
- The result slot is reserved whether or not there is a result, so the button
  does not ride up and down between spins.

### Fixed
- Wheel labels are drawn upright on both halves; they were rotated by the
  sector's mid-angle and read upside down past vertical.
- `drawReel` resizes its canvas bitmap on every paint — without it the browser
  stretched the last frame when the pane was resized.

### Tests
- `tests/display.test.mjs` — 18 `node:test` cases over the display arithmetic:
  whether labels fit, where the tape must stop, the wrapping rules, and the
  result type sizing.
