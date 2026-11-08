/**
 * WheelSpin — desktop half.
 *
 * Draws a real weighted wheel on a canvas and spins it under friction physics:
 * viscous drag plus constant bearing friction, so it rips at the start, hangs in
 * the long tail, and clicks peg-by-peg to a stop. The winner is drawn by the
 * backend (so the pane and the agent tool make the same draw); the physics is
 * solved for an initial angular velocity that lands that sector under the
 * pointer.
 *
 * Plain ESM, loaded uncompiled: UI is jsx() calls, no JSX syntax.
 * Only @hermes/plugin-sdk, react and react/jsx-runtime resolve.
 */

import { Button, cn, haptic, host, PALETTE_AREA, useQuery } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

const ID = 'wheelspin'
const TAU = Math.PI * 2
const SLOT_SYMBOLS = ['7', '★', '◆', 'BAR', '♪', '$']

// The palette row needs to reach the mounted pane's spin handler. Module scope
// is the plugin's own; nothing outside the plugin reads it.
let spinRequest = null

// The pane's open state lives outside React: `openWorkspace` is a plain call
// that hands back a disposer, and the status chip has to render "open" or
// "closed" from it. Same shape as the ticklist pane, deliberately.
const pane = { dispose: null, listeners: new Set() }

function setPaneOpen(dispose) {
  pane.dispose = dispose
  for (const listener of pane.listeners) listener(Boolean(dispose))
}

function useIsPaneOpen() {
  const [open, setOpen] = useState(Boolean(pane.dispose))
  useEffect(() => {
    const listener = (value) => setOpen(value)
    pane.listeners.add(listener)
    setOpen(Boolean(pane.dispose))
    return () => pane.listeners.delete(listener)
  }, [])
  return open
}

// Friction model: dω/dt = -K·ω - MU   (viscous + Coulomb)
const K = 0.35 // 1/s, viscous drag — greased: the old 5.2 stopped it dead
const MU = 0.55 // rad/s², bearing friction (constant)
const MIN_TURNS = 2
const MAX_TURNS = 3.4
const MAX_SIM_SECONDS = 14

/* -------------------------------------------------------------------------- */
/* theme-aware colour plumbing (canvas cannot resolve var() itself)           */
/* -------------------------------------------------------------------------- */

function readVar(el, name, fallback) {
  if (!el) return fallback
  const value = getComputedStyle(el).getPropertyValue(name)
  return (value || '').trim() || fallback
}

function makeBlip() {
  let audio = null
  const context = () => {
    if (!audio) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return null
      audio = new Ctx()
    }
    if (audio.state === 'suspended') audio.resume().catch(() => {})
    return audio
  }

  const noise = (ctx, seconds, gainPeak, filterHz) => {
    const frames = Math.floor(ctx.sampleRate * seconds)
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < frames; i += 1) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 2.2)
    }
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = filterHz
    filter.Q.value = 1.1
    const gain = ctx.createGain()
    gain.gain.value = gainPeak
    source.connect(filter)
    filter.connect(gain)
    gain.connect(ctx.destination)
    source.start()
  }

  /** Peg tick while the wheel passes a boundary. */
  const tick = (gainScale) => {
    try {
      const ctx = context()
      if (!ctx) return
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = 300 + Math.random() * 140
      const now = ctx.currentTime
      const peak = 0.022 + 0.028 * Math.max(0, Math.min(1, gainScale))
      gain.gain.setValueAtTime(peak, now)
      gain.gain.exponentialRampToValueAtTime(0.0006, now + 0.03)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now)
      osc.stop(now + 0.035)
    } catch {
      /* audio is garnish — never break the spin */
    }
  }

  /** The "try your luck" clack: a noise slap plus a low thump. */
  const press = () => {
    try {
      const ctx = context()
      if (!ctx) return
      noise(ctx, 0.13, 0.16, 1800)
      const now = ctx.currentTime
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(190, now)
      osc.frequency.exponentialRampToValueAtTime(72, now + 0.16)
      gain.gain.setValueAtTime(0.18, now)
      gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.2)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now)
      osc.stop(now + 0.21)
    } catch {
      /* audio is garnish — never break the spin */
    }
  }

  /** Casino fanfare: rising arpeggio plus a coin shower. */
  const jackpot = () => {
    try {
      const ctx = context()
      if (!ctx) return
      const now = ctx.currentTime
      const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51]
      notes.forEach((freq, index) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        const at = now + index * 0.085
        osc.type = 'triangle'
        osc.frequency.setValueAtTime(freq, at)
        gain.gain.setValueAtTime(0.0001, at)
        gain.gain.exponentialRampToValueAtTime(0.15, at + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0006, at + 0.32)
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.start(at)
        osc.stop(at + 0.34)
      })
      noise(ctx, 0.55, 0.11, 5200)
      noise(ctx, 0.8, 0.07, 2400)
    } catch {
      /* audio is garnish — never break the spin */
    }
  }

  return { tick, press, jackpot }
}

/* -------------------------------------------------------------------------- */
/* friction physics                                                          */
/* -------------------------------------------------------------------------- */

/** Angular distance travelled before coming to rest, from ω0 under (K, MU). */
function stoppingDistance(omega0, dt = 0.004) {
  let omega = omega0
  let travelled = 0
  let t = 0
  while (omega > 0 && t < MAX_SIM_SECONDS) {
    travelled += omega * dt
    omega -= (K * omega + MU) * dt
    t += dt
  }
  return travelled
}

/** Initial ω that lands the wheel exactly `distance` radians from here. */
function solveOmega0(distance) {
  // stoppingDistance is monotonic in ω0, so bisect.
  let low = 0.5
  let high = 400
  for (let i = 0; i < 48; i += 1) {
    const mid = (low + high) / 2
    if (stoppingDistance(mid) < distance) low = mid
    else high = mid
  }
  return (low + high) / 2
}

function sectorGeometry(items, index) {
  const total = items.reduce((sum, item) => sum + item.weight, 0) || 1
  let start = 0
  for (let i = 0; i < index; i += 1) start += (items[i].weight / total) * TAU
  return { start, sweep: (items[index].weight / total) * TAU }
}

/* -------------------------------------------------------------------------- */
/* canvas wheel                                                              */
/* -------------------------------------------------------------------------- */

