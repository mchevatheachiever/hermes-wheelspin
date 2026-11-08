# Changelog

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
