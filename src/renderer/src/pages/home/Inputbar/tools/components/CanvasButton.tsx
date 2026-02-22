import { ActionIconButton } from '@renderer/components/Buttons'
import type { QuickPanelCallBackOptions, QuickPanelListItem } from '@renderer/components/QuickPanel'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useTimer } from '@renderer/hooks/useTimer'
import type { ToolQuickPanelController } from '@renderer/pages/home/Inputbar/types'
import CanvasHistoryService from '@renderer/services/CanvasHistoryService'
import { useAppSelector } from '@renderer/store'
import { Tooltip } from 'antd'
import { FileText, PenSquare } from 'lucide-react'
import type { FC } from 'react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  assistantId: string
  quickPanelController: ToolQuickPanelController
}

type CanvasPanelState = {
  enabled: boolean
  mode: 'automatic' | 'specific'
  ids: string[]
}

type RecentCanvasItem = {
  canvasId: string
  relPath: string
  createdAt: string
  updatedAt: string
}

const CANVAS_QUICK_PANEL_SYMBOL = 'canvas-tool'

/**
 * Canvas tools selector for normal chats.
 *
 * Clicking the button opens a quick panel with:
 * - Automatic (existing behavior)
 * - Recently used canvases for explicit selection
 */
const CanvasButton: FC<Props> = ({ assistantId, quickPanelController }) => {
  const { t } = useTranslation()
  const { assistant, updateAssistant } = useAssistant(assistantId)
  const { setTimeoutTimer } = useTimer()
  const notesPath = useAppSelector((state) => state.note.notesPath)
  const [loadingRecent, setLoadingRecent] = useState(false)
  const assistantRef = useRef(assistant)

  useEffect(() => {
    assistantRef.current = assistant
  }, [assistant])

  const getCurrentPanelState = useCallback((): CanvasPanelState => {
    const current = assistantRef.current
    const ids = Array.isArray(current.canvasToolSelectedCanvasIds)
      ? current.canvasToolSelectedCanvasIds.filter(Boolean)
      : []
    const mode = current.canvasToolMode === 'specific' ? 'specific' : 'automatic'
    const enabled = Boolean(current.enableCanvas)
    return { enabled, mode, ids }
  }, [])

  const persistPanelState = useCallback(
    (next: CanvasPanelState) => {
      setTimeoutTimer(
        'toggleCanvasTools',
        () => {
          const latest = assistantRef.current
          updateAssistant({
            ...latest,
            enableCanvas: next.enabled,
            canvasToolMode: next.mode,
            canvasToolSelectedCanvasIds: next.ids
          })
        },
        60
      )
    },
    [setTimeoutTimer, updateAssistant]
  )

  const buildPanelItems = useCallback(
    (recentCanvases: RecentCanvasItem[], state: CanvasPanelState): QuickPanelListItem[] => {
      const selectedSet = new Set(state.ids)
      const automaticSelected = state.enabled && state.mode === 'automatic'

      const buildNextList = (nextState: CanvasPanelState, context?: QuickPanelCallBackOptions['context']) => {
        context?.updateList(buildPanelItems(recentCanvases, nextState))
      }

      const items: QuickPanelListItem[] = [
        {
          label: t('chat.input.canvas.automatic', 'Automatic'),
          description: t(
            'chat.input.canvas.automatic_desc',
            'Use current chat mapping and active canvas automatically.'
          ),
          icon: <PenSquare size={14} />,
          isSelected: automaticSelected,
          alwaysVisible: true,
          action: (options) => {
            const nextState: CanvasPanelState = automaticSelected
              ? { enabled: false, mode: 'automatic', ids: [] }
              : { enabled: true, mode: 'automatic', ids: [] }
            persistPanelState(nextState)
            buildNextList(nextState, options?.context)
          }
        }
      ]

      if (recentCanvases.length === 0) {
        items.push({
          label: t('notes.empty', 'No canvases found'),
          description: t('notes.chat.no_active_canvas', 'Select a canvas to open chat'),
          icon: <FileText size={14} />,
          disabled: true
        })
        return items
      }

      for (const canvas of recentCanvases) {
        const isSelected = state.enabled && state.mode === 'specific' && selectedSet.has(canvas.canvasId)
        items.push({
          label: canvas.relPath,
          description: canvas.canvasId,
          filterText: `${canvas.relPath} ${canvas.canvasId}`,
          icon: <FileText size={14} />,
          isSelected,
          action: (options) => {
            const nextIds = isSelected
              ? state.ids.filter((id) => id !== canvas.canvasId)
              : [...state.ids, canvas.canvasId]
            const deduped = Array.from(new Set(nextIds))
            const nextState: CanvasPanelState =
              deduped.length > 0
                ? { enabled: true, mode: 'specific', ids: deduped }
                : { enabled: false, mode: 'automatic', ids: [] }
            persistPanelState(nextState)
            buildNextList(nextState, options?.context)
          }
        })
      }

      return items
    },
    [persistPanelState, t]
  )

  const openQuickPanel = useCallback(async () => {
    const currentState = getCurrentPanelState()
    setLoadingRecent(true)
    try {
      const recentCanvases = notesPath
        ? await CanvasHistoryService.listCanvases({
            notesPath,
            limit: 30
          })
        : []

      quickPanelController.open({
        title: t('chat.input.canvas.label'),
        symbol: CANVAS_QUICK_PANEL_SYMBOL,
        list: buildPanelItems(recentCanvases, currentState),
        pageSize: 12,
        multiple: true
      })
    } catch {
      window.toast?.error?.(t('common.errors.validation'))
    } finally {
      setLoadingRecent(false)
    }
  }, [buildPanelItems, getCurrentPanelState, notesPath, quickPanelController, t])

  const handleOpenSelector = useCallback(() => {
    if (quickPanelController.isVisible && quickPanelController.symbol === CANVAS_QUICK_PANEL_SYMBOL) {
      quickPanelController.close()
      return
    }
    void openQuickPanel()
  }, [openQuickPanel, quickPanelController])

  const isActive =
    Boolean(assistant.enableCanvas) ||
    (assistant.canvasToolMode === 'specific' && (assistant.canvasToolSelectedCanvasIds?.length || 0) > 0)
  const ariaLabel = t('chat.input.canvas.label')

  return (
    <Tooltip placement="top" title={ariaLabel} arrow>
      <ActionIconButton
        onClick={handleOpenSelector}
        active={isActive}
        loading={loadingRecent}
        aria-label={ariaLabel}
        aria-pressed={isActive}>
        <PenSquare size={18} />
      </ActionIconButton>
    </Tooltip>
  )
}

export default memo(CanvasButton)
