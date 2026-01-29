import { normalizePathValue } from '@renderer/services/NotesTreeService'

/**
 * Normalize a filesystem-like path to forward slashes and remove trailing slashes.
 * (We still keep Windows drive prefixes like "C:/".)
 */
export function normalizeFsPath(value: string): string {
  return normalizePathValue(value).replace(/\/+$/, '')
}

export function joinFsPath(...parts: string[]): string {
  const cleaned = parts
    .filter(Boolean)
    .map((p, idx) => {
      const normalized = normalizeFsPath(p)
      if (idx === 0) return normalized
      return normalized.replace(/^\/+/, '')
    })
    .filter(Boolean)
  return cleaned.join('/')
}

export function dirnameFsPath(value: string): string {
  const normalized = normalizeFsPath(value)
  const idx = normalized.lastIndexOf('/')
  if (idx === -1) return ''
  if (idx === 0) return '/'
  return normalized.slice(0, idx)
}

export function basenameFsPath(value: string): string {
  const normalized = normalizeFsPath(value)
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? normalized : normalized.slice(idx + 1)
}

export function splitFileExt(fileName: string): { name: string; ext: string } {
  const idx = fileName.lastIndexOf('.')
  // Treat ".gitignore" style as having no extension.
  if (idx <= 0) return { name: fileName, ext: '' }
  return { name: fileName.slice(0, idx), ext: fileName.slice(idx) }
}

export function toNotesRelativePath(notesPath: string, fileOrDirPath: string): string | null {
  const root = normalizeFsPath(notesPath)
  const full = normalizeFsPath(fileOrDirPath)
  if (!root) return null

  const prefix = root.endsWith('/') ? root : `${root}/`
  if (!full.startsWith(prefix)) return null
  return full.slice(prefix.length)
}

export function rewritePathPrefix(relPath: string, oldRelPrefix: string, newRelPrefix: string): string | null {
  const from = oldRelPrefix.replace(/\/+$/, '')
  const to = newRelPrefix.replace(/\/+$/, '')
  if (relPath === from) return to
  if (!relPath.startsWith(`${from}/`)) return null
  return `${to}${relPath.slice(from.length)}`
}
