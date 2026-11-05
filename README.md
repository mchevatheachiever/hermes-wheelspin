# WheelSpin

A real spinning wheel for Hermes. Any list becomes a weighted wheel in the
Desktop app; press **Try your luck** and it spins under friction physics, clicks
peg-by-peg to a stop, and announces the winner in the conversation.

A few options on every wheel are hidden **jackpots**. Land on one and the wheel
gives way to a three-reel slot machine, locks 7-7-7, and fires **JACKPOT!!!**
with a fanfare.

```
  wheel: dinner
                            ▼
  ┌────────────────────────────────────────────────┐
  │▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░██████████░░░░░░░░░▓▓▓▓▓▓▓▓▓│
  └────────────────────────────────────────────────┘
                            ★
  ★ 3 Sushi  ██··········   20.0%
    1 Pizza  ██··········   20.0%
    2 Thai   ██··········   20.0%
    4 Ramen  ██··········   20.0%
    5 Tacos  ██··········   20.0%

  ╔══════════════════════════════════╗
  ║      ✦ ✦ ✦  JACKPOT!!!  ✦ ✦ ✦    ║
  ╚══════════════════════════════════╝
```

## Install

```bash
hermes plugins install wheelspin
```

Then enable it in **Settings ▸ Plugins** (the Desktop half is opt-in) and open
the **wheel** pane. The agent tools work without the pane, so CLI, TUI, Discord
and cron all get the text wheel.

## Use

Ask Hermes in plain language:

> make a wheel of dinner options: pizza, thai, sushi, ramen, tacos

> put my Steam backlog on a wheel and spin it

> spin the wheel for me — I don't care, just pick

The agent calls `wheelspin_load` (or `wheelspin_spin` for an instant draw), and
the wheel appears in the pane. Press **Try your luck**.

## How it works

- **Weighted, not rigged.** Each option holds integer tickets; the draw is
  `secrets.randbelow(total)`. Weights are exact — no float rounding, no bias.
- **Physics, not an easing curve.** The wheel integrates `dω/dt = -K·ω - μ`
  (viscous drag plus constant bearing friction) every frame, so it rips at the
  start and hangs in the long tail. The initial angular velocity is solved by
  bisection so the wheel stops exactly on the sector the backend drew.
- **One draw, two surfaces.** The pane and the agent tool share one store
  (`plugin-data/wheelspin/wheels.json`, atomic writes under an advisory lock), so
  a click and a tool call are the same draw.
- **Big wheels feed like a magazine.** Past 8 options the wheel turns into belts:
  it draws a belt-load, then the rounds inside that belt. Picking a belt by its
  total weight and then an item inside it by weight is an identity
  (`w_item/W_belt × W_belt/W_all = w_item/W_all`), so a 2,000-title Steam library
  draws exactly as one flat weighted draw would — the belt is presentation, not
  a change in odds. Each stage is a real spin, and the readout under the wheel
  names the sector passing the pointer.
- **Jackpots are cosmetic.** 1–3 options per wheel are flagged at random
  (about one per five, capped at three). They never change the odds; a jackpot is
  only revealed if the winner happens to be one. The store does not expose which
  options they are, so the reveal cannot be peeked at.

## Tools

| Tool | Purpose |
|---|---|
| `wheelspin_load` | Load a list onto the wheel (`replace` or `append`) |
| `wheelspin_spin` | Draw immediately, no UI — CLI, gateway, cron |
| `wheelspin_list` | Loaded wheels, item counts, recent results |
| `wheelspin_delete` | Remove a wheel |

## Surfaces

- **Desktop**: canvas wheel pane, peg ticker, WebAudio ticks, slot-machine
  jackpot reveal, result posted back into the chat.
- **CLI / TUI / gateway / Discord**: block-character wheel with a pointer and a
  probability legend, plus the `JACKPOT!!!` banner.

## Disclosure

- **No network calls.** The plugin never contacts a remote service.
- **Local state only.** Wheels and spin history live in
  `<hermes home>/plugin-data/wheelspin/wheels.json` (last 200 spins).
- **No credentials**, no environment variables, no telemetry.
- **Audio** is synthesised locally with WebAudio (peg ticks, press clack, jackpot
  fanfare) and can be muted with the ♪ button.
- **Chat hand-off**: when a spin lands, the pane submits `The wheel says: <label>`
  to the active composer so Hermes can react. Toggle it off with the 💬 button.

## Development

```bash
python3 -m unittest tests.test_core          # core, art, store (stdlib only)
hermes plugins validate . --install-deps     # catalog admission gate
```

The API tests need FastAPI (the Hermes runtime venv has it):

```bash
"$HERMES_VENV/bin/python" -m unittest tests.test_api
```

## License

MIT
