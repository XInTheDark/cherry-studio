import { loggerService } from '@logger'
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import type { CodeEditorHandles } from '@renderer/components/CodeEditor'
import type { RichEditorRef } from '@renderer/components/RichEditor/types'
import { useActiveNode, useFileContent, useFileContentSync } from '@renderer/hooks/useNotesQuery'
import { useNotesSettings } from '@renderer/hooks/useNotesSettings'
import { useShowWorkspace } from '@renderer/hooks/useShowWorkspace'
import CanvasCommentService from '@renderer/services/CanvasCommentService'
import CanvasHistoryService from '@renderer/services/CanvasHistoryService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import {
  addDir,
  addNote,
  delNode,
  loadTree,
  renameNode as renameEntry,
  sortTree,
  uploadNotes
} from '@renderer/services/NotesService'
import {
  addUniquePath,
  findNode,
  findNodeByPath,
  findParent,
  normalizePathValue,
  removePathEntries,
  reorderTreeNodes,
  replacePathEntries,
  updateTreeNode
} from '@renderer/services/NotesTreeService'
import { useAppDispatch, useAppSelector, useAppStore } from '@renderer/store'
import {
  selectActiveFilePath,
  selectExpandedPaths,
  selectSortType,
  selectStarredPaths,
  setActiveFilePath,
  setExpandedPaths,
  setSortType,
  setStarredPaths
} from '@renderer/store/note'
import type { CanvasCommentAnchor } from '@renderer/types'
import type { NotesSortType, NotesTreeNode } from '@renderer/types/note'
import type { FileChangeEvent } from '@shared/config/types'
import { Button, Input, message } from 'antd'
import { debounce } from 'lodash'
import { AnimatePresence, motion } from 'motion/react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import CanvasChatSidebar from './CanvasChatSidebar'
import HeaderNavbar from './HeaderNavbar'
import NotesEditor from './NotesEditor'
import NotesSidebar from './NotesSidebar'

const logger = loggerService.withContext('NotesPage')
const CANVAS_COMMENT_HIGHLIGHT_NAME = 'canvas-comments'

type EditorSelectionSnapshot = {
  source: 'code' | 'rich'
  text: string
  startOffset?: number
  endOffset?: number
  rect?: DOMRect
}

type CommentHighlightRange = {
  id: string
  anchor: CanvasCommentAnchor
  content: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function getCanvasEditorRoot(): HTMLElement | null {
  return (
    (document.querySelector('#notes-page .notes-rich-editor .ProseMirror') as HTMLElement | null) ||
    (document.querySelector('#notes-page .cm-content') as HTMLElement | null)
  )
}

function clearCanvasCommentHighlights() {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) {
    return
  }
  try {
    CSS.highlights.delete(CANVAS_COMMENT_HIGHLIGHT_NAME)
  } catch {
    // ignore
  }
}

function createTextRangeFromOffsets(root: HTMLElement, start: number, end: number): Range | null {
  if (start < 0 || end <= start) return null

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let currentOffset = 0
  let startNode: Text | null = null
  let startNodeOffset = 0
  let endNode: Text | null = null
  let endNodeOffset = 0

  let node = walker.nextNode() as Text | null
  while (node) {
    const len = node.nodeValue?.length ?? 0
    const nextOffset = currentOffset + len

    if (!startNode && start >= currentOffset && start <= nextOffset) {
      startNode = node
      startNodeOffset = start - currentOffset
    }

    if (!endNode && end >= currentOffset && end <= nextOffset) {
      endNode = node
      endNodeOffset = end - currentOffset
      break
    }

    currentOffset = nextOffset
    node = walker.nextNode() as Text | null
  }

  if (!startNode || !endNode) return null

  try {
    const range = new Range()
    range.setStart(startNode, Math.max(0, startNodeOffset))
    range.setEnd(endNode, Math.max(0, endNodeOffset))
    return range
  } catch (error) {
    logger.debug('Failed to build highlight range from offsets (ignored):', error as Error)
    return null
  }
}

function linearizeRootText(root: HTMLElement): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let result = ''
  let node = walker.nextNode() as Text | null
  while (node) {
    result += node.nodeValue ?? ''
    node = walker.nextNode() as Text | null
  }
  return result
}

