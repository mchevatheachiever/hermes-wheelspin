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
const LABEL_MIN_ARC = 13
const REEL_MIN_CELLS = 6
const sandbox = new Function(
  'TAU',
  'LABEL_MIN_ARC',
  'REEL_MIN_CELLS',
  `${extract('labelsFit')}\n${extract('reelTarget')}\n${extract('easeOutQuint')}\n${extract('wrapLines')}\n${extract('bannerFontSize')}\nreturn { labelsFit, reelTarget, easeOutQuint, wrapLines, bannerFontSize }`
)(TAU, LABEL_MIN_ARC, REEL_MIN_CELLS)

const { labelsFit, reelTarget, easeOutQuint, wrapLines, bannerFontSize } = sandbox

const items = (n, weight = 1) => Array.from({ length: n }, (_, i) => ({ label: `item ${i}`, weight }))

test('a small wheel can be labelled', () => {
  assert.equal(labelsFit(items(6), 200), true)
  assert.equal(labelsFit(items(20), 200), true)
})

test('a dense wheel cannot', () => {
  assert.equal(labelsFit(items(100), 200), false)
  assert.equal(labelsFit(items(666), 300), false)
})

test('one starved sector is enough to fail the fit', () => {
  const mixed = [...items(5), { label: 'tiny', weight: 0.001 }]
  assert.equal(labelsFit(mixed, 220), false)
})

test('no radius or no items is not a fit', () => {
  assert.equal(labelsFit(items(4), 0), false)
  assert.equal(labelsFit([], 300), false)
})

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
