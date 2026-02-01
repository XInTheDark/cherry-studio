import { createTwoFilesPatch } from 'diff'

export function buildUnifiedDiffPatch(args: {
  beforeLabel: string
  afterLabel: string
  before: string
  after: string
}): string {
  return createTwoFilesPatch(args.beforeLabel, args.afterLabel, args.before, args.after, '', '', { context: 3 })
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let idx = 0
  while (true) {
    const found = haystack.indexOf(needle, idx)
    if (found === -1) break
    count += 1
    idx = found + needle.length
  }
  return count
}

export function replaceAllLiteral(haystack: string, needle: string, replacement: string): string {
  return haystack.split(needle).join(replacement)
}

export function applyLiteralReplace(args: {
  before: string
  pattern: string
  replacement: string
  replaceAll?: boolean
}): { after: string; matches: number } {
  const { before, pattern, replacement, replaceAll } = args
  if (!pattern) {
    throw new Error('pattern must be non-empty')
  }
  const matches = countOccurrences(before, pattern)
  if (matches === 0) {
    throw new Error('pattern not found in canvas')
  }
  if (!replaceAll && matches > 1) {
    throw new Error(`pattern matched ${matches} times; provide a more specific snippet or set replaceAll=true`)
  }
  const after = replaceAll ? replaceAllLiteral(before, pattern, replacement) : before.replace(pattern, replacement)
  return { after, matches }
}

export function sanitizeFileNameBase(title: string): string {
  // Keep it portable: remove separators / reserved filename characters.
  const cleaned = title
    .trim()
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'Untitled'
}
