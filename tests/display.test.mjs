/**
 * The display-mode arithmetic, tested outside the app.
 *
 * `desktop/plugin.js` cannot import a sibling module — only `@hermes/plugin-sdk`,
 * `react` and `react/jsx-runtime` resolve inside the app — so the pure functions
 * live in that file and this test reads them back out and evaluates them, the
 * same trick `tests/reorder.test.mjs` uses over in hermes-ticklist.
 *
 * The two that matter are the ones that decide *what the user sees*: whether a
 * wheel can be labelled at all, and where the tape has to stop. Both have an
 * off-by-one failure mode that looks fine until the wheel lands on the wrong
 * cell.
 *
 *   node --test tests/display.test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'desktop', 'plugin.js'), 'utf8')

function extract(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} not found in desktop/plugin.js`)
  let depth = 0
  let i = source.indexOf('{', start)
  const from = i
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${from}`)
}

// The constants the functions close over are module-level in the plugin.
const TAU = Math.PI * 2
const REEL_MIN_CELLS = Number((source.match(/const REEL_MIN_CELLS = (\d+)/) || [])[1] || 6)
const sandbox = new Function(
  'TAU',
  'REEL_MIN_CELLS',
  `${extract('reelTarget')}\n${extract('easeOutQuint')}\n${extract('wrapLines')}\n${extract('bannerFontSize')}\n${extract('sectorStarts')}\n${extract('pegIndexAt')}\n${extract('tickerPivot')}\n${extract('reelGeometry')}\n${extract('canvasBox')}\nreturn {  reelTarget, easeOutQuint, wrapLines, bannerFontSize, sectorStarts, pegIndexAt, tickerPivot, reelGeometry, canvasBox }`
)(TAU, REEL_MIN_CELLS)

const {
  reelTarget,
  easeOutQuint,
  wrapLines,
  bannerFontSize,
  sectorStarts,
  pegIndexAt,
  tickerPivot,
  reelGeometry,
  canvasBox
} = sandbox

const items = (n, weight = 1) => Array.from({ length: n }, (_, i) => ({ label: `item ${i}`, weight }))

// unused helper kept out:
const _unused = (n) =>
  Array.from({ length: n }, (_, i) => ({
    label: `Blessed are they that mourn in the wilderness, for they shall be comforted, item ${i}`,
    weight: 1
  }))

test('reelTarget always moves forward by at least the minimum run', () => {
  const cell = 176
  const count = 12
  for (let index = 0; index < count; index += 1) {
    const from = 0
    const to = reelTarget(from, index, count, cell)
    assert.ok(to > from, 'tape must move forward')
    assert.ok(to - from >= REEL_MIN_CELLS * cell - 1e-9, `run too short: ${to - from}`)
  }
})

test('reelTarget lands the requested cell under the needle', () => {
  const cell = 176
  const count = 7
  for (let index = 0; index < count; index += 1) {
    const to = reelTarget(0, index, count, cell)
    const centred = ((to / cell) % count + count) % count
    assert.ok(Math.abs(centred - index) < 1e-9, `expected ${index}, got ${centred}`)
  }
})

test('reelTarget keeps moving on from wherever the tape already is', () => {
  const cell = 176
  const count = 5
  const first = reelTarget(0, 2, count, cell)
  const second = reelTarget(first, 2, count, cell)
  assert.ok(second > first)
  assert.equal(((second / cell) % count + count) % count, 2)
})

test('reelTarget is a no-op on nonsense input', () => {
  assert.equal(reelTarget(10, 0, 0, 176), 10)
  assert.equal(reelTarget(10, 0, 5, 0), 10)
})

// A crude monospace measure: 10px per character.
const measure = (text) => text.length * 10

test('short text is one line', () => {
  assert.deepEqual(wrapLines('RAMEN', 200, 3, measure), ['RAMEN'])
})

test('long text wraps at word boundaries', () => {
  const lines = wrapLines('WHY DID THE PHYSICIST BREAK UP WITH THE BIOLOGIST', 120, 4, measure)
  assert.ok(lines.length > 1)
  for (const line of lines) assert.ok(measure(line) <= 130, `line too wide: ${line}`)
})

test('wrapping never splits a word', () => {
  const lines = wrapLines('EXTRAORDINARY CIRCUMSTANCES PREVAIL', 90, 4, measure)
  for (const line of lines) {
    for (const word of line.replace('…', '').split(' ')) {
      assert.ok('EXTRAORDINARY CIRCUMSTANCES PREVAIL'.includes(word), `invented word: ${word}`)
    }
  }
})

test('text longer than the cap ends with an ellipsis that fits', () => {
  const text = 'ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE TEN ELEVEN TWELVE'
  const lines = wrapLines(text, 100, 2, measure)
  assert.equal(lines.length, 2)
  assert.ok(lines[1].endsWith('…'))
  assert.ok(measure(lines[1]) <= 100)
})

test('one unbreakable word still occupies one line', () => {
  assert.deepEqual(wrapLines('SUPERCALIFRAGILISTIC', 50, 3, measure), ['SUPERCALIFRAGILISTIC'])
})

test('a single line cap still produces a fitting ellipsis', () => {
  const lines = wrapLines('ALPHA BETA GAMMA DELTA', 60, 1, measure)
  assert.equal(lines.length, 1)
  assert.ok(measure(lines[0]) <= 60)
})

test('banner type grows with the tab, on both axes', () => {
  // long enough that neither box hits the 52px cap
  const text = 'X'.repeat(120)
  const base = bannerFontSize(text, 400, 124)
  assert.ok(bannerFontSize(text, 800, 124) > base, 'wider tab must give bigger type')
  assert.ok(bannerFontSize(text, 400, 200) > base, 'taller slot must give bigger type')
})

test('banner type shrinks as the text gets longer', () => {
  let previous = Infinity
  for (const length of [10, 40, 90, 160, 300]) {
    const size = bannerFontSize('X'.repeat(length), 500, 124)
    assert.ok(size <= previous, `size went up at length ${length}`)
    previous = size
  }
})

test('banner type stays inside its bounds', () => {
  assert.equal(bannerFontSize('X', 10000, 124), 52)
  assert.equal(bannerFontSize('X'.repeat(5000), 200, 124), 8)
  assert.equal(bannerFontSize('RAMEN', 0, 124), 40)
})

test('easeOutQuint starts at 0, ends at 1, never goes backwards', () => {
  assert.equal(easeOutQuint(0), 0)
  assert.equal(easeOutQuint(1), 1)
  let previous = -1
  for (let t = 0; t <= 1; t += 0.05) {
    const value = easeOutQuint(t)
    assert.ok(value >= previous, 'must be monotonic')
    assert.ok(value >= 0 && value <= 1, 'must stay in range')
    previous = value
  }
})

test('sectorStarts follows the weights, not the item count', () => {
  const weighted = [
    { label: 'heavy', weight: 3 },
    { label: 'light', weight: 1 }
  ]
  const starts = sectorStarts(weighted)
  assert.equal(starts.length, 2)
  assert.equal(starts[0], 0)
  assert.ok(Math.abs(starts[1] - TAU * 0.75) < 1e-12)
})

test('peg ticks land on the boundary that owns the angle', () => {
  const starts = sectorStarts([
    { label: 'a', weight: 1 },
    { label: 'b', weight: 1 },
    { label: 'c', weight: 2 }
  ])
  // Weighted boundaries at 0, 90 and 180 degrees; the last slice owns 180..360.
  const cases = [
    [0, 0],
    [89, 0],
    [90, 1],
    [179, 1],
    [180, 2],
    [359, 2],
    [360, 0],
    [-10, 2],
    [450, 1]
  ]
  for (const [deg, expected] of cases) {
    assert.equal(pegIndexAt(starts, (deg * Math.PI) / 180), expected, `at ${deg} deg`)
  }
})

test('the ticker hangs on the rim, not on the top of the canvas', () => {
  const cases = [
    { cx: 320, cy: 160, radius: 142 }, // wide, short pane
    { cx: 320, cy: 400, radius: 142 }, // tall pane — the old fixed y=6 floated 252px above
    { cx: 200, cy: 200, radius: 182 }
  ]
  for (const { cx, cy, radius } of cases) {
    const pivot = tickerPivot(cx, cy, radius)
    assert.equal(pivot.x, cx)
    assert.ok(Math.abs(pivot.y - (cy - radius - 2)) < 1e-9, 'pivot must sit on the rim')
    assert.ok(pivot.y > 0, 'pivot must stay inside the canvas')
  }
})

test('a heavy sector does not tick once per item', () => {
  // 9/10 of the wheel is one sector: a count-based tick would fire ten times a
  // turn; the weighted one fires at the one real boundary (324 degrees).
  const starts = sectorStarts([
    { label: 'heavy', weight: 9 },
    { label: 'light', weight: 1 }
  ])
  let ticks = 0
  let previous = pegIndexAt(starts, 0)
  for (let step = 0; step < 360; step += 1) {
    const index = pegIndexAt(starts, (step * Math.PI) / 180)
    if (index !== previous) ticks += 1
    previous = index
  }
  assert.equal(ticks, 1, 'one boundary in a full turn')
})



test('reelGeometry survives a zero-sized or negative canvas', () => {
  for (const [w, h] of [[0, 0], [-50, 300], [1, 1]]) {
    const g = reelGeometry(w, h)
    assert.ok(g.winW > 0 && g.winH > 0, `window collapsed at ${w}x${h}`)
    assert.ok(g.bodyW > 0 && g.bodyH > 0, `cabinet collapsed at ${w}x${h}`)
    assert.ok(g.cell >= 96, `cell collapsed at ${w}x${h}`)
  }
})

test('canvasBox rounds the CSS box, and copes with no canvas', () => {
  const canvas = { getBoundingClientRect: () => ({ width: 619.6, height: 400.2 }) }
  assert.deepEqual(canvasBox(canvas), { width: 620, height: 400 })
  assert.deepEqual(canvasBox(null), { width: 0, height: 0 })
})

test('a tape aimed for one cell size is off the needle at another', () => {
  // A pane resize mid-spin changes `cell`; the old offset no longer lands the
  // winner under the needle, and re-aiming has to put it back.
  const before = reelGeometry(620, 600).cell
  const after = reelGeometry(620, 900).cell
  assert.notEqual(before, after, 'the two pane heights must give different cells')
  const aimed = reelTarget(0, 3, 10, before)
  const offBy = Math.abs((((aimed / after) % 10) + 10) % 10 - 3)
  const resnapped = reelTarget(aimed, 3, 10, after)
  const aligned = Math.abs((((resnapped / after) % 10) + 10) % 10 - 3)
  assert.ok(offBy > 1e-9, 'the stale offset really was off the needle')
  assert.ok(aligned < 1e-9, 're-aiming puts the winner back under it')
})
