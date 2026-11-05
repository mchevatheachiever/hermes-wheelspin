---
name: wheelspin
description: "Spin a weighted wheel to decide between options, with a jackpot reveal."
version: 1.0.0
---

# WheelSpin

A real spinning wheel for decisions. The user sees an animated canvas wheel in
the Hermes Desktop **Wheel** pane; the CLI and gateway chats get a block-character
wheel in the transcript. A few options are hidden jackpots — landing on one fires
a slot-machine reveal and **JACKPOT!!!**.

## When to use it

- The user asks to pick between things at random: dinner, a game, a task, who
  goes first, which of N options to try.
- The user says "wheel", "spin", "roulette", "pick for me", "try my luck".
- You have a list in context (a Steam library, a shortlist, a menu) and the
  decision is genuinely arbitrary.

Do **not** use it to dodge a decision that has a right answer, and never present
a spin as a recommendation.

## Tools

| Tool | Use |
|---|---|
| `wheelspin_load` | Put a list on the wheel. `items` accepts strings or `{label, weight}`. `mode: append` adds to an existing wheel. |
| `wheelspin_spin` | Draw immediately, no UI. Use in CLI/Discord/cron, or when the user wants the answer now. |
| `wheelspin_list` | Show loaded wheels, item counts and recent results. |
| `wheelspin_delete` | Remove a wheel by name. |

## Procedure

1. Build the list from what the user actually said. Keep labels short — they are
   drawn on sectors.
2. `wheelspin_load` with a meaningful `name` (`dinner`, `next-game`).
3. Tell the user the wheel is loaded and to press **Try your luck** in the Wheel
   pane. Do not claim a result you have not drawn.
4. If they want the answer without the UI, call `wheelspin_spin` and report the
   `answer` field. Include the `display` block when the surface is text-only.

## Weights

`weight` is integer tickets, not a percentage: `{label: "pizza", weight: 3}`
against `{label: "thai", weight: 1}` is 75/25. Use weights only when the user
expresses a preference ("mostly pizza"). Default is 1 each.

## Jackpots

Each wheel carries 1–3 hidden jackpot options (about one per five items, capped
at three). They are cosmetic: the draw is still weight-based, and a jackpot is
only *revealed* if the winner happens to be one. Never tell the user which
options are jackpots — the store does not expose them, and guessing spoils the
reveal. If a spin returns `jackpot: true`, lead with `JACKPOT!!!`.

## Pitfalls

- Duplicate labels are merged (weights summed) — two identical sectors would be
  indistinguishable on screen.
- A wheel needs at least one item; empty lists are rejected.
- The Desktop pane needs the plugin enabled in Settings ▸ Plugins; the tools work
  without it.
