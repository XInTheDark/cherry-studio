import { describe, expect, it } from 'vitest'

import {
  basenameFsPath,
  dirnameFsPath,
  joinFsPath,
  rewritePathPrefix,
  splitFileExt,
  toNotesRelativePath
} from '../canvasHistory/pathUtils'

describe('CanvasHistoryService helpers', () => {
  it('should compute notes-relative paths', () => {
    expect(toNotesRelativePath('/root/notes', '/root/notes/a.md')).toBe('a.md')
    expect(toNotesRelativePath('/root/notes', '/root/notes/folder/a.md')).toBe('folder/a.md')
  })

  it('should return null when path is outside notes root', () => {
    expect(toNotesRelativePath('/root/notes', '/root/other/a.md')).toBeNull()
  })

  it('should rewrite rel path prefixes', () => {
    expect(rewritePathPrefix('a/b/c.md', 'a', 'x')).toBe('x/b/c.md')
    expect(rewritePathPrefix('a/b/c.md', 'a/b', 'x/y')).toBe('x/y/c.md')
    expect(rewritePathPrefix('a/b/c.md', 'z', 'x')).toBeNull()
  })

  it('should join fs paths without double slashes', () => {
    expect(joinFsPath('/root/notes/', '/.cherry-canvas/', 'history')).toBe('/root/notes/.cherry-canvas/history')
    expect(joinFsPath('C:/Users/Alice/Notes/', '.cherry-canvas', 'index.json')).toBe(
      'C:/Users/Alice/Notes/.cherry-canvas/index.json'
    )
  })

  it('should split filesystem paths into dirname/basename', () => {
    expect(dirnameFsPath('/root/notes/a.md')).toBe('/root/notes')
    expect(basenameFsPath('/root/notes/a.md')).toBe('a.md')
  })

  it('should split file extensions', () => {
    expect(splitFileExt('a.md')).toEqual({ name: 'a', ext: '.md' })
    expect(splitFileExt('a')).toEqual({ name: 'a', ext: '' })
    expect(splitFileExt('.gitignore')).toEqual({ name: '.gitignore', ext: '' })
  })
})
