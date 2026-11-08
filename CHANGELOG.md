# Changelog

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