function getRootTextOffsetsFromDomRange(root: HTMLElement, range: Range): { start: number; end: number } | null {
  if (!(range.startContainer instanceof Text) || !(range.endContainer instanceof Text)) {
    return null
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let cursor = 0
  let start = -1
  let end = -1

  let node = walker.nextNode() as Text | null
  while (node) {
    const len = node.nodeValue?.length ?? 0
    if (node === range.startContainer) {
      start = cursor + range.startOffset
    }
    if (node === range.endContainer) {
      end = cursor + range.endOffset
      break
    }
    cursor += len
    node = walker.nextNode() as Text | null
  }

  if (start < 0 || end <= start) return null
  return { start, end }
}

const NotesPage: FC = () => {
  const editorRef = useRef<RichEditorRef>(null)
  const codeEditorRef = useRef<CodeEditorHandles>(null)
  const { t } = useTranslation()
  const { showWorkspace } = useShowWorkspace()
  const dispatch = useAppDispatch()
  const store = useAppStore()
  const activeFilePath = useAppSelector(selectActiveFilePath)
  const sortType = useAppSelector(selectSortType)
  const starredPaths = useAppSelector(selectStarredPaths)
  const expandedPaths = useAppSelector(selectExpandedPaths)
  const { settings, notesPath, updateNotesPath } = useNotesSettings()

  // 混合策略：useLiveQuery用于笔记树，React Query用于文件内容
  const [notesTree, setNotesTree] = useState<NotesTreeNode[]>([])
  const starredSet = useMemo(() => new Set(starredPaths), [starredPaths])
  const expandedSet = useMemo(() => new Set(expandedPaths), [expandedPaths])
  const { activeNode } = useActiveNode(notesTree)
  const { invalidateFileContent } = useFileContentSync()
  const { data: currentContent = '' } = useFileContent(activeFilePath)

  const [tokenCount, setTokenCount] = useState(0)
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const watcherRef = useRef<(() => void) | null>(null)
  const lastContentRef = useRef<string>('')
  const lastFilePathRef = useRef<string | undefined>(undefined)
  const isRenamingRef = useRef(false)
  const isCreatingNoteRef = useRef(false)
  const pendingScrollRef = useRef<{ lineNumber: number; lineContent?: string } | null>(null)
  const [isCanvasChatOpen, setIsCanvasChatOpen] = useState(false)
  const [activeCanvasId, setActiveCanvasId] = useState<string>('')
  const [commentHighlightRanges, setCommentHighlightRanges] = useState<CommentHighlightRange[]>([])
  const commentDomRangesRef = useRef<Array<{ id: string; content: string; range: Range }>>([])
  const [commentHoverTooltip, setCommentHoverTooltip] = useState<{
    open: boolean
    left: number
    top: number
    content: string
  }>({
    open: false,
    left: 0,
    top: 0,
    content: ''
  })
  const [selectionContextMenu, setSelectionContextMenu] = useState<{
    open: boolean
    left: number
    top: number
    selection: EditorSelectionSnapshot | null
  }>({
    open: false,
    left: 0,
    top: 0,
    selection: null
  })
  const selectionContextMenuRef = useRef<HTMLDivElement | null>(null)
  const [commentComposer, setCommentComposer] = useState<{
    open: boolean
    left: number
    top: number
    source: 'code' | 'rich'
    selectedText: string
    startOffset?: number
    endOffset?: number
    draft: string
  }>({
    open: false,
    left: 0,
    top: 0,
    source: 'code',
    selectedText: '',
    startOffset: undefined,
    endOffset: undefined,
    draft: ''
  })
  const [inlinePrompt, setInlinePrompt] = useState<{
    open: boolean
    left: number
    top: number
    selectedText: string
    startOffset?: number
    endOffset?: number
    draft: string
  }>({
    open: false,
    left: 0,
    top: 0,
    selectedText: '',
    startOffset: undefined,
    endOffset: undefined,
    draft: ''
  })
  const closedForFileRef = useRef<string | null>(null)
  const [workspaceWidth, setWorkspaceWidth] = useState(280)
  const workspaceResizingRef = useRef<{ startX: number; startWidth: number; pointerId: number } | null>(null)
  const inlinePromptInputRef = useRef<HTMLTextAreaElement | null>(null)
  const commentComposerInputRef = useRef<HTMLTextAreaElement | null>(null)

  const activeFilePathRef = useRef<string | undefined>(activeFilePath)
  const currentContentRef = useRef(currentContent)
  const currentMarkdownRef = useRef(currentContent)

  const updateStarredPaths = useCallback(
    (updater: (paths: string[]) => string[]) => {
      const current = store.getState().note.starredPaths
      const safeCurrent = Array.isArray(current) ? current : []
      const next = updater(safeCurrent) ?? []
      if (!Array.isArray(next)) {
        return
      }
      if (next !== safeCurrent) {
        dispatch(setStarredPaths(next))
      }
    },
    [dispatch, store]
  )

  const updateExpandedPaths = useCallback(
    (updater: (paths: string[]) => string[]) => {
      const current = store.getState().note.expandedPaths
      const safeCurrent = Array.isArray(current) ? current : []
      const next = updater(safeCurrent) ?? []
      if (!Array.isArray(next)) {
        return
      }
      if (next !== safeCurrent) {
        dispatch(setExpandedPaths(next))
      }
    },
    [dispatch, store]
  )

  const mergeTreeState = useCallback(
    (nodes: NotesTreeNode[]): NotesTreeNode[] => {
      return nodes.map((node) => {
        const normalizedPath = normalizePathValue(node.externalPath)
        const merged: NotesTreeNode = {
          ...node,
          externalPath: normalizedPath,
          isStarred: starredSet.has(normalizedPath)
        }

        if (node.type === 'folder') {
          merged.expanded = expandedSet.has(normalizedPath)
          merged.children = node.children ? mergeTreeState(node.children) : []
        }

        return merged
      })
    },
    [starredSet, expandedSet]
  )

  const getCurrentMarkdownContent = useCallback((): string => {
    return currentMarkdownRef.current ?? ''
  }, [])

  const getDomSelectionRect = useCallback((): DOMRect | undefined => {
    const domSelection = window.getSelection()
    if (!domSelection || domSelection.rangeCount <= 0) return undefined
    const range = domSelection.getRangeAt(0)
    const rect = range.getBoundingClientRect()
    if (!rect || (rect.width <= 0 && rect.height <= 0)) return undefined
    return rect
  }, [])

  const getCurrentSelection = useCallback((): EditorSelectionSnapshot | null => {
    const codeSelection = codeEditorRef.current?.getSelection?.()
    if (codeSelection?.text?.trim()) {
      const rect = getDomSelectionRect()
      return {
        source: 'code',
        text: codeSelection.text,
        startOffset: codeSelection.startOffset,
        endOffset: codeSelection.endOffset,
        rect
      }
    }

    const richSelection = editorRef.current?.getSelection?.()
    if (richSelection?.text?.trim()) {
      const rect = getDomSelectionRect()
      let offsets: { start: number; end: number } | null = null
      const domSelection = window.getSelection()
      const range = domSelection && domSelection.rangeCount > 0 ? domSelection.getRangeAt(0) : null
      const root = getCanvasEditorRoot()
      if (range && root?.contains(range.startContainer) && root.contains(range.endContainer)) {
        offsets = getRootTextOffsetsFromDomRange(root, range)
      }
      return {
        source: 'rich',
        text: richSelection.text,
        startOffset: offsets?.start,
        endOffset: offsets?.end,
        rect
      }
    }

    return null
  }, [getDomSelectionRect])

  const refreshCommentHighlights = useCallback(
    async (_markdownContent?: string, filePath?: string) => {
      if (!notesPath) {
        setActiveCanvasId('')
        setCommentHighlightRanges([])
        return
      }

      const targetFilePath = filePath || activeFilePath
      if (!targetFilePath) {
        setActiveCanvasId('')
        setCommentHighlightRanges([])
        return
      }

      try {
        const { canvasId } = await CanvasHistoryService.getCanvasId({ notesPath, filePath: targetFilePath })
        setActiveCanvasId(canvasId)
        const comments = await CanvasCommentService.listComments(canvasId)
        setCommentHighlightRanges(
          comments.comments
            .filter((item) => item.status !== 'resolved')
            .map((item) => ({
              id: item.id,
              anchor: item.anchor,
              content: item.content
            }))
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        )
      } catch (error) {
        logger.error('Failed to refresh canvas comment highlights:', error as Error)
        setCommentHighlightRanges([])
      }
    },
    [activeFilePath, notesPath]
  )

  const refreshHighlightProjection = useCallback(() => {
    const root = getCanvasEditorRoot()
    clearCanvasCommentHighlights()
    commentDomRangesRef.current = []

    if (!root || commentHighlightRanges.length === 0) {
      setCommentHoverTooltip((prev) => (prev.open ? { ...prev, open: false } : prev))
      return
    }

    const renderedText = linearizeRootText(root)
    if (!renderedText.trim()) {
      setCommentHoverTooltip((prev) => (prev.open ? { ...prev, open: false } : prev))
      return
    }

    const ranges: Range[] = []
    const hoverRanges: Array<{ id: string; content: string; range: Range }> = []

    for (const item of commentHighlightRanges) {
      const offsets = CanvasCommentService.resolveAnchorOffsets(renderedText, item.anchor)
      if (!offsets) continue

      const range = createTextRangeFromOffsets(root, offsets.start, offsets.end)
      if (!range || !range.toString().trim()) {
        continue
      }

      ranges.push(range)
      hoverRanges.push({ id: item.id, content: item.content, range })
    }

    commentDomRangesRef.current = hoverRanges

    if (ranges.length === 0) {
      setCommentHoverTooltip((prev) => (prev.open ? { ...prev, open: false } : prev))
      return
    }

    if (typeof CSS === 'undefined' || !('highlights' in CSS)) {
      return
    }

    try {
      const highlight = new Highlight(...ranges)
      CSS.highlights.set(CANVAS_COMMENT_HIGHLIGHT_NAME, highlight)
    } catch (error) {
      logger.debug('Failed to apply canvas comment highlights (ignored):', error as Error)
    }
  }, [commentHighlightRanges])

  const refreshTree = useCallback(async () => {
    if (!notesPath) {
      setNotesTree([])
      return
    }

    try {
      const rawTree = await loadTree(notesPath)
      const sortedTree = sortTree(rawTree, sortType)
      setNotesTree(mergeTreeState(sortedTree))
    } catch (error) {
      logger.error('Failed to refresh notes tree:', error as Error)
    }
  }, [mergeTreeState, notesPath, sortType])

  useEffect(() => {
    const updateCharCount = () => {
      const textContent = editorRef.current?.getContent() || currentContent
      const plainText = textContent.replace(/<[^>]*>/g, '')
      setTokenCount(plainText.length)
    }
    updateCharCount()
  }, [currentContent])

  useEffect(() => {
    refreshTree()
  }, [refreshTree])

  // Canvas chat sidebar default behavior:
  // - auto-open when a canvas file is selected
  // - if user closes it, keep it closed for the current file until selection changes
  useEffect(() => {
    if (!activeNode || activeNode.type !== 'file' || !activeFilePath) {
      setIsCanvasChatOpen(false)
      closedForFileRef.current = null
      return
    }

    if (closedForFileRef.current && closedForFileRef.current === activeFilePath) {
      return
    }

    setIsCanvasChatOpen(true)
  }, [activeFilePath, activeNode])

  // Re-merge tree state when starred or expanded paths change
  useEffect(() => {
    if (notesTree.length > 0) {
      setNotesTree((prev) => mergeTreeState(prev))
    }
  }, [starredPaths, expandedPaths, mergeTreeState, notesTree.length])

  // 保存当前笔记内容
  const saveCurrentNote = useCallback(
    async (content: string, filePath?: string) => {
      const targetPath = filePath || activeFilePath
      if (!targetPath || content.trim() === currentContent.trim()) return

      try {
        await window.api.file.write(targetPath, content)
        // 保存后立即刷新缓存，确保下次读取时获取最新内容
        invalidateFileContent(targetPath)
      } catch (error) {
        logger.error('Failed to save note:', error as Error)
      }
    },
    [activeFilePath, currentContent, invalidateFileContent]
  )

  // Commit a canvas version for human edits (idle session or safety flush on navigation).
  const commitCanvasVersion = useCallback(
    async (content: string, filePath?: string, options?: { force?: boolean }) => {
      if (!notesPath) return
      const targetPath = filePath || activeFilePath
      if (!targetPath) return

      try {
        await CanvasHistoryService.commitVersion({
          notesPath,
          filePath: targetPath,
          content,
          actor: 'human',
          force: options?.force
        })
      } catch (error) {
        logger.error('Failed to commit canvas version:', error as Error)
      }
    },
    [activeFilePath, notesPath]
  )

  // 防抖保存函数，在停止输入后才保存，避免输入过程中的文件写入
  const debouncedSave = useMemo(
    () =>
      debounce((content: string, filePath: string | undefined) => {
        saveCurrentNote(content, filePath)
      }, 800), // 800ms防抖延迟
    [saveCurrentNote]
  )

  // Human edit session: snapshot version after 10s idle.
  const debouncedHistoryCommit = useMemo(
    () =>
      debounce((content: string, filePath: string | undefined) => {
        void commitCanvasVersion(content, filePath)
      }, 10_000),
    [commitCanvasVersion]
  )

  const debouncedCommentHighlightRefresh = useMemo(
    () =>
      debounce((content: string, filePath: string | undefined) => {
        void refreshCommentHighlights(content, filePath)
      }, 300),
    [refreshCommentHighlights]
  )

  const saveCurrentNoteRef = useRef(saveCurrentNote)
  const commitCanvasVersionRef = useRef(commitCanvasVersion)
  const debouncedSaveRef = useRef(debouncedSave)
  const debouncedHistoryCommitRef = useRef(debouncedHistoryCommit)
  const debouncedCommentHighlightRefreshRef = useRef(debouncedCommentHighlightRefresh)
  const invalidateFileContentRef = useRef(invalidateFileContent)
  const refreshTreeRef = useRef(refreshTree)

  const handleMarkdownChange = useCallback(
    (newMarkdown: string) => {
      // 记录最新内容和文件路径，用于兜底保存
      lastContentRef.current = newMarkdown
      lastFilePathRef.current = activeFilePath
      currentMarkdownRef.current = newMarkdown
      // 捕获当前文件路径，避免在防抖执行时文件路径已改变的竞态条件
      debouncedSave(newMarkdown, activeFilePath)
      debouncedHistoryCommit(newMarkdown, activeFilePath)
      debouncedCommentHighlightRefresh(newMarkdown, activeFilePath)
    },
    [debouncedCommentHighlightRefresh, debouncedSave, debouncedHistoryCommit, activeFilePath]
  )

  useEffect(() => {
    activeFilePathRef.current = activeFilePath
  }, [activeFilePath])

  useEffect(() => {
    currentContentRef.current = currentContent
    currentMarkdownRef.current = currentContent
  }, [currentContent])

  useEffect(() => {
    saveCurrentNoteRef.current = saveCurrentNote
  }, [saveCurrentNote])

  useEffect(() => {
    commitCanvasVersionRef.current = commitCanvasVersion
  }, [commitCanvasVersion])

  useEffect(() => {
    debouncedSaveRef.current = debouncedSave
  }, [debouncedSave])

  useEffect(() => {
    debouncedHistoryCommitRef.current = debouncedHistoryCommit
  }, [debouncedHistoryCommit])

  useEffect(() => {
    debouncedCommentHighlightRefreshRef.current = debouncedCommentHighlightRefresh
  }, [debouncedCommentHighlightRefresh])

  useEffect(() => {
    invalidateFileContentRef.current = invalidateFileContent
  }, [invalidateFileContent])

  useEffect(() => {
    refreshTreeRef.current = refreshTree
  }, [refreshTree])

  useEffect(() => {
    async function initialize() {
      if (!notesPath) {
        // 首次启动，获取默认路径
        const info = await window.api.getAppInfo()
        const defaultPath = info.notesPath
        updateNotesPath(defaultPath)
        return
      }

      // 验证路径是否有效（处理跨平台恢复场景）
      try {
        // 获取当前平台的默认路径
        const info = await window.api.getAppInfo()
        const defaultPath = info.notesPath

        // 如果当前路径就是默认路径，跳过验证（默认路径始终有效）
        if (notesPath === defaultPath) {
          return
        }

        const isValid = await window.api.file.validateNotesDirectory(notesPath)
        if (!isValid) {
          logger.warn('Invalid notes path detected, resetting to default', { path: notesPath })

          // 重置为默认路径
          updateNotesPath(defaultPath)

          // 检查默认路径下是否有笔记文件
          try {
            const tree = await window.api.file.getDirectoryStructure(defaultPath)
            if (!tree || tree.length === 0) {
              // 默认目录为空，提示用户需要迁移文件
              message.warning({
                content: t('notes.crossPlatformRestoreWarning', { path: defaultPath }),
                duration: 10
              })
            }
          } catch (error) {
            // 目录不存在或读取失败，会由 FileStorage 自动创建
            logger.debug('Default notes directory will be created', { error })
          }
        }
      } catch (error) {
        logger.error('Failed to validate notes path:', error as Error)
      }
    }

    initialize()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notesPath])

  // 处理树同步时的状态管理
  useEffect(() => {
    if (notesTree.length === 0) return
    // 如果有activeFilePath但找不到对应节点，清空选择
    // 但要排除正在同步树结构、重命名或创建笔记的情况，避免在这些操作中误清空
    const shouldClearPath = activeFilePath && !activeNode && !isRenamingRef.current && !isCreatingNoteRef.current

    if (shouldClearPath) {
      logger.warn('Clearing activeFilePath - node not found in tree', {
        activeFilePath,
        reason: 'Node not found in current tree'
      })
      dispatch(setActiveFilePath(undefined))
    }
  }, [notesTree, activeFilePath, activeNode, dispatch])

  useEffect(() => {
    if (!notesPath) return

    async function startFileWatcher() {
      // 清理之前的监控
      if (watcherRef.current) {
        watcherRef.current()
        watcherRef.current = null
      }

      // 定义文件变化处理函数
      const handleFileChange = async (data: FileChangeEvent) => {
        try {
          if (!notesPath) return
          const { eventType, filePath } = data
          const normalizedEventPath = normalizePathValue(filePath)

          switch (eventType) {
            case 'change': {
              // 处理文件内容变化 - 只有内容真正改变时才触发更新
              const activePath = activeFilePathRef.current
              if (activePath && normalizePathValue(activePath) === normalizedEventPath) {
                invalidateFileContentRef.current?.(normalizedEventPath)
              }
              break
            }

            case 'refresh': {
              // 批量操作完成后的单次刷新
              logger.debug('Received refresh event, triggering tree refresh')
              const refresh = refreshTreeRef.current
              if (refresh) {
                await refresh()
              }
              break
            }

            case 'add':
            case 'addDir':
            case 'unlink':
            case 'unlinkDir': {
              // 如果删除的是当前活动文件，清空选择
              if (
                (eventType === 'unlink' || eventType === 'unlinkDir') &&
                activeFilePathRef.current &&
                normalizePathValue(activeFilePathRef.current) === normalizedEventPath
              ) {
                dispatch(setActiveFilePath(undefined))
                editorRef.current?.clear()
              }

              const refresh = refreshTreeRef.current
              if (refresh) {
                await refresh()
              }
              break
            }

            default:
              logger.debug('Unhandled file event type:', { eventType })
          }
        } catch (error) {
          logger.error('Failed to handle file change:', error as Error)
        }
      }

      try {
        await window.api.file.startFileWatcher(notesPath)
        watcherRef.current = window.api.file.onFileChange(handleFileChange)
      } catch (error) {
        logger.error('Failed to start file watcher:', error as Error)
      }
    }

    startFileWatcher()

    return () => {
      if (watcherRef.current) {
        watcherRef.current()
        watcherRef.current = null
      }
      window.api.file.stopFileWatcher().catch((error) => {
        logger.error('Failed to stop file watcher:', error)
      })

      // 如果有未保存的内容，立即保存
      if (lastContentRef.current && lastFilePathRef.current && lastContentRef.current !== currentContentRef.current) {
        const saveFn = saveCurrentNoteRef.current
        if (saveFn) {
          saveFn(lastContentRef.current, lastFilePathRef.current).catch((error) => {
            logger.error('Emergency save failed:', error as Error)
          })
        }

        // Also flush a version snapshot so the edit session can be restored later.
        const commitFn = commitCanvasVersionRef.current
        if (commitFn) {
          commitFn(lastContentRef.current, lastFilePathRef.current).catch((error) => {
            logger.error('Emergency history commit failed:', error as Error)
          })
        }
      }

      // 清理防抖函数
      debouncedSaveRef.current?.cancel()
      debouncedHistoryCommitRef.current?.cancel()
      debouncedCommentHighlightRefreshRef.current?.cancel()
    }
  }, [dispatch, notesPath])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !currentContent) return
    // 获取编辑器当前内容
    const editorMarkdown = editor.getMarkdown()

    // 只有当编辑器内容与期望内容不一致时才更新
    // 这样既能处理初始化，也能处理后续的内容同步，还能避免光标跳动
    if (editorMarkdown !== currentContent) {
      editor.setMarkdown(currentContent)
    }
  }, [currentContent, activeFilePath])

  // Execute pending scroll after file switch
  useEffect(() => {
    if (!pendingScrollRef.current || !currentContent) return

    const { lineNumber, lineContent } = pendingScrollRef.current
    pendingScrollRef.current = null

    // Wait for DOM to update before scrolling
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const codeEditor = codeEditorRef.current
        const richEditor = editorRef.current

        try {
          if (codeEditor?.scrollToLine) {
            codeEditor.scrollToLine(lineNumber, { highlight: true })
          } else if (richEditor?.scrollToLine) {
            richEditor.scrollToLine(lineNumber, { highlight: true, lineContent })
          }
        } catch (error) {
          logger.error('Failed to execute pending scroll:', error as Error)
        }
      })
    })
  }, [activeFilePath, currentContent])

  // 切换文件时的清理工作
  useEffect(() => {
    return () => {
      // 保存之前文件的内容
      if (lastContentRef.current && lastFilePathRef.current) {
        const saveFn = saveCurrentNoteRef.current
        if (saveFn) {
          saveFn(lastContentRef.current, lastFilePathRef.current).catch((error) => {
            logger.error('Emergency save before file switch failed:', error as Error)
          })
        }

        // Flush a snapshot on file switch in case the user navigates quickly (before idle timer fires).
        const commitFn = commitCanvasVersionRef.current
        if (commitFn) {
          commitFn(lastContentRef.current, lastFilePathRef.current).catch((error) => {
            logger.error('Emergency history commit before file switch failed:', error as Error)
          })
        }
      }

      // 取消防抖保存并清理状态
      debouncedSave.cancel()
      debouncedHistoryCommit.cancel()
      debouncedCommentHighlightRefresh.cancel()
      lastContentRef.current = ''
      lastFilePathRef.current = undefined
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilePath])

  // 获取目标文件夹路径（选中文件夹或根目录）
  const getTargetFolderPath = useCallback(
    (targetFolderId?: string) => {
      const folderId = targetFolderId || selectedFolderId
      if (folderId) {
        const selectedNode = findNode(notesTree, folderId)
        if (selectedNode && selectedNode.type === 'folder') {
          return selectedNode.externalPath
        }
      }
      return notesPath // 默认返回根目录
    },
    [selectedFolderId, notesTree, notesPath]
  )

  // 创建文件夹
  const handleCreateFolder = useCallback(
    async (name: string, targetFolderId?: string) => {
      try {
        const targetPath = getTargetFolderPath(targetFolderId)
        if (!targetPath) {
          throw new Error('No folder path selected')
        }
        await addDir(name, targetPath)
        updateExpandedPaths((prev) => addUniquePath(prev, normalizePathValue(targetPath)))
        await refreshTree()
      } catch (error) {
        logger.error('Failed to create folder:', error as Error)
      }
    },
    [getTargetFolderPath, refreshTree, updateExpandedPaths]
  )

  // 创建笔记
  const handleCreateNote = useCallback(
    async (name: string, targetFolderId?: string) => {
      try {
        isCreatingNoteRef.current = true

        const targetPath = getTargetFolderPath(targetFolderId)
        if (!targetPath) {
          throw new Error('No folder path selected')
        }
        const { path: notePath } = await addNote(name, '', targetPath)
        const normalizedParent = normalizePathValue(targetPath)
        updateExpandedPaths((prev) => addUniquePath(prev, normalizedParent))
        dispatch(setActiveFilePath(notePath))
        setSelectedFolderId(null)

        await refreshTree()
      } catch (error) {
        logger.error('Failed to create note:', error as Error)
      } finally {
        // 延迟重置标志，给数据库同步一些时间
        setTimeout(() => {
          isCreatingNoteRef.current = false
        }, 500)
      }
    },
    [dispatch, getTargetFolderPath, refreshTree, updateExpandedPaths]
  )

  const handleToggleExpanded = useCallback(
    (nodeId: string) => {
      const targetNode = findNode(notesTree, nodeId)
      if (!targetNode || targetNode.type !== 'folder') {
        return
      }

      const nextExpanded = !targetNode.expanded
      // Update Redux state first, then let mergeTreeState handle the UI update
      updateExpandedPaths((prev) =>
        nextExpanded
          ? addUniquePath(prev, targetNode.externalPath)
          : removePathEntries(prev, targetNode.externalPath, false)
      )
    },
    [notesTree, updateExpandedPaths]
  )

  const handleToggleStar = useCallback(
    (nodeId: string) => {
      const node = findNode(notesTree, nodeId)
      if (!node) {
        return
      }

      const nextStarred = !node.isStarred
      // Update Redux state first, then let mergeTreeState handle the UI update
      updateStarredPaths((prev) =>
        nextStarred ? addUniquePath(prev, node.externalPath) : removePathEntries(prev, node.externalPath, false)
      )
    },
    [notesTree, updateStarredPaths]
  )

  // 选择节点
  const handleSelectNode = useCallback(
    async (node: NotesTreeNode) => {
      if (node.type === 'file') {
        try {
          dispatch(setActiveFilePath(node.externalPath))
          invalidateFileContent(node.externalPath)
          // 清除文件夹选择状态
          setSelectedFolderId(null)
        } catch (error) {
          logger.error('Failed to load note:', error as Error)
        }
      } else if (node.type === 'folder') {
        setSelectedFolderId(node.id)
        handleToggleExpanded(node.id)
      }
    },
    [dispatch, handleToggleExpanded, invalidateFileContent]
  )

  // 删除节点
  const handleDeleteNode = useCallback(
    async (nodeId: string) => {
      try {
        const nodeToDelete = findNode(notesTree, nodeId)
        if (!nodeToDelete) return

        await delNode(nodeToDelete)

        updateStarredPaths((prev) => removePathEntries(prev, nodeToDelete.externalPath, nodeToDelete.type === 'folder'))
        updateExpandedPaths((prev) =>
          removePathEntries(prev, nodeToDelete.externalPath, nodeToDelete.type === 'folder')
        )

        const normalizedActivePath = activeFilePath ? normalizePathValue(activeFilePath) : undefined
        const normalizedDeletePath = normalizePathValue(nodeToDelete.externalPath)
        const isActiveNode = normalizedActivePath === normalizedDeletePath
        const isActiveDescendant =
          nodeToDelete.type === 'folder' &&
          normalizedActivePath &&
          normalizedActivePath.startsWith(`${normalizedDeletePath}/`)

        if (isActiveNode || isActiveDescendant) {
          dispatch(setActiveFilePath(undefined))
          editorRef.current?.clear()
        }

        await refreshTree()
      } catch (error) {
        logger.error('Failed to delete node:', error as Error)
      }
    },
    [notesTree, activeFilePath, dispatch, refreshTree, updateStarredPaths, updateExpandedPaths]
  )

  // 重命名节点
  const handleRenameNode = useCallback(
    async (nodeId: string, newName: string) => {
      try {
        isRenamingRef.current = true

        const node = findNode(notesTree, nodeId)
        if (!node || node.name === newName) {
          return
        }

        const oldPath = node.externalPath
        const renamed = await renameEntry(node, newName)

        if (node.type === 'file' && activeFilePath === oldPath) {
          debouncedSaveRef.current?.cancel()
          lastFilePathRef.current = renamed.path
          dispatch(setActiveFilePath(renamed.path))
        } else if (node.type === 'folder' && activeFilePath && activeFilePath.startsWith(`${oldPath}/`)) {
          const suffix = activeFilePath.slice(oldPath.length)
          const nextActivePath = `${renamed.path}${suffix}`
          debouncedSaveRef.current?.cancel()
          lastFilePathRef.current = nextActivePath
          dispatch(setActiveFilePath(nextActivePath))
        }

        updateStarredPaths((prev) => replacePathEntries(prev, oldPath, renamed.path, node.type === 'folder'))
        updateExpandedPaths((prev) => replacePathEntries(prev, oldPath, renamed.path, node.type === 'folder'))

        // Keep canvas version history mapped across renames/moves.
        if (notesPath) {
          CanvasHistoryService.rewriteMappingPath({
            notesPath,
            oldPath,
            newPath: renamed.path,
            deep: node.type === 'folder'
          }).catch((error) => {
            logger.error('Failed to update canvas mapping after rename:', error as Error)
          })
        }

        await refreshTree()
      } catch (error) {
        logger.error('Failed to rename node:', error as Error)
      } finally {
        setTimeout(() => {
          isRenamingRef.current = false
        }, 500)
      }
    },
    [activeFilePath, dispatch, notesPath, notesTree, refreshTree, updateStarredPaths, updateExpandedPaths]
  )

  // 处理文件上传
  const handleUploadFiles = useCallback(
    async (files: File[]) => {
      try {
        if (!files || files.length === 0) {
          window.toast.warning(t('notes.no_file_selected'))
          return
        }

        const targetFolderPath = getTargetFolderPath()
        if (!targetFolderPath) {
          throw new Error('No folder path selected')
        }

        // Validate uploadNotes function is available
        if (typeof uploadNotes !== 'function') {
          logger.error('uploadNotes function is not available', { uploadNotes })
          window.toast.error(t('notes.upload_failed'))
          return
        }

        let result: Awaited<ReturnType<typeof uploadNotes>>
        try {
          result = await uploadNotes(files, targetFolderPath)
        } catch (uploadError) {
          logger.error('Upload operation failed:', uploadError as Error)
          throw uploadError
        }

        // Validate result object
        if (!result || typeof result !== 'object') {
          logger.error('Invalid upload result:', { result })
          window.toast.error(t('notes.upload_failed'))
          return
        }

        // 检查上传结果
        if (result.fileCount === 0) {
          window.toast.warning(t('notes.no_valid_files'))
          return
        }

        // 排序并显示成功信息
        updateExpandedPaths((prev) => addUniquePath(prev, normalizePathValue(targetFolderPath)))
        await refreshTree()

        const successMessage = t('notes.upload_success')

        window.toast.success(successMessage)
      } catch (error) {
        logger.error('Failed to handle file upload:', error as Error)
        window.toast.error(t('notes.upload_failed'))
      }
    },
    [getTargetFolderPath, refreshTree, t, updateExpandedPaths]
  )

  // 处理节点移动
  const handleMoveNode = useCallback(
    async (sourceNodeId: string, targetNodeId: string, position: 'before' | 'after' | 'inside') => {
      if (!notesPath) {
        return
      }

      try {
        const sourceNode = findNode(notesTree, sourceNodeId)
        const targetNode = findNode(notesTree, targetNodeId)

        if (!sourceNode || !targetNode) {
          return
        }

        if (position === 'inside' && targetNode.type !== 'folder') {
          return
        }

        const rootPath = normalizePathValue(notesPath)
        const sourceParentNode = findParent(notesTree, sourceNodeId)
        const targetParentNode = position === 'inside' ? targetNode : findParent(notesTree, targetNodeId)

        const sourceParentPath = sourceParentNode ? sourceParentNode.externalPath : rootPath
        const targetParentPath =
          position === 'inside' ? targetNode.externalPath : targetParentNode ? targetParentNode.externalPath : rootPath

        const normalizedSourceParent = normalizePathValue(sourceParentPath)
        const normalizedTargetParent = normalizePathValue(targetParentPath)

        const isManualReorder = position !== 'inside' && normalizedSourceParent === normalizedTargetParent

        if (isManualReorder) {
          // For manual reordering within the same parent, we can optimize by only updating the affected parent
          setNotesTree((prev) =>
            reorderTreeNodes(prev, sourceNodeId, targetNodeId, position === 'before' ? 'before' : 'after')
          )
          return
        }

        const { safeName } = await window.api.file.checkFileName(
          normalizedTargetParent,
          sourceNode.name,
          sourceNode.type === 'file'
        )

        const destinationPath =
          sourceNode.type === 'file'
            ? `${normalizedTargetParent}/${safeName}.md`
            : `${normalizedTargetParent}/${safeName}`

        if (destinationPath === sourceNode.externalPath) {
          return
        }

        if (sourceNode.type === 'file') {
          await window.api.file.move(sourceNode.externalPath, destinationPath)
        } else {
          await window.api.file.moveDir(sourceNode.externalPath, destinationPath)
        }

        // Keep canvas version history mapped across moves.
        if (notesPath) {
          CanvasHistoryService.rewriteMappingPath({
            notesPath,
            oldPath: sourceNode.externalPath,
            newPath: destinationPath,
            deep: sourceNode.type === 'folder'
          }).catch((error) => {
            logger.error('Failed to update canvas mapping after move:', error as Error)
          })
        }

        updateStarredPaths((prev) =>
          replacePathEntries(prev, sourceNode.externalPath, destinationPath, sourceNode.type === 'folder')
        )
        updateExpandedPaths((prev) => {
          let next = replacePathEntries(prev, sourceNode.externalPath, destinationPath, sourceNode.type === 'folder')
          next = addUniquePath(next, normalizedTargetParent)
          return next
        })

        const normalizedActivePath = activeFilePath ? normalizePathValue(activeFilePath) : undefined
        if (normalizedActivePath) {
          if (normalizedActivePath === sourceNode.externalPath) {
            // Cancel debounced save to prevent saving to old path
            debouncedSaveRef.current?.cancel()
            lastFilePathRef.current = destinationPath
            dispatch(setActiveFilePath(destinationPath))
          } else if (sourceNode.type === 'folder' && normalizedActivePath.startsWith(`${sourceNode.externalPath}/`)) {
            const suffix = normalizedActivePath.slice(sourceNode.externalPath.length)
            const newActivePath = `${destinationPath}${suffix}`
            // Cancel debounced save to prevent saving to old path
            debouncedSaveRef.current?.cancel()
            lastFilePathRef.current = newActivePath
            dispatch(setActiveFilePath(newActivePath))
          }
        }

        await refreshTree()
      } catch (error) {
        logger.error('Failed to move nodes:', error as Error)
      }
    },
    [activeFilePath, dispatch, notesPath, notesTree, refreshTree, updateStarredPaths, updateExpandedPaths]
  )

  // 处理节点排序
  const handleSortNodes = useCallback(
    async (newSortType: NotesSortType) => {
      dispatch(setSortType(newSortType))
      setNotesTree((prev) => mergeTreeState(sortTree(prev, newSortType)))
    },
    [dispatch, mergeTreeState]
  )

  const handleExpandPath = useCallback(
    (treePath: string) => {
      if (!treePath) {
        return
      }

      const segments = treePath.split('/').filter(Boolean)
      if (segments.length === 0) {
        return
      }

      let nextTree = notesTree
      const pathsToAdd: string[] = []

      segments.forEach((_, index) => {
        const currentPath = '/' + segments.slice(0, index + 1).join('/')
        const node = findNodeByPath(nextTree, currentPath)
        if (node && node.type === 'folder' && !node.expanded) {
          pathsToAdd.push(node.externalPath)
          nextTree = updateTreeNode(nextTree, node.id, (current) => ({ ...current, expanded: true }))
        }
      })

      if (pathsToAdd.length > 0) {
        setNotesTree(nextTree)
        updateExpandedPaths((prev) => {
          let updated = prev
          pathsToAdd.forEach((path) => {
            updated = addUniquePath(updated, path)
          })
          return updated
        })
      }
    },
    [notesTree, updateExpandedPaths]
  )

  const getCurrentNoteContent = useCallback(() => {
    if (settings.defaultEditMode === 'source') {
      return currentContent
    } else {
      return editorRef.current?.getMarkdown() || currentContent
    }
  }, [currentContent, settings.defaultEditMode])

  const closeSelectionContextMenu = useCallback(() => {
    setSelectionContextMenu((prev) => (prev.open ? { ...prev, open: false, selection: null } : prev))
  }, [])

  const closeCommentComposer = useCallback(() => {
    setCommentComposer((prev) => ({
      ...prev,
      open: false,
      source: 'code',
      draft: '',
      selectedText: '',
      startOffset: undefined,
      endOffset: undefined
    }))
  }, [])

  const openCommentComposer = useCallback(
    (selection: EditorSelectionSnapshot, anchor?: { left?: number; top?: number }) => {
      if (!selection.text?.trim()) {
        window.toast?.warning?.(t('notes.comments.select_text_first'))
        return
      }

      const width = 340
      const height = 220
      const margin = 10
      const fallbackLeft = anchor?.left ?? window.innerWidth / 2
      const fallbackTop = anchor?.top ?? window.innerHeight / 2
      let left = clamp(fallbackLeft + 12, margin, window.innerWidth - width - margin)
      let top = clamp(fallbackTop, margin, window.innerHeight - height - margin)

      if (selection.rect) {
        const rightSideLeft = selection.rect.right + 12
        const leftSideLeft = selection.rect.left - width - 12
        left = rightSideLeft + width + margin <= window.innerWidth ? rightSideLeft : leftSideLeft
        left = clamp(left, margin, window.innerWidth - width - margin)
        top = clamp(selection.rect.top, margin, window.innerHeight - height - margin)
      }

      setCommentComposer({
        open: true,
        left,
        top,
        source: selection.source,
        selectedText: selection.text,
        startOffset: selection.startOffset,
        endOffset: selection.endOffset,
        draft: ''
      })
      closeSelectionContextMenu()
    },
    [closeSelectionContextMenu, t]
  )

  const requestCommentComposerFromCurrentSelection = useCallback(
    (anchor?: { left?: number; top?: number }) => {
      const selection = getCurrentSelection()
      if (!selection?.text?.trim()) {
        window.toast?.warning?.(t('notes.comments.select_text_first'))
        return
      }
      openCommentComposer(selection, anchor)
    },
    [getCurrentSelection, openCommentComposer, t]
  )

  const submitCommentComposer = useCallback(async () => {
    if (!commentComposer.open) return
    const trimmed = commentComposer.draft.trim()
    if (!trimmed) return
    if (!notesPath) {
      window.toast?.warning?.(t('notes.chat.no_active_canvas'))
      return
    }

    let canvasId = activeCanvasId
    if (!canvasId && activeFilePathRef.current) {
      try {
        const resolved = await CanvasHistoryService.getCanvasId({
          notesPath,
          filePath: activeFilePathRef.current
        })
        canvasId = resolved.canvasId
        setActiveCanvasId(canvasId)
      } catch {
        canvasId = ''
      }
    }

    if (!canvasId) {
      window.toast?.warning?.(t('notes.chat.no_active_canvas'))
      return
    }

    try {
      if (
        commentComposer.source === 'code' &&
        typeof commentComposer.startOffset === 'number' &&
        typeof commentComposer.endOffset === 'number'
      ) {
        await CanvasCommentService.addCommentByOffsets({
          canvasId,
          markdownContent: getCurrentMarkdownContent(),
          startOffset: commentComposer.startOffset,
          endOffset: commentComposer.endOffset,
          comment: trimmed,
          type: 'none',
          createdBy: 'human'
        })
      } else if (
        commentComposer.source === 'rich' &&
        typeof commentComposer.startOffset === 'number' &&
        typeof commentComposer.endOffset === 'number'
      ) {
        const root = getCanvasEditorRoot()
        const renderedText = root ? linearizeRootText(root) : ''
        const anchor = CanvasCommentService.buildAnchorFromOffsets(
          renderedText,
          commentComposer.startOffset,
          commentComposer.endOffset
        )
        if (anchor) {
          await CanvasCommentService.addComment({
            canvasId,
            comment: trimmed,
            type: 'none',
            anchor,
            createdBy: 'human'
          })
        } else {
          await CanvasCommentService.addCommentByPattern({
            notesPath,
            canvasId,
            pattern: commentComposer.selectedText,
            comment: trimmed,
            type: 'none',
            createdBy: 'human'
          })
        }
      } else {
        await CanvasCommentService.addCommentByPattern({
          notesPath,
          canvasId,
          pattern: commentComposer.selectedText,
          comment: trimmed,
          type: 'none',
          createdBy: 'human'
        })
      }
      window.toast?.success?.(t('notes.comments.add_success'))
      closeCommentComposer()
      void refreshCommentHighlights(undefined, activeFilePathRef.current)
    } catch (error) {
      logger.error('Failed to add human canvas comment:', error as Error)
      window.toast?.error?.(t('notes.comments.add_failed'))
    }
  }, [
    activeCanvasId,
    closeCommentComposer,
    commentComposer,
    getCurrentMarkdownContent,
    notesPath,
    refreshCommentHighlights,
    t
  ])

  const closeInlinePrompt = useCallback(() => {
    setInlinePrompt((prev) => ({ ...prev, open: false, draft: '' }))
  }, [])

  const sendInlinePrompt = useCallback(async () => {
    if (!inlinePrompt.open) return
    const prompt = inlinePrompt.draft.trim()
    if (!prompt) return
    if (!activeCanvasId) {
      window.toast?.warning?.(t('notes.chat.no_active_canvas'))
      return
    }

    const selectionMeta =
      typeof inlinePrompt.startOffset === 'number' && typeof inlinePrompt.endOffset === 'number'
        ? `Selection offsets: ${inlinePrompt.startOffset}-${inlinePrompt.endOffset}\n`
        : ''

    const content = [
      'Selection context from canvas editor:',
      '```text',
      inlinePrompt.selectedText,
      '```',
      selectionMeta,
      prompt
    ]
      .filter(Boolean)
      .join('\n')

    await EventEmitter.emit(EVENT_NAMES.CANVAS_CHAT_SEND_PROMPT, {
      canvasId: activeCanvasId,
      content
    })
    closeInlinePrompt()
  }, [activeCanvasId, closeInlinePrompt, inlinePrompt, t])

  useEffect(() => {
    if (!inlinePrompt.open) return
    setTimeout(() => inlinePromptInputRef.current?.focus(), 0)
  }, [inlinePrompt.open])

  useEffect(() => {
    if (!commentComposer.open) return
    setTimeout(() => commentComposerInputRef.current?.focus(), 0)
  }, [commentComposer.open])

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (!activeFilePathRef.current) return
      const target = e.target as Node | null
      const element = target instanceof Element ? target : target?.parentElement
      if (!element) return

      const insideEditor = element.closest(
        '#notes-page .notes-rich-editor .ProseMirror, #notes-page .cm-editor, #notes-page .cm-content'
      )
      if (!insideEditor) return

      const selection = getCurrentSelection()
      if (!selection?.text?.trim()) {
        closeSelectionContextMenu()
        return
      }

      e.preventDefault()
      e.stopPropagation()
      setSelectionContextMenu({
        open: true,
        left: clamp(e.clientX, 10, window.innerWidth - 220),
        top: clamp(e.clientY, 10, window.innerHeight - 120),
        selection
      })
    }

    window.addEventListener('contextmenu', onContextMenu, true)
    return () => {
      window.removeEventListener('contextmenu', onContextMenu, true)
    }
  }, [closeSelectionContextMenu, getCurrentSelection])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!selectionContextMenu.open) return
      const target = e.target as Node | null
      if (selectionContextMenuRef.current && target && selectionContextMenuRef.current.contains(target)) {
        return
      }
      closeSelectionContextMenu()
    }

    const onWindowBlur = () => closeSelectionContextMenu()
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onWindowBlur)
    }
  }, [closeSelectionContextMenu, selectionContextMenu.open])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey
      const isModK = isMod && e.key.toLowerCase() === 'k'
      const isModShiftM = isMod && e.shiftKey && e.key.toLowerCase() === 'm'
      if (!isModK && !isModShiftM) return
      if (!activeFilePathRef.current) return

      const selection = getCurrentSelection()
      if (!selection?.text?.trim()) return

      e.preventDefault()
      e.stopPropagation()

      if (isModShiftM) {
        requestCommentComposerFromCurrentSelection()
        return
      }

      const margin = 10
      const left = selection.rect
        ? clamp(selection.rect.left, margin, window.innerWidth - 360 - margin)
        : clamp(window.innerWidth / 2 - 160, margin, window.innerWidth - 360 - margin)
      const top = selection.rect
        ? clamp(selection.rect.bottom + 8, margin, window.innerHeight - 220 - margin)
        : clamp(window.innerHeight / 2 - 80, margin, window.innerHeight - 220 - margin)

      closeSelectionContextMenu()
      setInlinePrompt({
        open: true,
        left,
        top,
        selectedText: selection.text,
        startOffset: selection.startOffset,
        endOffset: selection.endOffset,
        draft: ''
      })

      if (!isCanvasChatOpen) {
        setIsCanvasChatOpen(true)
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [closeSelectionContextMenu, getCurrentSelection, isCanvasChatOpen, requestCommentComposerFromCurrentSelection])

  useEffect(() => {
    setInlinePrompt((prev) => (prev.open ? { ...prev, open: false, draft: '' } : prev))
    closeCommentComposer()
    closeSelectionContextMenu()
  }, [activeFilePath, closeCommentComposer, closeSelectionContextMenu])

  useEffect(() => {
    const unsubscribe = EventEmitter.on(EVENT_NAMES.OPEN_CANVAS, ({ filePath }: { filePath?: string }) => {
      if (!filePath) return
      dispatch(setActiveFilePath(filePath))
      invalidateFileContent(filePath)
    })
    return () => {
      unsubscribe()
    }
  }, [dispatch, invalidateFileContent])

  // Listen for external requests to locate a specific line in a note
  useEffect(() => {
    const handleLocateNoteLine = ({
      noteId,
      lineNumber,
      lineContent
    }: {
      noteId: string
      lineNumber: number
      lineContent?: string
    }) => {
      const targetNode = findNode(notesTree, noteId)

      if (!targetNode || targetNode.type !== 'file') {
        logger.warn('Target note not found or not a file', { noteId })
        return
      }

      const needsSwitchFile = targetNode.externalPath !== activeFilePath

      if (needsSwitchFile) {
        // switch to target note first then scroll to line
        pendingScrollRef.current = { lineNumber, lineContent }
        dispatch(setActiveFilePath(targetNode.externalPath))
        invalidateFileContent(targetNode.externalPath)
      } else {
        const richEditor = editorRef.current
        const codeEditor = codeEditorRef.current

        try {
          if (codeEditor?.scrollToLine) {
            codeEditor.scrollToLine(lineNumber, { highlight: true })
          } else if (richEditor?.scrollToLine) {
            richEditor.scrollToLine(lineNumber, { highlight: true, lineContent })
          }
        } catch (error) {
          logger.error('Failed to scroll to line:', error as Error)
        }
      }
    }

    const unsubscribe = EventEmitter.on(EVENT_NAMES.LOCATE_NOTE_LINE, handleLocateNoteLine)
    return () => {
      unsubscribe()
    }
  }, [activeNode?.id, activeFilePath, notesTree, dispatch, invalidateFileContent])

  useEffect(() => {
    void refreshCommentHighlights(currentMarkdownRef.current, activeFilePath)
  }, [activeFilePath, currentContent, refreshCommentHighlights])

  useEffect(() => {
    const unsubscribe = EventEmitter.on(EVENT_NAMES.CANVAS_COMMENTS_UPDATED, () => {
      void refreshCommentHighlights(currentMarkdownRef.current, activeFilePathRef.current)
    })
    return () => {
      unsubscribe()
    }
  }, [refreshCommentHighlights])

  useEffect(() => {
    refreshHighlightProjection()
    return () => {
      commentDomRangesRef.current = []
      clearCanvasCommentHighlights()
    }
  }, [currentContent, refreshHighlightProjection])

  useEffect(() => {
    const root = getCanvasEditorRoot()
    if (!root || commentHighlightRanges.length === 0) {
      setCommentHoverTooltip((prev) => (prev.open ? { ...prev, open: false } : prev))
      return
    }

    const onMouseMove = (e: MouseEvent) => {
      const x = e.clientX
      const y = e.clientY
      let hitContent: string | null = null

      for (const item of commentDomRangesRef.current) {
        const rects = Array.from(item.range.getClientRects())
        if (rects.some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)) {
          hitContent = item.content
          break
        }
      }

      if (!hitContent) {
        setCommentHoverTooltip((prev) => (prev.open ? { ...prev, open: false } : prev))
        return
      }

      setCommentHoverTooltip({
        open: true,
        left: clamp(x + 12, 10, window.innerWidth - 360),
        top: clamp(y + 12, 10, window.innerHeight - 120),
        content: hitContent
      })
    }

    const onMouseLeave = () => {
      setCommentHoverTooltip((prev) => (prev.open ? { ...prev, open: false } : prev))
    }

    root.addEventListener('mousemove', onMouseMove)
    root.addEventListener('mouseleave', onMouseLeave)
    return () => {
      root.removeEventListener('mousemove', onMouseMove)
      root.removeEventListener('mouseleave', onMouseLeave)
    }
  }, [commentHighlightRanges])

  // Ensure canvas edits produced by assistant tools are reflected immediately in the active editor.
  useEffect(() => {
    const unsubscribe = EventEmitter.on(EVENT_NAMES.CANVAS_VERSION_COMMITTED, ({ filePath }: { filePath?: string }) => {
      if (!filePath) return

      const activePath = activeFilePathRef.current
      if (!activePath) return

      const normalizedFilePath = normalizePathValue(filePath)
      if (normalizePathValue(activePath) !== normalizedFilePath) return

      invalidateFileContentRef.current?.(normalizedFilePath)
    })

    return () => {
      unsubscribe()
    }
  }, [])

  return (
    <Container id="notes-page">
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>{t('notes.title')}</NavbarCenter>
      </Navbar>
      <ContentContainer id="content-container">
        <AnimatePresence initial={false}>
          {showWorkspace && (
            <WorkspacePanel
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: workspaceWidth, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              style={{ overflow: 'hidden' }}>
              <NotesSidebar
                notesTree={notesTree}
                width={workspaceWidth}
                selectedFolderId={selectedFolderId}
                onSelectNode={handleSelectNode}
                onCreateFolder={handleCreateFolder}
                onCreateNote={handleCreateNote}
                onDeleteNode={handleDeleteNode}
                onRenameNode={handleRenameNode}
                onToggleExpanded={handleToggleExpanded}
                onToggleStar={handleToggleStar}
                onMoveNode={handleMoveNode}
                onSortNodes={handleSortNodes}
                onUploadFiles={handleUploadFiles}
              />
              <WorkspaceResizeHandle
                onPointerDown={(e) => {
                  workspaceResizingRef.current = {
                    startX: e.clientX,
                    startWidth: workspaceWidth,
                    pointerId: e.pointerId
                  }
                  try {
                    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
                  } catch {
                    // ignore
                  }
                  document.body.style.userSelect = 'none'
                }}
                onPointerMove={(e) => {
                  const state = workspaceResizingRef.current
                  if (!state || state.pointerId !== e.pointerId) return
                  const delta = e.clientX - state.startX
                  const next = Math.max(220, Math.min(420, state.startWidth + delta))
                  setWorkspaceWidth(next)
                }}
                onPointerUp={(e) => {
                  const state = workspaceResizingRef.current
                  if (!state || state.pointerId !== e.pointerId) return
                  workspaceResizingRef.current = null
                  document.body.style.userSelect = ''
                  try {
                    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
                  } catch {
                    // ignore
                  }
                }}
                onPointerCancel={(e) => {
                  const state = workspaceResizingRef.current
                  if (!state || state.pointerId !== e.pointerId) return
                  workspaceResizingRef.current = null
                  document.body.style.userSelect = ''
                  try {
                    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
                  } catch {
                    // ignore
                  }
                }}
              />
            </WorkspacePanel>
          )}
        </AnimatePresence>
        <EditorWrapper>
          <HeaderNavbar
            notesTree={notesTree}
            getCurrentNoteContent={getCurrentNoteContent}
            onToggleStar={handleToggleStar}
            onExpandPath={handleExpandPath}
            onRenameNode={handleRenameNode}
            isCanvasChatOpen={isCanvasChatOpen}
            onToggleCanvasChat={() => {
              setIsCanvasChatOpen((prev) => {
                const next = !prev
                if (!next && activeFilePath) {
                  closedForFileRef.current = activeFilePath
                } else {
                  closedForFileRef.current = null
                }
                return next
              })
            }}
          />
          <NotesEditor
            activeNodeId={activeNode?.id}
            currentContent={currentContent}
            tokenCount={tokenCount}
            onMarkdownChange={handleMarkdownChange}
            editorRef={editorRef}
            codeEditorRef={codeEditorRef}
          />
        </EditorWrapper>
        {notesPath && activeNode?.type === 'file' && activeFilePath && (
          <CanvasChatSidebar
            open={isCanvasChatOpen}
            notesPath={notesPath}
            filePath={activeFilePath}
            width={380}
            onRequestAddComment={() => requestCommentComposerFromCurrentSelection()}
            onClose={() => {
              setIsCanvasChatOpen(false)
              closedForFileRef.current = activeFilePath
            }}
          />
        )}
        {selectionContextMenu.open && selectionContextMenu.selection && (
          <SelectionContextMenuCard
            ref={selectionContextMenuRef}
            style={{ left: selectionContextMenu.left, top: selectionContextMenu.top }}>
            <SelectionContextMenuItem
              size="small"
              type="text"
              onClick={() => {
                if (!selectionContextMenu.selection) return
                openCommentComposer(selectionContextMenu.selection, {
                  left: selectionContextMenu.left,
                  top: selectionContextMenu.top
                })
              }}>
              {t('notes.comments.add')}
              <SelectionContextMenuHint>
                {navigator.platform.includes('Mac') ? '⌘⇧M' : 'Ctrl+Shift+M'}
              </SelectionContextMenuHint>
            </SelectionContextMenuItem>
          </SelectionContextMenuCard>
        )}
        {commentComposer.open && (
          <InlinePromptCard style={{ left: commentComposer.left, top: commentComposer.top }}>
            <InlinePromptTitle>{t('notes.comments.add')}</InlinePromptTitle>
            <InlinePromptSelection title={commentComposer.selectedText}>
              {commentComposer.selectedText}
            </InlinePromptSelection>
            <Input.TextArea
              ref={commentComposerInputRef}
              value={commentComposer.draft}
              autoSize={{ minRows: 2, maxRows: 6 }}
              placeholder={t('notes.comments.add_prompt')}
              onChange={(e) => {
                const value = e.target.value
                setCommentComposer((prev) => ({ ...prev, draft: value }))
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  closeCommentComposer()
                  return
                }
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void submitCommentComposer()
                }
              }}
            />
            <InlinePromptActions>
              <Button size="small" onClick={closeCommentComposer}>
                {t('common.cancel')}
              </Button>
              <Button
                size="small"
                type="primary"
                disabled={!commentComposer.draft.trim()}
                onClick={() => void submitCommentComposer()}>
                {t('common.save')}
              </Button>
            </InlinePromptActions>
          </InlinePromptCard>
        )}
        {inlinePrompt.open && (
          <InlinePromptCard style={{ left: inlinePrompt.left, top: inlinePrompt.top }}>
            <InlinePromptTitle>{t('notes.inline_prompt.title')}</InlinePromptTitle>
            <InlinePromptSelection title={inlinePrompt.selectedText}>{inlinePrompt.selectedText}</InlinePromptSelection>
            <Input.TextArea
              ref={inlinePromptInputRef}
              value={inlinePrompt.draft}
              autoSize={{ minRows: 2, maxRows: 6 }}
              placeholder={t('notes.inline_prompt.placeholder')}
              onChange={(e) => {
                const value = e.target.value
                setInlinePrompt((prev) => ({ ...prev, draft: value }))
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  closeInlinePrompt()
                  return
                }
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  void sendInlinePrompt()
                }
              }}
            />
            <InlinePromptActions>
              <Button size="small" onClick={closeInlinePrompt}>
                {t('common.cancel')}
              </Button>
              <Button
                size="small"
                type="primary"
                disabled={!inlinePrompt.draft.trim()}
                onClick={() => void sendInlinePrompt()}>
                {t('common.send')}
              </Button>
            </InlinePromptActions>
          </InlinePromptCard>
        )}
        {commentHoverTooltip.open && (
          <CommentHoverTooltip style={{ left: commentHoverTooltip.left, top: commentHoverTooltip.top }}>
            {commentHoverTooltip.content}
          </CommentHoverTooltip>
        )}
      </ContentContainer>
    </Container>
  )
}

