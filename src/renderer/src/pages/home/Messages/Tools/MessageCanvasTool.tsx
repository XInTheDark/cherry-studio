import type {
  CanvasAppendToolOutput,
  CanvasCreateToolOutput,
  CanvasListToolOutput,
  CanvasReadToolOutput,
  CanvasReplaceToolOutput
} from '@renderer/aiCore/tools/CanvasTools'
import Spinner from '@renderer/components/Spinner'
import type { NormalToolResponse } from '@renderer/types'
import { Collapse, Typography } from 'antd'
import { FileText } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
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
    | any

  const filePath: string | undefined = output?.filePath
  const relPath: string | undefined = output?.relPath
  const changed: boolean | undefined = output?.changed
  const diffPatch: string | undefined = output?.diffPatch
  const versionId: string | null | undefined = output?.versionId

  const subtitle = relPath || filePath || ''

  const hasDetails = Boolean(diffPatch) || Boolean(output?.canvases) || Boolean(output?.content) || Boolean(versionId)

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
