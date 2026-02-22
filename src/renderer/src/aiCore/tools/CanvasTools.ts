import { loggerService } from '@logger'
import CanvasCommentService from '@renderer/services/CanvasCommentService'
import {
  basenameFsPath,
  joinFsPath,
  normalizeFsPath,
  toNotesRelativePath
} from '@renderer/services/canvasHistory/pathUtils'
import CanvasHistoryService from '@renderer/services/CanvasHistoryService'
import store from '@renderer/store'
import type { CanvasCommentType } from '@renderer/types'
import { type InferToolInput, type InferToolOutput, tool } from 'ai'
import * as z from 'zod'

import { applyLiteralReplace, buildUnifiedDiffPatch, sanitizeFileNameBase } from './canvasToolUtils'

const logger = loggerService.withContext('CanvasTools')

/**
 * Target selection rules (used by tools):
 * - Prefer an explicit target (canvasId / relPath / filePath)
 * - Otherwise fall back to provided defaultTarget (from plugin context)
 * - Finally fall back to the currently active canvas in the Notes page (if any)
 */
const CanvasTargetSchema = z
  .object({
    canvasId: z.string().optional().describe('Stable canvas id (preferred for disambiguation)'),
    relPath: z.string().optional().describe('Path relative to notes root (e.g. "Foo/Bar.md")'),
    filePath: z.string().optional().describe('Full file path (fallback; must be inside notesPath)')
  })
  .optional()

export type CanvasTarget = z.infer<typeof CanvasTargetSchema>