const Container = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;

  [navbar-position='left'] & {
    max-width: calc(100vw - var(--sidebar-width));
  }

  [navbar-position='top'] & {
    max-width: 100vw;
  }
`

const ContentContainer = styled.div`
  display: flex;
  flex: 1;
  flex-direction: row;
  min-height: 0;
  min-width: 0;
  width: 100%;
  overflow: hidden;
`

const EditorWrapper = styled.div`
  display: flex;
  position: relative;
  flex-direction: column;
  justify-content: space-between;
  flex: 1 1 auto;
  overflow: hidden;
  min-height: 0;
  min-width: 0;
`

const WorkspacePanel = styled(motion.div)`
  position: relative;
  flex: 0 0 auto;
`

const WorkspaceResizeHandle = styled.div`
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 8px;
  cursor: col-resize;
  z-index: 10;
  touch-action: none;
`

const InlinePromptCard = styled.div`
  position: fixed;
  z-index: 9998;
  width: 340px;
  border: 1px solid var(--color-border-soft);
  border-radius: 10px;
  background: var(--color-background);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.14);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const InlinePromptTitle = styled.div`
  font-weight: 600;
  color: var(--color-text);
`

const InlinePromptSelection = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
  background: var(--color-background-soft);
  border-radius: 8px;
  padding: 8px;
  max-height: 70px;
  overflow: hidden;
  text-overflow: ellipsis;
`

const InlinePromptActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
`

const SelectionContextMenuCard = styled.div`
  position: fixed;
  z-index: 9999;
  min-width: 180px;
  border: 1px solid var(--color-border-soft);
  border-radius: 10px;
  background: var(--color-background);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.14);
  padding: 4px;
`

const SelectionContextMenuItem = styled(Button)`
  width: 100%;
  justify-content: space-between;
  display: inline-flex;
  align-items: center;
  gap: 12px;
`

const SelectionContextMenuHint = styled.span`
  color: var(--color-text-3);
  font-size: 11px;
`

const CommentHoverTooltip = styled.div`
  position: fixed;
  z-index: 9997;
  max-width: 320px;
  pointer-events: none;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--color-border-soft);
  background: var(--color-background);
  color: var(--color-text);
  font-size: 12px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  white-space: pre-wrap;
`

export default NotesPage
