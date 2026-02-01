import { describe, expect, test } from 'vitest'

import { applyLiteralReplace, countOccurrences, sanitizeFileNameBase } from '../canvasToolUtils'

describe('CanvasTools helpers', () => {
  test('countOccurrences counts non-overlapping occurrences', () => {
    expect(countOccurrences('aaaa', 'aa')).toBe(2)
    expect(countOccurrences('ababab', 'ab')).toBe(3)
    expect(countOccurrences('abc', 'x')).toBe(0)
  })

  test('applyLiteralReplace requires exact one match by default', () => {
    const before = 'Hello\nHello\n'
    expect(() =>
      applyLiteralReplace({
        before,
        pattern: 'Hello',
        replacement: 'Hi',
        replaceAll: false
      })
    ).toThrow(/matched 2 times/i)
  })

  test('applyLiteralReplace supports replaceAll', () => {
    const before = 'Hello\nHello\n'
    const { after, matches } = applyLiteralReplace({
      before,
      pattern: 'Hello',
      replacement: 'Hi',
      replaceAll: true
    })
    expect(matches).toBe(2)
    expect(after).toBe('Hi\nHi\n')
  })

  test('sanitizeFileNameBase removes dangerous characters', () => {
    expect(sanitizeFileNameBase('  A/B:C*?  ')).toBe('A B C')
    expect(sanitizeFileNameBase('')).toBe('Untitled')
  })
})