// ── display mode: sectors vs reel ────────────────────────────────────────────
// A sector can only carry a label if its arc is wide enough for one. Past that
// the wheel is either bare (the user's choice) or it becomes a tape.
const REEL_MIN_CELLS = 6

/**
 * Where the tape must end so `index` sits under the needle, having travelled at
 * least `minCells` cells. The tape repeats, so the answer is always ahead.
 */
function reelTarget(current, index, count, cell, minCells = REEL_MIN_CELLS) {
  if (!(count > 0) || !(cell > 0)) return current
  const base = index * cell
  const away = minCells * cell
  let target = base
  while (target < current + away) target += count * cell
  return target
}

function easeOutQuint(t) {
  return 1 - Math.pow(1 - t, 5)
}

/**
 * Break text into lines that fit `maxWidth`, capping at `maxLines` with an
 * ellipsis. `measure` is injected (`ctx.measureText(...).width`) so the same
 * function can be tested without a canvas.
 */
function wrapLines(text, maxWidth, maxLines, measure) {
  const words = String(text).split(/\s+/).filter(Boolean)
  const all = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (!line || measure(next) <= maxWidth) {
      line = next
      continue
    }
    all.push(line)
    line = word
  }
  if (line) all.push(line)
  if (all.length <= maxLines) return all
  const kept = all.slice(0, Math.max(1, maxLines))
  let last = kept[kept.length - 1]
  while (last.length > 1 && measure(`${last}…`) > maxWidth) last = last.slice(0, -1)
  kept[kept.length - 1] = `${last}…`
  return kept
}

/** Cabinet and cell geometry, so the renderer and the target offset agree. */
function reelGeometry(width, height) {
  // The cabinet has a sensible maximum: pulled wide, a slot machine should not
  // become a hallway. Past this it stays centred with air either side.
  // Tighter cabinet: it was claiming nearly the whole pane and leaving the
  // cells padded out with empty space.
  const bodyW = Math.min(width - 16, Math.max(300, Math.min(width * 0.58, 440)))
  const bodyH = Math.min(height - 8, Math.max(220, height * 0.74))
  const pad = 16
  const winW = bodyW - pad * 2
  const winH = bodyH - pad * 2 - 12
  // Font tracks the width, so pulling the pane open enlarges the text rather
  // than just widening it; the cell then grows to hold the lines.
  const font = Math.max(12, Math.min(21, winW / 34))
  const lineHeight = font * 1.3
  // About two cells visible, however tall the pane is — the tape reads as a
  // machine, and each cell can carry a paragraph.
  const cell = Math.max(96, Math.min(200, winH / 2.4))
  const maxLines = Math.max(1, Math.min(5, Math.floor((cell - 18) / lineHeight)))
  return { bodyW, bodyH, pad, winW, winH, cell, font, lineHeight, maxLines }
}

/**
 * Draw a vertical reel in a slot-machine cabinet: a rounded body with a lit
 * bezel, an inset window, and the tape scrolling up past a fixed needle.
 * `offset` is that scroll in pixels.
 */
function drawReel(canvas, items, offset, winner, spinning) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  // Match the bitmap to the element every paint. Without this the browser
  // stretches the last frame when the pane is resized, which reads as the
  // whole cabinet smearing instead of re-laying out.
  const rect = canvas.getBoundingClientRect()
  if (rect.width < 8 || rect.height < 8) return
  const ratio = window.devicePixelRatio || 1
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)
  if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
    canvas.width = width * ratio
    canvas.height = height * ratio
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const shell = readVar(canvas, '--ui-bg-secondary', '#151a17')
  const panel = readVar(canvas, '--ui-bg-primary', '#0e1210')
  const line = readVar(canvas, '--ui-border', '#2b3a31')
  const accent = readVar(canvas, '--ui-accent', '#6fbf8b')
  const text = readVar(canvas, '--ui-text-secondary', '#c8d5cc')

  const cx = width / 2
  const cy = height / 2
  const count = items.length

  // ── the cabinet ───────────────────────────────────────────────────────────
  const { bodyW, bodyH, pad, winH } = reelGeometry(width, height)
  const bodyX = cx - bodyW / 2
  const bodyY = cy - bodyH / 2
  const radius = 14

  const rounded = (x, y, w, h, r) => {
    ctx.beginPath()
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, r)
    } else {
      ctx.moveTo(x + r, y)
      ctx.arcTo(x + w, y, x + w, y + h, r)
      ctx.arcTo(x + w, y + h, x, y + h, r)
      ctx.arcTo(x, y + h, x, y, r)
      ctx.arcTo(x, y, x + w, y, r)
      ctx.closePath()
    }
  }

  // body: a subtle vertical gradient, so it reads as a moulded case
  const body = ctx.createLinearGradient(0, bodyY, 0, bodyY + bodyH)
  body.addColorStop(0, shell)
  body.addColorStop(1, panel)
  rounded(bodyX, bodyY, bodyW, bodyH, radius)
  ctx.fillStyle = body
  ctx.fill()
  ctx.strokeStyle = line
  ctx.lineWidth = 1.5
  ctx.stroke()

  // lit bezel around the window
  const winX = bodyX + pad
  const winY = bodyY + pad + 6
  const winW = bodyW - pad * 2
  rounded(winX, winY, winW, winH, 10)
  ctx.strokeStyle = accent
  ctx.globalAlpha = spinning ? 0.85 : 0.35
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.globalAlpha = 1

  // ── the tape, clipped to the window ───────────────────────────────────────
  const { cell, font, lineHeight, maxLines } = reelGeometry(width, height)

  ctx.save()
  rounded(winX, winY, winW, winH, 10)
  ctx.clip()
  ctx.fillStyle = panel
  ctx.fillRect(winX, winY, winW, winH)

  const first = Math.floor((offset - cy) / cell) - 1
  for (let i = first; i <= first + Math.ceil(winH / cell) + 2; i += 1) {
    const idx = ((i % count) + count) % count
    const item = items[idx]
    const y = cy + (i * cell - offset)
    if (y < winY - cell || y > winY + winH + cell) continue
    const centred = Math.abs(i * cell - offset) < cell / 2
    const isWinner = centred && winner === idx && !spinning

    if (isWinner) {
      ctx.fillStyle = 'rgba(111, 191, 139, 0.16)'
      ctx.fillRect(winX, y - cell / 2, winW, cell)
    }

    ctx.strokeStyle = line
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(winX + 8, y + cell / 2)
    ctx.lineTo(winX + winW - 8, y + cell / 2)
    ctx.stroke()

    const label = String(item.label).toUpperCase()
    ctx.font = `${isWinner ? 600 : 400} ${font}px system-ui, sans-serif`
    ctx.fillStyle = isWinner ? accent : text
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const lines = wrapLines(label, winW - 36, maxLines, (piece) => ctx.measureText(piece).width)
    const block = lines.length * lineHeight

    // Cylinder illusion: a row far from the middle of the window is curving
    // away from us, so it reads narrower. Squash horizontally about the centre.
    const fromCentre = Math.min(1, Math.abs(y - cy) / (winH / 2))
    const squash = Math.max(0.62, Math.cos(fromCentre * (Math.PI / 2.6)))
    ctx.save()
    ctx.translate(cx, 0)
    ctx.scale(squash, 1)
    ctx.translate(-cx, 0)

    let lineY = y - block / 2 + lineHeight / 2
    for (const piece of lines) {
      ctx.fillText(piece, cx, lineY)
      lineY += lineHeight
    }
    ctx.restore()
  }

  // Shade the drum so it curves away at the top and bottom edges, with a soft
  // highlight across the band you read against.
  const drum = ctx.createLinearGradient(0, winY, 0, winY + winH)
  drum.addColorStop(0, 'rgba(0,0,0,0.62)')
  drum.addColorStop(0.18, 'rgba(0,0,0,0.10)')
  drum.addColorStop(0.45, 'rgba(255,255,255,0.05)')
  drum.addColorStop(0.55, 'rgba(255,255,255,0.05)')
  drum.addColorStop(0.82, 'rgba(0,0,0,0.10)')
  drum.addColorStop(1, 'rgba(0,0,0,0.62)')
  ctx.fillStyle = drum
  ctx.fillRect(winX, winY, winW, winH)

  // The needle: the line you are reading against.
  ctx.strokeStyle = accent
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(winX, cy - cell / 2)
  ctx.lineTo(winX + winW, cy - cell / 2)
  ctx.moveTo(winX, cy + cell / 2)
  ctx.lineTo(winX + winW, cy + cell / 2)
  ctx.stroke()
  ctx.restore()

  // Arrow markers sit on the frame, not inside the clip.
  ctx.fillStyle = accent
  ctx.beginPath()
  ctx.moveTo(winX - 3, cy - 7)
  ctx.lineTo(winX + 8, cy)
  ctx.lineTo(winX - 3, cy + 7)
  ctx.closePath()
  ctx.fill()
  ctx.beginPath()
  ctx.moveTo(winX + winW + 3, cy - 7)
  ctx.lineTo(winX + winW - 8, cy)
  ctx.lineTo(winX + winW + 3, cy + 7)
  ctx.closePath()
  ctx.fill()
}