type CanvasResolvedTarget = {
  notesPath: string
  canvasId: string
  relPath: string
  filePath: string
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

async function resolveCanvasTarget(args: {
  notesPath: string
  target?: CanvasTarget
  defaultTarget?: { canvasId: string; filePath: string } | null
}): Promise<CanvasResolvedTarget> {
  const { notesPath, target, defaultTarget } = args

  const normalizedNotesPath = normalizeFsPath(notesPath)

  // 1) Explicit filePath.
  if (isNonEmptyString(target?.filePath)) {
    const rel = toNotesRelativePath(normalizedNotesPath, target.filePath)
    if (!rel) {
      throw new Error(`Target filePath is not inside notesPath: ${target.filePath}`)
    }
    const { canvasId } = await CanvasHistoryService.getCanvasId({
      notesPath: normalizedNotesPath,
      filePath: target.filePath
    })
    return { notesPath: normalizedNotesPath, canvasId, relPath: rel, filePath: normalizeFsPath(target.filePath) }
  }

  // 2) Explicit relPath.
  if (isNonEmptyString(target?.relPath)) {
    const filePath = joinFsPath(normalizedNotesPath, target.relPath)
    const { canvasId } = await CanvasHistoryService.getCanvasId({ notesPath: normalizedNotesPath, filePath })
    return { notesPath: normalizedNotesPath, canvasId, relPath: target.relPath, filePath }
  }

  // 3) Explicit canvasId.
  if (isNonEmptyString(target?.canvasId)) {
    const resolved = await CanvasHistoryService.resolveFilePathForCanvasId({
      notesPath: normalizedNotesPath,
      canvasId: target.canvasId
    })
    if (!resolved) {
      throw new Error(`Unknown canvasId (not found in mapping): ${target.canvasId}`)
    }
    return {
      notesPath: normalizedNotesPath,
      canvasId: target.canvasId,
      relPath: resolved.relPath,
      filePath: resolved.filePath
    }
  }

  // 4) Default target from plugin context.
  if (defaultTarget?.canvasId && defaultTarget.filePath) {
    const rel = toNotesRelativePath(normalizedNotesPath, defaultTarget.filePath)
    if (rel) {
      return {
        notesPath: normalizedNotesPath,
        canvasId: defaultTarget.canvasId,
        relPath: rel,
        filePath: normalizeFsPath(defaultTarget.filePath)
      }
    }
  }

  // 5) Fall back to the active canvas in Notes page (best-effort).
  const activeFilePath = store.getState().note.activeFilePath as string | undefined
  if (isNonEmptyString(activeFilePath)) {
    const rel = toNotesRelativePath(normalizedNotesPath, activeFilePath)
    if (rel) {
      const { canvasId } = await CanvasHistoryService.getCanvasId({
        notesPath: normalizedNotesPath,
        filePath: activeFilePath
      })
      return { notesPath: normalizedNotesPath, canvasId, relPath: rel, filePath: normalizeFsPath(activeFilePath) }
    }
  }

  throw new Error('No active canvas selected. Provide target.canvasId or open/select a canvas first.')
}

async function getAvailableNewFilePath(args: {
  notesPath: string
  relDir: string
  baseName: string
  ext?: string
}): Promise<string> {
  const ext = args.ext || '.md'
  const base = sanitizeFileNameBase(args.baseName)
  const dir = joinFsPath(normalizeFsPath(args.notesPath), args.relDir)

  // Ensure folder exists; non-fatal if already exists.
  try {
    await window.api.file.mkdir(dir)
  } catch (error) {
    logger.debug('Failed to mkdir for canvas create (ignored):', { dir, error: (error as Error)?.message })
  }

  for (let i = 0; i < 200; i += 1) {
    const candidate = i === 0 ? `${base}${ext}` : `${base} (${i + 1})${ext}`
    const filePath = joinFsPath(dir, candidate)
    const exists = await window.api.file.get(filePath)
    if (!exists) return filePath
  }

  throw new Error(`Failed to find available filename for: ${base}${ext}`)
}

export const canvasReadTool = (args: {
  notesPath: string
  defaultTarget?: { canvasId: string; filePath: string } | null
}) => {
  const { notesPath, defaultTarget } = args
  return tool({
    name: 'builtin_canvas_read',
    description:
      'Read the current content of a Canvas (markdown file). Use this to inspect before making edits. Prefer target.canvasId when multiple canvases exist.',
    inputSchema: z.object({
      target: CanvasTargetSchema
    }),
    execute: async ({ target }) => {
      const resolved = await resolveCanvasTarget({ notesPath, target, defaultTarget })
      const content = await window.api.fs.readText(resolved.filePath)
      return {
        canvasId: resolved.canvasId,
        relPath: resolved.relPath,
        filePath: resolved.filePath,
        byteSize: new TextEncoder().encode(content).byteLength,
        content
      }
    }
  })
}

export const canvasListTool = (args: { notesPath: string }) => {
  const { notesPath } = args
  return tool({
    name: 'builtin_canvas_list',
    description:
      'List canvases known to the portable mapping index. Use this to choose a target canvas when multiple canvases exist.',
    inputSchema: z.object({
      query: z.string().optional().describe('Optional substring to filter by path/canvasId'),
      limit: z.number().int().min(1).max(200).optional().describe('Max number of canvases to return (default 50)')
    }),
    execute: async ({ query, limit }) => {
      const list = await CanvasHistoryService.listCanvases({ notesPath, query, limit })
      return { notesPath: normalizeFsPath(notesPath), count: list.length, canvases: list }
    }
  })
}

export const canvasCreateTool = (args: {
  notesPath: string
  defaultFolderRelPath?: string
  onCreated?: (created: { canvasId: string; filePath: string; relPath: string }) => Promise<void> | void
}) => {
  const { notesPath, defaultFolderRelPath = 'From Chat', onCreated } = args
  return tool({
    name: 'builtin_canvas_create',
    description:
      'Create a new Canvas (markdown file) inside the notes folder. Returns canvasId for later edits. Useful when a chat wants to create multiple canvases.',
    inputSchema: z.object({
      title: z.string().describe('Title used for the filename'),
      folderRelPath: z.string().optional().describe('Folder relative to notes root. Defaults to "From Chat".'),
      content: z.string().optional().describe('Initial markdown content (optional)'),
      reason: z.string().optional().describe('Optional reason saved into Canvas history')
    }),
    execute: async ({ title, folderRelPath, content, reason }) => {
      const safeTitle = sanitizeFileNameBase(title)
      const filePath = await getAvailableNewFilePath({
        notesPath,
        relDir: folderRelPath?.trim() || defaultFolderRelPath,
        baseName: safeTitle,
        ext: '.md'
      })

      const nextContent = content ?? `# ${safeTitle}\n\n`
      await window.api.file.write(filePath, nextContent)

      const { canvasId } = await CanvasHistoryService.getCanvasId({ notesPath, filePath })
      await CanvasHistoryService.commitVersion({
        notesPath,
        filePath,
        content: nextContent,
        actor: 'assistant',
        reason: reason?.trim() || 'create canvas',
        force: true
      })

      const relPath = toNotesRelativePath(notesPath, filePath)
      if (onCreated) {
        await onCreated({ canvasId, filePath, relPath: relPath || '' })
      }

      return {
        created: true,
        canvasId,
        filePath,
        relPath,
        title: safeTitle,
        preview: nextContent.slice(0, 300),
        openAction: {
          type: 'open_canvas',
          canvasId,
          filePath,
          relPath
        }
      }
    }
  })
}

export const canvasAppendTool = (args: {
  notesPath: string
  defaultTarget?: { canvasId: string; filePath: string } | null
}) => {
  const { notesPath, defaultTarget } = args
  return tool({
    name: 'builtin_canvas_append',
    description:
      'Append markdown to the end of a Canvas. Applies immediately (writes file) and saves a history version.',
    inputSchema: z.object({
      target: CanvasTargetSchema,
      text: z.string().describe('Markdown text to append'),
      ensureNewline: z.boolean().optional().describe('Ensure there is a blank line before appending (default true)'),
      reason: z.string().optional().describe('Reason saved into version history')
    }),
    execute: async ({ target, text, ensureNewline, reason }) => {
      const resolved = await resolveCanvasTarget({ notesPath, target, defaultTarget })
      const before = await window.api.fs.readText(resolved.filePath)
      const sep = ensureNewline === false ? '' : before.endsWith('\n') ? '\n' : '\n\n'
      const after = `${before}${sep}${text}`

      if (after === before) {
        return { changed: false, canvasId: resolved.canvasId, filePath: resolved.filePath, relPath: resolved.relPath }
      }

      await window.api.file.write(resolved.filePath, after)
      const commit = await CanvasHistoryService.commitVersion({
        notesPath: resolved.notesPath,
        filePath: resolved.filePath,
        content: after,
        actor: 'assistant',
        reason: reason?.trim() || 'append',
        force: true
      })

      return {
        changed: true,
        canvasId: resolved.canvasId,
        filePath: resolved.filePath,
        relPath: resolved.relPath,
        versionId: commit.version?.id ?? null,
        diffPatch: buildUnifiedDiffPatch({
          beforeLabel: `${basenameFsPath(resolved.filePath)} (before)`,
          afterLabel: `${basenameFsPath(resolved.filePath)} (after)`,
          before,
          after
        })
      }
    }
  })
}

export const canvasReplaceTool = (args: {
  notesPath: string
  defaultTarget?: { canvasId: string; filePath: string } | null
}) => {
  const { notesPath, defaultTarget } = args
  return tool({
    name: 'builtin_canvas_replace',
    description:
      'Replace a specific text snippet in a Canvas. By default requires exactly one match (safe replace); set replaceAll=true to replace multiple matches. Applies immediately and saves a history version.',
    inputSchema: z.object({
      target: CanvasTargetSchema,
      pattern: z.string().describe('Exact text snippet to replace (literal match)'),
      replacement: z.string().describe('Replacement text'),
      replaceAll: z.boolean().optional().describe('Replace all matches (default false)'),
      reason: z.string().optional().describe('Reason saved into version history')
    }),
    execute: async ({ target, pattern, replacement, replaceAll, reason }) => {
      const resolved = await resolveCanvasTarget({ notesPath, target, defaultTarget })
      const before = await window.api.fs.readText(resolved.filePath)
      const { after, matches } = applyLiteralReplace({ before, pattern, replacement, replaceAll })

      if (after === before) {
        return {
          changed: false,
          canvasId: resolved.canvasId,
          filePath: resolved.filePath,
          relPath: resolved.relPath,
          matches
        }
      }

      await window.api.file.write(resolved.filePath, after)
      const commit = await CanvasHistoryService.commitVersion({
        notesPath: resolved.notesPath,
        filePath: resolved.filePath,
        content: after,
        actor: 'assistant',
        reason: reason?.trim() || 'replace',
        force: true
      })

      return {
        changed: true,
        canvasId: resolved.canvasId,
        filePath: resolved.filePath,
        relPath: resolved.relPath,
        matches,
        versionId: commit.version?.id ?? null,
        diffPatch: buildUnifiedDiffPatch({
          beforeLabel: `${basenameFsPath(resolved.filePath)} (before)`,
          afterLabel: `${basenameFsPath(resolved.filePath)} (after)`,
          before,
          after
        })
      }
    }
  })
}

export const canvasAddCommentTool = (args: {
  notesPath: string
  defaultTarget?: { canvasId: string; filePath: string } | null
}) => {
  const { notesPath, defaultTarget } = args
  return tool({
    name: 'builtin_canvas_add_comment',
    description:
      'Add a review comment to a Canvas by anchoring to an exact unique text snippet. If the snippet appears multiple times, this tool errors so the caller can provide a more specific snippet.',
    inputSchema: z.object({
      target: CanvasTargetSchema,
      pattern: z.string().describe('Exact unique snippet to anchor the comment'),
      comment: z.string().describe('Comment text to attach to that snippet'),
      type: z.enum(['important', 'suggestion', 'question', 'none']).optional().describe('Comment type (default none)'),
      reason: z.string().optional().describe('Optional reason/context for the tool call')
    }),
    execute: async ({ target, pattern, comment, type, reason }) => {
      const resolved = await resolveCanvasTarget({ notesPath, target, defaultTarget })

      const created = await CanvasCommentService.addCommentByPattern({
        notesPath: resolved.notesPath,
        canvasId: resolved.canvasId,
        pattern,
        comment,
        type: (type as CanvasCommentType | undefined) || 'none',
        createdBy: 'assistant'
      })

      return {
        canvasId: resolved.canvasId,
        filePath: resolved.filePath,
        relPath: resolved.relPath,
        commentId: created.id,
        status: created.status,
        type: created.type,
        anchorPreview: created.anchorPreview,
        summary: reason?.trim() || `Added ${created.type} comment`
      }
    }
  })
}

export type CanvasReadToolInput = InferToolInput<ReturnType<typeof canvasReadTool>>
export type CanvasReadToolOutput = InferToolOutput<ReturnType<typeof canvasReadTool>>
export type CanvasListToolInput = InferToolInput<ReturnType<typeof canvasListTool>>
export type CanvasListToolOutput = InferToolOutput<ReturnType<typeof canvasListTool>>
export type CanvasCreateToolInput = InferToolInput<ReturnType<typeof canvasCreateTool>>
export type CanvasCreateToolOutput = InferToolOutput<ReturnType<typeof canvasCreateTool>>
export type CanvasAppendToolInput = InferToolInput<ReturnType<typeof canvasAppendTool>>
export type CanvasAppendToolOutput = InferToolOutput<ReturnType<typeof canvasAppendTool>>
export type CanvasReplaceToolInput = InferToolInput<ReturnType<typeof canvasReplaceTool>>
export type CanvasReplaceToolOutput = InferToolOutput<ReturnType<typeof canvasReplaceTool>>
export type CanvasAddCommentToolInput = InferToolInput<ReturnType<typeof canvasAddCommentTool>>
export type CanvasAddCommentToolOutput = InferToolOutput<ReturnType<typeof canvasAddCommentTool>>
