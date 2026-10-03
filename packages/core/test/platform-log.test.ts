import { expect, test } from 'vitest'
import { excerptAround, makePlatformLog } from '../src/platform-log.js'

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = start
  return { now: () => at, advance: (ms) => (at += ms) }
}

test('a platform log keeps each line with the moment it was written, in order (#78)', () => {
  const time = clock()
  const log = makePlatformLog({ now: time.now })

  log.record('page 1 opened', 'http://localhost/')
  time.advance(250)
  log.record('page 1 console.error', 'boom')
  time.advance(10)
  log.record('page 1 crashed')

  expect(log.lines()).toEqual(['[page 1 opened] http://localhost/', '[page 1 console.error] boom', '[page 1 crashed]'])
  expect(log.entries()).toEqual([
    { at: 1_000_000, line: '[page 1 opened] http://localhost/' },
    { at: 1_000_250, line: '[page 1 console.error] boom' },
    { at: 1_000_260, line: '[page 1 crashed]' },
  ])
})

test('the log is bounded: it keeps the last lines and says how many it dropped, and a line is cut and says so (#78)', () => {
  const log = makePlatformLog({ maxLines: 3, maxLineCharacters: 10, now: () => 5 })

  for (let index = 1; index <= 5; index += 1) log.record('out', `line ${index}`)
  log.record('out', 'x'.repeat(25))

  expect(log.lines()).toEqual([
    '[console] 3 earlier lines dropped: the log keeps the last 3',
    '[out] line 4',
    '[out] line 5',
    `[out] ${'x'.repeat(10)} [line cut at 10 characters]`,
  ])
  // The note is the log's own, not something the platform wrote at a moment.
  expect(log.entries().map((entry) => entry.line)).toEqual(['[out] line 4', '[out] line 5', `[out] ${'x'.repeat(10)} [line cut at 10 characters]`])
})

test('the excerpt is the window around the failure: what led up to it, where it happened, and what followed (#78)', () => {
  const entries = [
    { at: 1_000, line: '[main stdout] long before' },
    { at: 50_000, line: '[window 1 console.log] loading' },
    { at: 59_500, line: '[window 1 console.error] the save failed' },
    { at: 60_000, line: '[window 1 console.log] at the moment' },
    { at: 60_750, line: '[main exited] code 0' },
  ]

  expect(excerptAround(entries, 60_000)).toEqual([
    'the platform log from 30 s before the check stopped to its end; 1 earlier line is in console.log',
    '[-10.000s] [window 1 console.log] loading',
    '[-0.500s] [window 1 console.error] the save failed',
    '[-0.000s] [window 1 console.log] at the moment',
    '--- the check stopped here ---',
    '[+0.750s] [main exited] code 0',
  ])
})

test('the excerpt is bounded on both sides, keeps the lines nearest the failure, and says what it left out (#78)', () => {
  const entries = [
    ...Array.from({ length: 5 }, (_unused, index) => ({ at: 100 + index, line: `[out] before ${index}` })),
    ...Array.from({ length: 4 }, (_unused, index) => ({ at: 201 + index, line: `[out] after ${index}` })),
  ]

  expect(excerptAround(entries, 200, { maxBefore: 2, maxAfter: 1 })).toEqual([
    'the platform log from 30 s before the check stopped to its end; 3 earlier lines are in console.log',
    '[-0.097s] [out] before 3',
    '[-0.096s] [out] before 4',
    '--- the check stopped here ---',
    '[+0.001s] [out] after 0',
    '3 later lines are in console.log',
  ])
})

test('a platform that wrote nothing in the window says so, rather than leaving an empty file to be read as silence (#78)', () => {
  expect(excerptAround([], 60_000)).toEqual(['the platform log from 30 s before the check stopped to its end', '--- the check stopped here ---', 'the platform wrote nothing in this window'])
})