function drawWheel(canvas, items, rotation, winner, spinning, flapper) {
  const ctx = canvas.getContext('2d')
  if (!ctx || !items.length) return

  const rect = canvas.getBoundingClientRect()
  if (rect.width < 8 || rect.height < 8) return

  const dpr = window.devicePixelRatio || 1
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr
    canvas.height = height * dpr
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const accent = readVar(canvas, '--ui-accent', '#b8a1ff')
  const stroke = readVar(canvas, '--ui-stroke-secondary', 'rgba(128,128,128,0.35)')
  const label = readVar(canvas, '--ui-text-secondary', accent)

  const cx = width / 2
  const cy = height / 2
  const radius = Math.min(cx, cy) - 18
  const total = items.reduce((sum, item) => sum + item.weight, 0) || 1

  // Everything the wheel body draws — sectors, labels, pegs — is clipped to the
  // rim circle. A stray fragment outside the rim is otherwise possible from a
  // label anchored on the sector that wraps the seam.
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, radius + 1, 0, TAU)
  ctx.clip()

  let angle = rotation - Math.PI / 2
  items.forEach((item, index) => {
    const sweep = (item.weight / total) * TAU
    const isWinner = winner === index && !spinning

    ctx.beginPath()
    ctx.moveTo(cx, cy)
    // A hair of overlap: adjacent arcs that meet exactly leave an anti-aliased
    // seam where the last sector closes on the first, which shows as a thin
    // bright line at the rim (most visible at the bottom, where the curve is
    // flattest).
    ctx.arc(cx, cy, radius, angle, angle + sweep + 0.002)
    ctx.closePath()
    ctx.globalAlpha = isWinner ? 0.95 : 0.13 + 0.09 * (index % 3)
    ctx.fillStyle = accent
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.strokeStyle = stroke
    ctx.lineWidth = isWinner ? 2 : 1
    ctx.stroke()

    // Label sizing comes from the room the sector actually has: arc length on
    // the rim sets the font, radial length sets how many characters fit. This
    // is what lets a 50-item wheel still be readable.
    // Label sizing comes from the room the sector actually has: arc length on
    // the rim sets the font, radial length sets how many characters fit.
    const arc = sweep * radius
    if (arc >= 13 || isWinner) {
      const mid = angle + sweep / 2
      // Keep the text upright. Rotating every label by its mid-angle reads
      // correctly on the right half and upside down on the left, so anything
      // past vertical is flipped and anchored from the other end.
      const flipped = Math.cos(mid) < 0
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(flipped ? mid + Math.PI : mid)
      ctx.textAlign = flipped ? 'left' : 'right'
      ctx.textBaseline = 'middle'
      const text = String(item.label).toUpperCase()
      // Size first: the collision limits below both depend on it.
      // Size follows the SLICE, not the wheel: a sector's arc is the room its
      // label actually has, so a 30-item wheel on a wide pane gets big type and
      // a 300-item one stays small. Capped by the wheel so a 6-item wheel does
      // not end up shouting.
      let size = Math.max(6, Math.min(20, radius * 0.062, arc * 0.3))

      // The inner limit is where the text would actually collide, in either
      // direction: the drawn hub, or the point at which this slice is only as
      // wide as the text is tall (below that glyphs cross the slice edges).
      const hubR = Math.max(6, radius * 0.075)
      const sliceR = size / Math.max(sweep, 1e-6)
      const innerR = Math.min(radius - 24, Math.max(hubR + 6, sliceR))
      const room = radius - 8 - innerR
      const x = flipped ? -(radius - 8) : radius - 8

      let shown = ''
      let guard = 0
      for (; guard < 22; guard += 1) {
        ctx.font = `${isWinner ? 600 : 400} ${size}px system-ui, sans-serif`
        const maxChars = Math.max(3, Math.floor(room / (size * 0.52)))
        shown = text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
        if (ctx.measureText(shown).width <= room) break
        if (size <= 6) break
        size -= 1
      }

      // Belt and braces: nothing may spill past the inner edge.
      ctx.beginPath()
      if (flipped) {
        ctx.rect(-(radius - 8), -size, radius - 8 - innerR, size * 2)
      } else {
        ctx.rect(innerR, -size, radius - 8 - innerR, size * 2)
      }
      ctx.clip()
      ctx.fillStyle = isWinner ? accent : label
      if (shown) ctx.fillText(shown, x, 0)
      ctx.restore()
    }
    angle += sweep
  })

  ctx.restore()

  // The rim, drawn once. Whatever the sector edges did underneath, this is the
  // line a person sees.
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, TAU)
  ctx.strokeStyle = stroke
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.9
  ctx.stroke()
  ctx.globalAlpha = 1

  // pegs on the rim — one per sector boundary, these are what the ticker hits
  items.forEach((item, index) => {
    const { start } = sectorGeometry(items, index)
    const pegAngle = rotation - Math.PI / 2 + start
    const px = cx + Math.cos(pegAngle) * (radius - 2)
    const py = cy + Math.sin(pegAngle) * (radius - 2)
    ctx.beginPath()
    ctx.arc(px, py, 2.2, 0, TAU)
    ctx.globalAlpha = 0.55
    ctx.fillStyle = stroke
    ctx.fill()
    ctx.globalAlpha = 1
  })

  // hub
  ctx.beginPath()
  ctx.arc(cx, cy, Math.max(6, radius * 0.075), 0, TAU)
  ctx.globalAlpha = 0.85
  ctx.fillStyle = accent
  ctx.fill()
  ctx.globalAlpha = 1

  // ticker arm pivoting at the top, deflected by the pegs
  const pivotX = cx
  const pivotY = 6
  ctx.save()
  ctx.translate(pivotX, pivotY)
  ctx.rotate(flapper)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(0, 16)
  ctx.lineWidth = 3
  ctx.lineCap = 'round'
  ctx.strokeStyle = accent
  ctx.stroke()
  ctx.restore()

  ctx.beginPath()
  ctx.arc(pivotX, pivotY, 2.6, 0, TAU)
  ctx.fillStyle = accent
  ctx.fill()
}

