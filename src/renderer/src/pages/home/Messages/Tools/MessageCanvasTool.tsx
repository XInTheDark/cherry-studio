import type {
  CanvasAddCommentToolOutput,
  CanvasAppendToolOutput,
  CanvasCreateToolOutput,
  CanvasListToolOutput,
  CanvasReadToolOutput,
  CanvasReplaceToolOutput
} from '@renderer/aiCore/tools/CanvasTools'
import Spinner from '@renderer/components/Spinner'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { useAppDispatch } from '@renderer/store'
import { setActiveFilePath } from '@renderer/store/note'
import type { NormalToolResponse } from '@renderer/types'
import { Button, Collapse, Typography } from 'antd'
import { FileText } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import styled from 'styled-components'

const { Text } = Typography

function renderDiffPatch(patch: string) {
  const lines = patch.split('\n')
  return (
    <DiffBlock>
      {lines.map((line, idx) => {
        const isHeader = line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ')
        const isHunk = line.startsWith('@@')
        const isAdd = line.startsWith('+') && !line.startsWith('+++')
        const isDel = line.startsWith('-') && !line.startsWith('---')
        const color = isHeader
          ? 'var(--color-text-3)'
          : isHunk
            ? 'var(--color-primary)'
            : isAdd
              ? 'var(--color-status-success)'
              : isDel
                ? 'var(--color-status-error)'
                : 'var(--color-text)'
        return (
          <div key={idx} style={{ color, whiteSpace: 'pre' }}>
            {line}
          </div>
        )
      })}
    </DiffBlock>
  )
}

export const MessageCanvasTool = ({ toolResponse }: { toolResponse: NormalToolResponse }) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const name = toolResponse.tool.name
  const shortName = name.startsWith('builtin_') ? name.slice('builtin_'.length) : name

  const title = useMemo(() => {
    switch (shortName) {
      case 'canvas_read':
        return t('message.canvas.read', 'Canvas: Read')
      case 'canvas_list':
        return t('message.canvas.list', 'Canvas: List')
      case 'canvas_create':
        return t('message.canvas.create', 'Canvas: Create')
      case 'canvas_replace':
        return t('message.canvas.replace', 'Canvas: Replace')
      case 'canvas_append':
        return t('message.canvas.append', 'Canvas: Append')
      case 'canvas_add_comment':
        return t('message.canvas.add_comment', 'Canvas: Add Comment')
      default:
        return t('message.canvas.title', 'Canvas')
    }
  }, [shortName, t])

  if (toolResponse.status !== 'done') {
    return (
      <Spinner
        text={
          <PrepareToolWrapper>
            <FileText size={16} style={{ color: 'unset' }} />
            <span>{title}</span>
          </PrepareToolWrapper>
        }
      />
    )
  }

  // Tool outputs are loosely typed at runtime; we keep a small set of known fields.
  const output = toolResponse.response as
    | CanvasReadToolOutput
    | CanvasListToolOutput
    | CanvasCreateToolOutput
    | CanvasReplaceToolOutput
    | CanvasAppendToolOutput
    | CanvasAddCommentToolOutput
    | any

  const filePath: string | undefined = output?.filePath
  const relPath: string | undefined = output?.relPath
  const changed: boolean | undefined = output?.changed
  const diffPatch: string | undefined = output?.diffPatch
  const versionId: string | null | undefined = output?.versionId
  const isCreateTool = shortName === 'canvas_create'
  const createPreview: string | undefined = output?.preview
  const createTitle: string | undefined = output?.title
  const createOpenFilePath: string | undefined = output?.openAction?.filePath || output?.filePath

  const subtitle = relPath || filePath || ''

  const hasDetails = Boolean(diffPatch) || Boolean(output?.canvases) || Boolean(output?.content) || Boolean(versionId)

  const openCanvas = () => {
    if (!createOpenFilePath) return
    dispatch(setActiveFilePath(createOpenFilePath))
    navigate('/notes')
    void EventEmitter.emit(EVENT_NAMES.OPEN_CANVAS, {
      filePath: createOpenFilePath,
      canvasId: output?.canvasId
    })
  }

  return (
    <Container>
      <TitleRow>
        <FileText size={16} style={{ color: 'unset' }} />
        <Text type="secondary">
          {title}
          {subtitle ? ` · ${subtitle}` : ''}
          {typeof changed === 'boolean'
            ? ` · ${changed ? t('message.canvas.changed', 'updated') : t('message.canvas.no_change', 'no change')}`
            : ''}
        </Text>
      </TitleRow>

      {isCreateTool && createOpenFilePath && (
        <CreateCard>
          <CreateCardTitle>{createTitle || relPath || t('message.canvas.canvas', 'Canvas')}</CreateCardTitle>
          {createPreview ? <CreateCardPreview>{createPreview}</CreateCardPreview> : null}
          <Button size="small" type="primary" onClick={openCanvas}>
            {t('message.canvas.open', 'Open Canvas')}
          </Button>
        </CreateCard>
      )}

      {hasDetails && (
        <Collapse
          size="small"
          ghost
          items={[
            {
              key: 'details',
              label: t('message.canvas.details', 'Details'),
              children: (
                <div>
                  {diffPatch ? renderDiffPatch(diffPatch) : null}
                  {!diffPatch && output?.canvases ? (
                    <PreBlock>{JSON.stringify({ count: output.count, canvases: output.canvases }, null, 2)}</PreBlock>
                  ) : null}
                  {!diffPatch && output?.content ? <PreBlock>{output.content}</PreBlock> : null}
                  {versionId ? (
                    <Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                      versionId: {versionId}
                    </Text>
                  ) : null}
                </div>
              )
            }
          ]}
        />
      )}
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 0;
`

const TitleRow = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
`

const PrepareToolWrapper = styled.span`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  padding: 5px;
  padding-left: 0;
`

const PreBlock = styled.pre`
  margin: 0;
  padding: 8px;
  border-radius: 8px;
  background: var(--color-background-mute);
  overflow: auto;
  max-height: 240px;
  font-size: 12px;
`

const DiffBlock = styled.div`
  margin: 0;
  padding: 8px;
  border-radius: 8px;
  background: var(--color-background-mute);
  overflow: auto;
  max-height: 240px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
`

const CreateCard = styled.div`
  border: 1px solid var(--color-border-soft);
  border-radius: 10px;
  background: var(--color-background-soft);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const CreateCardTitle = styled.div`
  font-weight: 600;
  color: var(--color-text);
`

const CreateCardPreview = styled.div`
  font-size: 12px;
  color: var(--color-text-2);
  white-space: pre-wrap;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
`
