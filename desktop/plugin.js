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

import { Button, cn, haptic, host, useQuery } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useRef, useState } from 'react'

const ID = 'wheelspin'
const TAU = Math.PI * 2
const SLOT_SYMBOLS = ['7', '★', '◆', 'BAR', '♪', '$']

// The palette row needs to reach the mounted pane's spin handler. Module scope
// is the plugin's own; nothing outside the plugin reads it.
let spinRequest = null

// Friction model: dω/dt = -K·ω - MU   (viscous + Coulomb)
const K = 5.2 // 1/s, viscous drag (air + hub)
const MU = 0.62 // rad/s², bearing friction (constant)
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

  let angle = rotation - Math.PI / 2
  items.forEach((item, index) => {
    const sweep = (item.weight / total) * TAU
    const isWinner = winner === index && !spinning

    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.arc(cx, cy, radius, angle, angle + sweep)
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
    const arc = sweep * radius
    if (arc >= 13) {
      ctx.save()
      ctx.translate(cx, cy)
      ctx.rotate(angle + sweep / 2)
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      const size = Math.max(7, Math.min(14, radius * 0.075, arc * 0.62))
      ctx.font = `${isWinner ? 600 : 400} ${size}px system-ui, sans-serif`
      ctx.fillStyle = isWinner ? accent : label
      const text = String(item.label)
      const room = radius - 10
      const maxChars = Math.max(3, Math.floor(room / (size * 0.52)))
      const shown = text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
      if (ctx.measureText(shown).width <= room) ctx.fillText(shown, radius - 8, 0)
      ctx.restore()
    }
    angle += sweep
  })

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

  const paint = useCallback(() => {
    if (canvasRef.current) {
      drawWheel(
        canvasRef.current,
        itemsRef.current,
        rotationRef.current,
        winner,
        spinning,
        flapperRef.current
      )
    }
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
    const observer = new ResizeObserver(() => paint())
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

    // Solve for the exact stop angle, then for the ω0 that friction will carry there.
    const { start, sweep } = sectorGeometry(list, target.index)
    const jitter = (Math.random() - 0.5) * sweep * 0.6
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
    let settleFrames = 0

    const step = (now) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000))
      last = now

      // Integrate the friction model rather than sampling a curve.
      const decel = K * omega + MU
      const delta = Math.max(0, omega * dt - 0.5 * decel * dt * dt)
      travelled += delta
      omega = Math.max(0, omega - decel * dt)
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

      // Damped settle on the last few pixels, so it doesn't stop dead.
      settleFrames += 1
      const overshoot = distance - travelled
      if (settleFrames < 14 && Math.abs(overshoot) > 0.0005) {
        travelled += overshoot * 0.45
        rotationRef.current = from + travelled
        flapperRef.current = flapper * 0.55
        flapper *= 0.55
        paint()
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

  const chips = state.wheels.slice(0, 6)

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
            className: 'flex flex-wrap gap-1',
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
        className: 'relative min-h-0 flex-1 overflow-hidden',
        style: { maxHeight: '74%' },
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
        className: 'flex w-full shrink-0 items-center justify-center overflow-hidden px-1',
        style: { height: '124px' },
        children: result
          ? jsx('div', {
              style: {
                color: 'var(--ui-accent)',
                fontSize:
                  result.length > 26 ? '34px' : result.length > 17 ? '42px' : '52px',
                lineHeight: 1.05,
                fontWeight: 800,
                textAlign: 'center',
                letterSpacing: '-0.01em',
                overflowWrap: 'anywhere',
                maxHeight: '100%',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                textShadow: '0 0 20px color-mix(in oklab, var(--ui-accent) 55%, transparent)'
              },
              children: result
            })
          : null
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

export default {
  id: ID,
  name: 'WheelSpin',
  register(ctx) {
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'wheel',
      data: { placement: 'right', width: '620px' },
      render: () => jsx(WheelPane, { ctx })
    })

    ctx.register({
      id: 'spin-command',
      area: 'PALETTE_AREA',
      data: {
        id: `${ID}.spin`,
        label: 'WheelSpin: try your luck',
        keywords: ['wheel', 'spin', 'random', 'pick', 'jackpot'],
        run: () => {
          if (spinRequest) spinRequest()
          else host.notify({ kind: 'info', message: 'Open the wheel pane first.' })
        }
      }
    })
  }
}