/* -------------------------------------------------------------------------- */
/* jackpot reveal — three reels, then the banner                             */
/* -------------------------------------------------------------------------- */

function JackpotOverlay({ slot }) {
  if (!slot) return null
  const accent = 'var(--ui-accent)'
  const revealed = slot.phase === 'reveal'

  const reel = (index) =>
    jsx(
      'div',
      {
        key: `reel-${index}`,
        style: {
          width: '46px',
          height: '60px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '6px',
          border: `1px solid ${accent}`,
          fontFamily: 'ui-monospace, SFMono-Regular, monospace',
          fontSize: index >= slot.locked ? '17px' : '24px',
          fontWeight: 700,
          color: accent,
          background: 'color-mix(in oklab, var(--ui-accent) 14%, transparent)',
          transition: 'transform 120ms ease-out, font-size 120ms ease-out',
          transform: index === slot.locked - 1 ? 'scale(1.12)' : 'scale(1)'
        },
        children: slot.locked > index ? '7' : slot.symbols[index]
      },
      `reel-${index}`
    )

  return jsx('div', {
    className: 'absolute inset-0 z-10 flex items-center justify-center',
    style: { pointerEvents: 'none' },
    children: jsxs('div', {
      className: 'flex flex-col items-center gap-2 rounded-xl px-4 py-3',
      style: {
        border: `1px solid ${accent}`,
        background: 'color-mix(in oklab, var(--ui-accent) 10%, transparent)',
        boxShadow: '0 0 28px color-mix(in oklab, var(--ui-accent) 45%, transparent)',
        transition: 'transform 200ms cubic-bezier(.2,1.6,.4,1)',
        transform: revealed ? 'scale(1.04)' : 'scale(0.96)'
      },
      children: [
        jsx('div', {
          className: 'flex gap-1.5',
          children: [reel(0), reel(1), reel(2)]
        }),
        revealed
          ? jsxs('div', {
              className: 'flex flex-col items-center',
              children: [
                jsx('div', {
                  style: {
                    color: accent,
                    fontSize: '15px',
                    fontWeight: 800,
                    letterSpacing: '0.14em'
                  },
                  children: 'JACKPOT!!!'
                }),
                jsx('div', {
                  className: 'max-w-[190px] truncate text-center text-[0.6875rem]',
                  style: { color: 'var(--ui-text-secondary)' },
                  children: slot.label
                })
              ]
            })
          : jsx('div', {
              className: 'text-[0.6875rem] tracking-widest',
              style: { color: 'var(--ui-text-quaternary)' },
              children: 'rolling…'
            })
      ]
    })
  })
}

/* -------------------------------------------------------------------------- */
/* the pane                                                                  */
/* -------------------------------------------------------------------------- */

function WheelPane({ ctx }) {
  const canvasRef = useRef(null)
  const reelOffsetRef = useRef(0)
  const [mode, setMode] = useState('auto') // auto | wheel | reel, per wheel
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [shellH, setShellH] = useState(0)
  const shellRef = useRef(null)
  const rafRef = useRef(0)
  const rotationRef = useRef(0)
  const flapperRef = useRef(0)
  const itemsRef = useRef([])
  const [tick, setTick] = useState(0)
  const [spinning, setSpinning] = useState(false)
  const [winner, setWinner] = useState(null)
  const [result, setResult] = useState('')
  const [sound, setSound] = useState(true)
  const [sendToChat, setSendToChat] = useState(true)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [slot, setSlot] = useState(null)
  const slotTimers = useRef([])
  const slotFlicker = useRef(null)

  const wheelsQuery = useQuery({
    queryKey: ['wheelspin', 'wheels'],
    queryFn: () => ctx.rest('/wheels'),
    refetchInterval: 3000,
    retry: 1
  })

  const state = wheelsQuery.data || { wheels: [], active: '', history: [] }
  const wheel =
    state.wheels.find((entry) => entry.id === selectedId) ||
    state.wheels.find((entry) => entry.id === state.active) ||
    state.wheels[0] ||
    null
  const items = wheel ? wheel.items : []
  const itemsKey = wheel ? `${wheel.id}:${wheel.updated_at}` : 'none'

  // Reserved whether or not there is a result yet: an empty slot lets the
  // button ride up and down as answers arrive.
  const slotHeight = Math.round(Math.max(96, Math.min(168, (shellH || 620) * 0.26)))
  const radius = box.w > 0 && box.h > 0 ? Math.min(box.w, box.h) / 2 - 18 : 0
  // 'auto' always means the wheel: a dense wheel is still a wheel, the way the
  // streamers' tool does it — labels shrink and truncate rather than the display
  // changing shape under you. The reel is something you ask for.
  const reelView = items.length > 0 && mode === 'reel'
  const reelViewRef = useRef(reelView)
  reelViewRef.current = reelView

  const paint = useCallback(() => {
    if (!canvasRef.current) return
    if (reelViewRef.current) {
      drawReel(canvasRef.current, itemsRef.current, reelOffsetRef.current, winner, spinning)
      return
    }
    drawWheel(
      canvasRef.current,
      itemsRef.current,
      rotationRef.current,
      winner,
      spinning,
      flapperRef.current
    )
  }, [spinning, winner])

  useEffect(() => {
    itemsRef.current = items
    setWinner(null)
    setResult('')
    rotationRef.current = 0
    flapperRef.current = 0
    setTick((value) => value + 1)
  }, [itemsKey])

  useEffect(() => {
    paint()
  }, [tick, paint, itemsKey])

  useEffect(() => {
    const element = shellRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => {
      const element = canvasRef.current
      if (element) {
        const ratio = window.devicePixelRatio || 1
        setBox({ w: element.width / ratio, h: element.height / ratio })
      }
      if (shellRef.current) setShellH(shellRef.current.clientHeight)
      paint()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [paint])

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current)
      slotTimers.current.forEach((id) => clearTimeout(id))
      if (slotFlicker.current) clearInterval(slotFlicker.current)
    },
    []
  )

  const announce = useCallback(
    (text) => {
      if (!sendToChat) return
      try {
        const sent =
          host.composer && host.composer.submit
            ? host.composer.submit(null, `The wheel says: ${text}`)
            : false
        if (sent === false) host.notify({ kind: 'info', message: `Wheel result: ${text}` })
      } catch {
        host.notify({ kind: 'info', message: `Wheel result: ${text}` })
      }
    },
    [sendToChat]
  )

  const fireJackpot = useCallback((label, soundKit) => {
    slotTimers.current.forEach((id) => clearTimeout(id))
    slotTimers.current = []
    if (slotFlicker.current) clearInterval(slotFlicker.current)

    const randomSymbol = () => SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)]
    setSlot({
      phase: 'rolling',
      locked: 0,
      label,
      symbols: [randomSymbol(), randomSymbol(), randomSymbol()]
    })

    slotFlicker.current = setInterval(() => {
      setSlot((prev) => {
        if (!prev || prev.phase !== 'rolling') return prev
        return {
          ...prev,
          symbols: prev.symbols.map((symbol, index) => (index < prev.locked ? '7' : randomSymbol()))
        }
      })
    }, 70)

    const lock = (count, delay) => {
      slotTimers.current.push(
        setTimeout(() => {
          setSlot((prev) => (prev ? { ...prev, locked: count } : prev))
          if (count === 3) {
            if (slotFlicker.current) {
              clearInterval(slotFlicker.current)
              slotFlicker.current = null
            }
            setSlot((prev) =>
              prev ? { ...prev, phase: 'reveal', symbols: ['7', '7', '7'] } : prev
            )
            if (soundKit) soundKit.jackpot()
            haptic('tap')
          }
        }, delay)
      )
    }
    lock(1, 620)
    lock(2, 900)
    lock(3, 1180)
    slotTimers.current.push(setTimeout(() => setSlot(null), 4200))
  }, [])

  const spin = useCallback(async () => {
    if (spinning || !wheel) return
    haptic('tap')
    setError('')
    setSpinning(true)
    setWinner(null)
    setResult('')

    // The press itself must make a noise, before the draw and the animation.
    const soundKit = sound ? makeBlip() : null
    if (soundKit) soundKit.press()

    let outcome
    try {
      outcome = await ctx.rest(`/wheels/${encodeURIComponent(wheel.id)}/spin`, {
        method: 'POST',
        body: { count: 1 }
      })
    } catch (err) {
      setSpinning(false)
      setError(`spin failed: ${err && err.message ? err.message : err}`)
      return
    }

    const target = outcome.winners[0]
    const list = itemsRef.current
    if (!list.length) {
      setSpinning(false)
      return
    }

    if (reelViewRef.current) {
      // Same draw, different picture: the tape scrolls until the winning cell
      // sits under the needle. `reelTarget` guarantees it travels at least a
      // few cells, so a short list still reads as a spin.
      const element = canvasRef.current
      const ratio = window.devicePixelRatio || 1
      const width = element ? element.width / ratio : 600
      const height = element ? element.height / ratio : 400
      const { cell, font, lineHeight, maxLines } = reelGeometry(width, height)
      const from = reelOffsetRef.current
      const to = reelTarget(from, target.index, list.length, cell)
      const duration = 2100 + Math.random() * 900
      const started = performance.now()
      const blip = soundKit
      let passed = Math.floor(from / cell)

      const reelStep = (now) => {
        const t = Math.min(1, (now - started) / duration)
        reelOffsetRef.current = from + (to - from) * easeOutQuint(t)
        const cellNow = Math.floor(reelOffsetRef.current / cell)
        if (cellNow !== passed) {
          passed = cellNow
          if (blip) blip.tick(Math.max(0, 1 - t))
        }
        paint()
        if (t < 1) {
          rafRef.current = requestAnimationFrame(reelStep)
          return
        }
        reelOffsetRef.current = to
        setSpinning(false)
        setWinner(target.index)
        setResult(target.label)
        setTick((value) => value + 1)
        haptic('tap')
        if (outcome.jackpot) {
          fireJackpot(target.label, soundKit)
          announce(`JACKPOT!!! ${target.label}`)
        } else {
          announce(target.label)
        }
      }

      rafRef.current = requestAnimationFrame(reelStep)
      return
    }

    // Solve for the exact stop angle, then for the ω0 that friction will carry there.
    const { start, sweep } = sectorGeometry(list, target.index)
    // A hair off centre at most. The old ±30% of a sector meant a 6-item wheel
    // stopped with the winner visibly beside the pointer, not under it.
    const jitter = (Math.random() - 0.5) * sweep * 0.16
    const from = rotationRef.current
    const aligned = -start - sweep / 2 + jitter
    const turns = MIN_TURNS + Math.random() * (MAX_TURNS - MIN_TURNS)
    let to = aligned
    while (to < from + TAU * turns) to += TAU
    const distance = to - from

    let omega = solveOmega0(distance)
    const omegaPeak = omega
    const blip = soundKit

    let last = performance.now()
    let travelled = 0
    let pegIndex = Math.floor(((from + TAU * 0.25) / TAU) * list.length)
    let flapper = 0

    const step = (now) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000))
      last = now

      // Integrate the friction model rather than sampling a curve.
      const decel = K * omega + MU
      const wanted = Math.max(0, omega * dt - 0.5 * decel * dt * dt)
      // Clamp to what is left. Overshooting the target was what made the last
      // frames run backwards — the "jerky" finish.
      const delta = Math.min(wanted, Math.max(0, distance - travelled))
      travelled += delta
      omega = delta < wanted ? 0 : Math.max(0, omega - decel * dt)
      rotationRef.current = from + travelled

      // Ticker: kicked by each peg, sprung back to rest.
      const targetFlap = -Math.min(0.42, omega / Math.max(1, omegaPeak) * 0.5)
      flapper += (targetFlap - flapper) * Math.min(1, dt * (spinning ? 26 : 14))
      flapperRef.current = flapper

      const index = Math.floor((rotationRef.current / TAU) * list.length)
      if (index !== pegIndex && omega > 0) {
        pegIndex = index
        if (blip) blip.tick(omega / Math.max(1, omegaPeak))
      }

      paint()

      if (omega > 0.001 && travelled < distance) {
        rafRef.current = requestAnimationFrame(step)
        return
      }

      rotationRef.current = from + distance
      flapperRef.current = 0
      setSpinning(false)
      setWinner(target.index)
      setResult(target.label)
      setTick((value) => value + 1)
      haptic('tap')

      if (outcome.jackpot) {
        fireJackpot(target.label, soundKit)
        announce(`JACKPOT!!! ${target.label}`)
      } else {
        announce(target.label)
      }
    }

    rafRef.current = requestAnimationFrame(step)
  }, [announce, ctx, fireJackpot, paint, sound, spinning, wheel, itemsKey])

  // The choice belongs to the wheel, not the pane: a 6-item wheel should stay a
  // wheel even after a 666-item one has been switched to the tape.
  const loadedFor = useRef('')
  const userChose = useRef(false)
  useEffect(() => {
    let alive = true
    if (!wheel) return undefined
    if (loadedFor.current === wheel.id) return undefined
    loadedFor.current = wheel.id
    ;(async () => {
      let saved = 'auto'
      try {
        saved = (await ctx.storage.get(`mode:${wheel.id}`)) || 'auto'
      } catch {
        /* no storage: stay on auto */
      }
      if (alive && !userChose.current) {
        setMode(saved === 'reel' || saved === 'wheel' ? saved : 'auto')
      }
    })()
    return () => {
      alive = false
    }
  }, [ctx, wheel && wheel.id])

  const chooseMode = useCallback(
    (next) => {
      userChose.current = true
      setMode(next)
      // The canvas repaints on `tick`, not on `mode` — without this the switch
      // flips state and leaves the old picture on screen.
      setTick((value) => value + 1)
      haptic('tap')
      if (!wheel) return
      try {
        Promise.resolve(ctx.storage.set(`mode:${wheel.id}`, next)).catch(() => {})
      } catch {
        /* non-fatal */
      }
    },
    [ctx, wheel]
  )

  useEffect(() => {
    spinRequest = spin
    return () => {
      if (spinRequest === spin) spinRequest = null
    }
  }, [spin])

  const loadDraft = useCallback(async () => {
    const lines = draft
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (lines.length < 2) {
      setError('paste at least two options, one per line')
      return
    }
    try {
      await ctx.rest('/wheels', { method: 'POST', body: { name: 'pasted', items: lines } })
      setDraft('')
      setEditing(false)
      haptic('tap')
      await wheelsQuery.refetch()
    } catch (err) {
      setError(`could not save: ${err && err.message ? err.message : err}`)
    }
  }, [ctx, draft, wheelsQuery])

  // Every wheel, active first. This used to slice(0, 6), so any wheel past the
  // sixth was unreachable from the pane — invisible, not just off-screen.
  const chips = (() => {
    const active = state.wheels.find((entry) => entry.id === state.active)
    const rest = state.wheels.filter((entry) => entry !== active)
    return active ? [active, ...rest] : state.wheels
  })()

  return jsxs('div', {
    ref: shellRef,
    className: 'flex h-full min-h-0 flex-col gap-1.5 overflow-hidden p-2 text-sm',
    children: [
      jsxs('div', {
        className: 'flex items-center justify-between gap-2',
        children: [
          jsx('span', { className: 'truncate font-medium', children: wheel ? wheel.name : 'wheel' }),
          jsxs('div', {
            className: 'flex items-center gap-1',
            children: [
              // Two buttons, each setting its mode outright. A single toggle
              // had to infer the next state from the current one, and a stale
              // read made it take two or three presses to land.
              jsx(Button, {
                size: 'xs',
                variant: 'ghost',
                onClick: () => chooseMode('wheel'),
                title: 'Show the spinning wheel',
                className: reelView ? undefined : 'bg-(--chrome-action-active) text-foreground',
                children: '🎡'
              }),
              jsx(Button, {
                size: 'xs',
                variant: 'ghost',
                onClick: () => chooseMode('reel'),
                title: 'Show the tape reel',
                className: reelView ? 'bg-(--chrome-action-active) text-foreground' : undefined,
                children: '🎰'
              }),
              jsx(Button, {
                size: 'xs',
                variant: 'ghost',
                onClick: () => setSound((value) => !value),
                title: sound ? 'Mute peg ticks' : 'Unmute peg ticks',
                children: sound ? '♪' : '×♪'
              }),
              jsx(Button, {
                size: 'xs',
                variant: 'ghost',
                onClick: () => setSendToChat((value) => !value),
                title: sendToChat ? 'Result goes to chat' : 'Result stays in the pane',
                children: sendToChat ? '💬' : '🔇'
              }),
              jsx(Button, {
                size: 'xs',
                variant: 'ghost',
                onClick: () => setEditing((value) => !value),
                title: 'Paste a list',
                children: '＋'
              })
            ]
          })
        ]
      }),

      chips.length > 1
        ? jsx('div', {
            className: 'flex max-h-[5.5rem] flex-wrap gap-1 overflow-y-auto',
            children: chips.map((entry) =>
              jsx(
                'button',
                {
                  key: entry.id,
                  type: 'button',
                  onClick: () => setSelectedId(entry.id),
                  className: cn(
                    'truncate rounded px-1.5 py-0.5 text-[0.6875rem] transition-colors',
                    entry.id === (wheel && wheel.id)
                      ? 'bg-(--chrome-action-active) text-foreground'
                      : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover)'
                  ),
                  children: `${entry.name} (${entry.items.length})`
                },
                entry.id
              )
            )
          })
        : null,

      jsx('div', {
        // No height cap: the shell already reserves the result slot and the
        // button, so the wheel can take everything left above them. A cap here
        // was leaving a slab of the pane empty on tall panes.
        className: 'relative min-h-0 flex-1 overflow-hidden',
        children: jsxs('div', {
          className: 'flex h-full min-h-0 items-center justify-center',
          children: [
            jsx('canvas', { ref: canvasRef, className: 'h-full w-full' }),
            jsx(JackpotOverlay, { slot }),
            !items.length
              ? jsx('div', {
                  className:
                    'pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 p-4 text-center',
                  children: [
                    jsx('div', {
                      className: 'text-(--ui-text-secondary)',
                      children: 'No wheel loaded'
                    }),
                    jsx('div', {
                      className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
                      children:
                        'Ask Hermes to “make a wheel of dinner options”, or press ＋ and paste a list.'
                    })
                  ]
                })
              : null
          ]
        })
      }),

      editing
        ? jsxs('div', {
            className: 'flex flex-col gap-1',
            children: [
              jsx('textarea', {
                value: draft,
                onChange: (event) => setDraft(event.target.value),
                placeholder: 'One option per line…',
                className:
                  'h-20 w-full resize-none rounded border border-(--ui-stroke-secondary) bg-transparent p-1.5 text-xs outline-none',
                style: { color: 'var(--ui-text-secondary)' }
              }),
              jsxs('div', {
                className: 'flex gap-1',
                children: [
                  jsx(Button, {
                    size: 'xs',
                    variant: 'primary',
                    onClick: loadDraft,
                    disabled: !draft.trim(),
                    children: 'Load'
                  }),
                  jsx(Button, {
                    size: 'xs',
                    variant: 'ghost',
                    onClick: () => {
                      setEditing(false)
                      setDraft('')
                    },
                    children: 'Cancel'
                  })
                ]
              })
            ]
          })
        : null,

      jsx('div', {
        className: 'flex w-full shrink-0 items-center justify-center',
        style: { height: `${slotHeight}px` },
        children: result ? jsx(ResultBanner, { text: result, height: slotHeight }) : null
      }),

      jsx('div', {
        className: 'flex w-full shrink-0 items-center justify-center py-1',
        children: jsx('button', {
          type: 'button',
          onClick: spin,
          disabled: spinning || !items.length,
          'aria-label': 'Try your luck',
          style: {
            width: '100%',
            maxWidth: '340px',
            minHeight: '58px',
            borderRadius: '999px',
            border: '3px solid rgba(255,255,255,0.22)',
            background:
              'radial-gradient(circle at 50% 26%, #ff5a5a 0%, #e11616 42%, #9c0008 78%, #6d0005 100%)',
            boxShadow:
              'inset 0 6px 14px rgba(255,255,255,0.28), inset 0 -10px 18px rgba(0,0,0,0.45), 0 10px 22px rgba(0,0,0,0.55), 0 0 26px rgba(255,40,40,0.28)',
            color: '#fff',
            fontSize: '17px',
            fontWeight: 800,
            letterSpacing: '0.13em',
            textTransform: 'uppercase',
            textShadow: '0 2px 0 rgba(0,0,0,0.45), 0 0 14px rgba(255,220,220,0.55)',
            cursor: spinning || !items.length ? 'not-allowed' : 'pointer',
            opacity: spinning || !items.length ? 0.55 : 1,
            transform: spinning ? 'translateY(2px) scale(0.99)' : 'translateY(0) scale(1)',
            transition: 'transform 80ms ease-out, filter 120ms ease-out, box-shadow 120ms',
            userSelect: 'none',
            lineHeight: 1.1
          },
          children: spinning ? 'Good luck…' : 'Try Your Luck!'
        })
      }),

      error
        ? jsx('div', {
            className: 'truncate text-center text-[0.6875rem]',
            style: { color: 'var(--ui-text-secondary)' },
            children: error
          })
        : null,

      wheelsQuery.isError
        ? jsx('div', {
            className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
            children: 'backend offline — enable wheelspin in Settings ▸ Plugins'
          })
        : null
    ]
  })
}

function StatusChip({ onToggle }) {
  const isOpen = useIsPaneOpen()

  // An icon and nothing else: the whole side panel is collapsed by the
  // terminal's pill, which takes this pane with it, so this only has to say
  // which tab it is and whether it is up.
  return jsx('button', {
    type: 'button',
    onClick: () => {
      haptic('tap')
      if (onToggle() === false) {
        host.notify({
          kind: 'error',
          message: 'This desktop cannot open the pane — use the command palette'
        })
      }
    },
    title: isOpen ? 'WheelSpin — close the pane' : 'WheelSpin — open the pane',
    'aria-label': isOpen ? 'Close the WheelSpin pane' : 'Open the WheelSpin pane',
    'aria-pressed': isOpen,
    className:
      'inline-flex h-full items-center px-1.5 text-[0.75rem] transition-colors text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground',
    style: { opacity: isOpen ? 1 : 0.6 },
    children: '🎡'
  })
}

/**
 * Result type size, solved from the space rather than measured and retried.
 *
 * A line of bold uppercase system text averages ~0.58em per character, so with
 * L characters in a WxH box the type that fits is
 * sqrt(H·W / (0.58 · lineGap · L)). Solving it directly means the size tracks
 * the tab exactly — wider or taller pane, bigger answer — and cannot clip,
 * because there is no measurement step to disagree with the layout.
 */
function bannerFontSize(text, width, height) {
  const chars = Math.max(1, String(text).length)
  if (!(width > 0) || !(height > 0)) return 40
  const advance = 0.58
  const lineGap = 1.16
  const fit = Math.sqrt((height * 0.94 * width) / (advance * lineGap * chars))
  return Math.max(8, Math.min(52, Math.round(fit)))
}

/** The winning line above the button, sized to the space it is given. */
function ResultBanner({ text, height = 124 }) {
  const boxRef = useRef(null)
  const [dims, setDims] = useState({ w: 0, h: 0 })

  useLayoutEffect(() => {
    const element = boxRef.current
    if (!element) return undefined
    const read = () => setDims({ w: element.clientWidth, h: element.clientHeight })
    read()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(read)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // The formula is a good first guess, not a guarantee: it assumes an average
  // character advance, and bold uppercase with tight tracking runs wider. Start
  // there, then shrink until the box genuinely fits — never grow, so this can't
  // oscillate with the layout.
  const [size, setSize] = useState(0)
  const textRef = useRef(null)
  useLayoutEffect(() => {
    const box = boxRef.current
    const node = textRef.current
    if (!box || !node) return
    let next = bannerFontSize(text, dims.w, dims.h)
    node.style.fontSize = `${next}px`
    let guard = 0
    while (node.scrollHeight > box.clientHeight - 2 && next > 8 && guard < 140) {
      next -= 1
      node.style.fontSize = `${next}px`
      guard += 1
    }
    setSize(next)
  }, [text, dims.w, dims.h])

  return jsx('div', {
    ref: boxRef,
    style: {
      height: `${height}px`,
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      padding: '0 6px'
    },
    children: jsx('div', {
      ref: textRef,
      style: {
        color: 'var(--ui-accent)',
        fontSize: `${size || bannerFontSize(text, dims.w, dims.h)}px`,
        lineHeight: 1.16,
        fontWeight: 800,
        textAlign: 'center',
        letterSpacing: '-0.01em',
        overflowWrap: 'anywhere',
        textTransform: 'uppercase',
        textShadow: '0 0 20px color-mix(in oklab, var(--ui-accent) 55%, transparent)'
      },
      children: text
    })
  })
}

export default {
  id: ID,
  name: 'WheelSpin',
  register(ctx) {
    const remember = (closed) => {
      try {
        Promise.resolve(ctx.storage.set('paneClosed', closed)).catch(() => {})
      } catch {
        /* no storage: closing just won't stick */
      }
    }

    const open = () => {
      if (typeof host.openWorkspace !== 'function') return false
      try {
        const dispose = host.openWorkspace(ID, {
          title: 'wheel',
          // Land in the SAME zone as the terminal pane, as a sibling tab —
          // that is what gives it a rail entry when the zone is collapsed.
          dock: { pane: 'terminal', pos: 'center', enforce: true },
          // A floor on the tile's width, so the zone sash cannot squeeze the
          // canvas down to nothing.
          minWidth: '20rem',
          onClose: () => {
            setPaneOpen(null)
            remember(true)
          },
          render: () => jsx(WheelPane, { ctx })
        })
        // Wrap it so what is stored is always callable: a build whose
        // openWorkspace returns something else must not leave a boolean here,
        // or the chip can open the pane and never close it.
        setPaneOpen(
          typeof dispose === 'function'
            ? () => {
                try {
                  dispose()
                } catch {
                  /* already torn down */
                }
              }
            : () => setPaneOpen(null)
        )
        // Every open path — chip, palette, boot — clears the remembered close.
        // Only onClose sets it, and the app also calls a pane's closer when a
        // layout preset rests it, so a stale true heals on next visible.
        remember(false)
        return true
      } catch (err) {
        host.notify({
          kind: 'error',
          message: `wheel: could not open the pane — ${err && err.message ? err.message : err}`
        })
        return false
      }
    }

    const toggle = () => {
      if (typeof pane.dispose === 'function') {
        pane.dispose()
        setPaneOpen(null)
        remember(true)
        return true
      }
      return open()
    }

    // A pane the user closed must stay closed across a reload.
    const openIfWanted = async () => {
      let closed = false
      try {
        closed = (await ctx.storage.get('paneClosed')) === true
      } catch {
        /* no storage: behave as before */
      }
      if (!closed) open()
    }

    if (typeof host.openWorkspace !== 'function') {
      // Older desktop: fall back to a plain pane; the zone tab strip still has it.
      ctx.register({
        id: 'pane',
        area: 'panes',
        title: 'wheel',
        data: { placement: 'right', width: '620px' },
        render: () => jsx(WheelPane, { ctx })
      })
    } else {
      void openIfWanted()
    }

    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 129,
      render: () => jsx(StatusChip, { onToggle: toggle })
    })

    ctx.register({
      id: 'spin-command',
      area: PALETTE_AREA,
      data: {
        id: `${ID}.spin`,
        label: 'WheelSpin: try your luck',
        keywords: ['wheel', 'spin', 'random', 'pick', 'jackpot'],
        run: () => {
          // The handler lives on the mounted pane, so a closed pane used to
          // just report "open it first". Open it, then spin.
          if (typeof spinRequest === 'function') {
            spinRequest()
            return
          }
          if (!open()) return
          requestAnimationFrame(() => {
            if (typeof spinRequest === 'function') {
              spinRequest()
            } else {
              host.notify({ kind: 'info', message: 'Wheel pane is open — press Try your luck.' })
            }
          })
        }
      }
    })
  }
}
