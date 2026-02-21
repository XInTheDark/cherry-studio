import { loggerService } from '@logger'
import CanvasHistoryService, { type CanvasVersionEntryV1 } from '@renderer/services/CanvasHistoryService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { normalizePathValue } from '@renderer/services/NotesTreeService'
import { Button, Checkbox, Empty, Input, List, Modal, Space, Tag, Typography } from 'antd'
import dayjs from 'dayjs'
import { createTwoFilesPatch } from 'diff'
import type { FC } from 'react'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('CanvasHistoryPanel')

type Props = {
  notesPath: string
  filePath: string
}

const CanvasHistoryPanel: FC<Props> = ({ notesPath, filePath }) => {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [canvasId, setCanvasId] = useState<string>('')
  const [versions, setVersions] = useState<CanvasVersionEntryV1[]>([])
  const [selectedVersionIds, setSelectedVersionIds] = useState<string[]>([])
  const [diffText, setDiffText] = useState<string>('')
  const [diffLoading, setDiffLoading] = useState(false)
  const [editingVersionId, setEditingVersionId] = useState<string | null>(null)
  const [editingNameValue, setEditingNameValue] = useState<string>('')

  const isCompareOpen = selectedVersionIds.length > 0

  const loadVersions = useCallback(async () => {
    if (!notesPath || !filePath) return

    setLoading(true)
    try {
      const result = await CanvasHistoryService.listVersions({ notesPath, filePath })
      setCanvasId(result.canvasId)
      setVersions(result.versions ?? [])
    } catch (error) {
      logger.error('Failed to load canvas history:', error as Error)
      window.toast?.error?.(t('notes.history.load_failed'))
    } finally {
      setLoading(false)
    }
  }, [filePath, notesPath, t])

  useEffect(() => {
    void loadVersions()
  }, [loadVersions])

  useEffect(() => {
    const normalizedNotesPath = normalizePathValue(notesPath)
    const normalizedFilePath = normalizePathValue(filePath)
    const unsubscribe = EventEmitter.on(
      EVENT_NAMES.CANVAS_VERSION_COMMITTED,
      ({ notesPath: changedNotesPath, filePath: changedFilePath }: { notesPath?: string; filePath?: string }) => {
        if (!changedFilePath) return
        if (changedNotesPath && normalizePathValue(changedNotesPath) !== normalizedNotesPath) return
        if (normalizePathValue(changedFilePath) !== normalizedFilePath) return
        void loadVersions()
      }
    )

    return () => {
      unsubscribe()
    }
  }, [filePath, loadVersions, notesPath])

  const sorted = useMemo(() => {
    // Latest first.
    return [...versions].reverse()
  }, [versions])

  const versionsById = useMemo(() => {
    return new Map(versions.map((v) => [v.id, v]))
  }, [versions])

  const selectedVersions = useMemo(() => {
    return selectedVersionIds.map((id) => versionsById.get(id)).filter(Boolean) as CanvasVersionEntryV1[]
  }, [selectedVersionIds, versionsById])

  const getActorTag = useCallback(
    (actor: CanvasVersionEntryV1['actor']) => {
      switch (actor) {
        case 'assistant':
          return <Tag color="blue">{t('notes.history.actor.assistant')}</Tag>
        case 'system':
          return <Tag>{t('notes.history.actor.system')}</Tag>
        case 'human':
        default:
          return <Tag color="gold">{t('notes.history.actor.human')}</Tag>
      }
    },
    [t]
  )

  const getVersionTimestamp = useCallback((v: CanvasVersionEntryV1): string => {
    return dayjs(v.createdAt).format('YYYY-MM-DD HH:mm:ss')
  }, [])

  const getVersionTitle = useCallback(
    (v: CanvasVersionEntryV1): string => {
      const name = v.name?.trim()
      return name || getVersionTimestamp(v)
    },
    [getVersionTimestamp]
  )

  const getDiffLabel = useCallback(
    (v: CanvasVersionEntryV1): string => {
      const ts = getVersionTimestamp(v)
      const name = v.name?.trim()
      return name ? `${name} (${ts})` : ts
    },
    [getVersionTimestamp]
  )

  const toggleSelectedVersionId = useCallback((versionId: string) => {
    setSelectedVersionIds((prev) => {
      if (prev.includes(versionId)) {
        return prev.filter((id) => id !== versionId)
      }
      if (prev.length < 2) {
        return [...prev, versionId]
      }
      // Keep this as a "sliding window": last two selected versions.
      return [prev[1], versionId]
    })
  }, [])

  const clearSelectedVersions = useCallback(() => {
    setSelectedVersionIds([])
  }, [])

  const cancelEditing = useCallback(() => {
    setEditingVersionId(null)
    setEditingNameValue('')
  }, [])

  const startEditing = useCallback(
    (v: CanvasVersionEntryV1) => {
      setEditingVersionId(v.id)
      setEditingNameValue(getVersionTitle(v))
    },
    [getVersionTitle]
  )

  const commitEditing = useCallback(
    async (versionId: string, nextName: string) => {
      try {
        await CanvasHistoryService.renameVersion({ notesPath, filePath, versionId, name: nextName })
        const trimmed = nextName.trim()
        setVersions((prev) => prev.map((v) => (v.id === versionId ? { ...v, name: trimmed ? trimmed : undefined } : v)))
        cancelEditing()
      } catch (error) {
        logger.error('Failed to rename canvas history version:', error as Error)
        window.toast?.error?.(t('notes.history.rename_failed'))
      }
    },
    [cancelEditing, filePath, notesPath, t]
  )

  useEffect(() => {
    let cancelled = false

    if (selectedVersionIds.length !== 2) {
      setDiffLoading(false)
      setDiffText('')
      return
    }

    const [leftId, rightId] = selectedVersionIds
    const leftMeta = versionsById.get(leftId)
    const rightMeta = versionsById.get(rightId)

    const leftLabel = leftMeta ? getDiffLabel(leftMeta) : leftId
    const rightLabel = rightMeta ? getDiffLabel(rightMeta) : rightId

    setDiffLoading(true)
    setDiffText('')

    Promise.all([
      CanvasHistoryService.readVersionContent({ notesPath, filePath, versionId: leftId }),
      CanvasHistoryService.readVersionContent({ notesPath, filePath, versionId: rightId })
    ])
      .then(([left, right]) => {
        if (cancelled) return
        const patch = createTwoFilesPatch(leftLabel, rightLabel, left.content, right.content, '', '', { context: 3 })
        setDiffText(patch)
      })
      .catch((error) => {
        logger.error('Failed to compute history diff:', error as Error)
        window.toast?.error?.(t('notes.history.diff_failed'))
      })
      .finally(() => {
        if (cancelled) return
        setDiffLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [filePath, getDiffLabel, notesPath, selectedVersionIds, t, versionsById])

  const handleRestore = useCallback(
    async (versionId: string) => {
      Modal.confirm({
        title: t('notes.history.restore_confirm.title'),
        content: t('notes.history.restore_confirm.content'),
        okText: t('notes.history.restore'),
        okButtonProps: { danger: true },
        cancelText: t('common.cancel'),
        onOk: async () => {
          try {
            await CanvasHistoryService.restoreVersion({ notesPath, filePath, versionId })
            window.toast?.success?.(t('notes.history.restore_success'))
            await loadVersions()
          } catch (error) {
            logger.error('Failed to restore version:', error as Error)
            window.toast?.error?.(t('notes.history.restore_failed'))
          }
        }
      })
    },
    [filePath, loadVersions, notesPath, t]
  )

  if (!loading && sorted.length === 0) {
    return <Empty description={t('notes.history.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
  }

  const renderDiff = () => {
    if (selectedVersionIds.length !== 2) {
      return (
        <Typography.Text type="secondary" style={{ display: 'block' }}>
          {t('notes.history.compare_hint')}
        </Typography.Text>
      )
    }

    if (diffLoading) {
      return (
        <Typography.Text type="secondary" style={{ display: 'block' }}>
          {t('common.loading')}
        </Typography.Text>
      )
    }

    if (!diffText) {
      return (
        <Typography.Text type="secondary" style={{ display: 'block' }}>
          {t('notes.history.diff_empty')}
        </Typography.Text>
      )
    }

    const lines = diffText.split('\n')
    return (
      <div
        style={{
          border: '1px solid var(--color-border)',
          borderRadius: 8,
          padding: 10,
          background: 'var(--color-background-mute)',
          maxHeight: 420,
          overflow: 'auto'
        }}>
        <pre style={{ margin: 0, whiteSpace: 'pre', fontFamily: 'var(--font-mono)' }}>
          <code>
            {lines.map((line, idx) => {
              const isHeader = line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ')
              const isHunk = line.startsWith('@@')
              const isAdd = line.startsWith('+') && !line.startsWith('+++')
              const isRemove = line.startsWith('-') && !line.startsWith('---')

              let color = 'var(--color-text)'
              if (isHeader) color = 'var(--color-text-3)'
              else if (isHunk) color = 'var(--color-primary)'
              else if (isAdd) color = 'var(--color-status-success)'
              else if (isRemove) color = 'var(--color-status-error)'

              return (
                <span key={idx} style={{ display: 'block', color }}>
                  {line}
                </span>
              )
            })}
          </code>
        </pre>
      </div>
    )
  }

  return (
    <div style={{ padding: 12 }}>
      <Space direction="vertical" style={{ width: '100%' }} size={10}>
        <Typography.Text type="secondary">
          {t('notes.history.canvas_id')}: {canvasId || '-'}
        </Typography.Text>
        <div style={{ display: 'flex', gap: 12, minWidth: 0 }}>
          <div
            style={{
              flex: isCompareOpen ? '0 0 330px' : '1 1 auto',
              minWidth: 0,
              transition: 'flex-basis 0.15s ease-in-out'
            }}>
            <List
              loading={loading}
              dataSource={sorted}
              renderItem={(v) => {
                const hasCustomName = Boolean(v.name?.trim())
                return (
                  <List.Item
                    actions={[
                      <Button key="restore" danger size="small" onClick={() => void handleRestore(v.id)}>
                        {t('notes.history.restore')}
                      </Button>
                    ]}>
                    <List.Item.Meta
                      title={
                        <Space size={8} wrap>
                          <Checkbox
                            checked={selectedVersionIds.includes(v.id)}
                            onChange={() => toggleSelectedVersionId(v.id)}
                          />
                          {editingVersionId === v.id ? (
                            <Input
                              size="small"
                              value={editingNameValue}
                              onChange={(e) => setEditingNameValue(e.target.value)}
                              onBlur={() => void commitEditing(v.id, editingNameValue)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  void commitEditing(v.id, editingNameValue)
                                } else if (e.key === 'Escape') {
                                  e.preventDefault()
                                  cancelEditing()
                                }
                              }}
                              autoFocus
                              style={{ maxWidth: 220 }}
                            />
                          ) : (
                            <Typography.Text
                              onDoubleClick={() => startEditing(v)}
                              style={{ cursor: 'text', userSelect: 'text' }}>
                              {getVersionTitle(v)}
                            </Typography.Text>
                          )}
                          {getActorTag(v.actor)}
                        </Space>
                      }
                      description={
                        <Space direction="vertical" size={2} style={{ width: '100%' }}>
                          {hasCustomName && (
                            <Typography.Text type="secondary">{getVersionTimestamp(v)}</Typography.Text>
                          )}
                          {v.reason ? (
                            <Typography.Text>{v.reason}</Typography.Text>
                          ) : (
                            <Typography.Text type="secondary">{t('notes.history.reason.none')}</Typography.Text>
                          )}
                          {typeof v.gzipByteSize === 'number' && typeof v.byteSize === 'number' && (
                            <Typography.Text type="secondary">
                              {t('notes.history.size', { gzip: v.gzipByteSize, raw: v.byteSize })}
                            </Typography.Text>
                          )}
                        </Space>
                      }
                    />
                  </List.Item>
                )
              }}
            />
          </div>
          {isCompareOpen && (
            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
              <Space direction="vertical" style={{ width: '100%' }} size={6}>
                <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
                  <Typography.Text strong>{t('notes.history.compare')}</Typography.Text>
                  <Button size="small" onClick={clearSelectedVersions}>
                    {t('notes.history.compare_clear')}
                  </Button>
                </Space>
                {selectedVersions.length > 0 && (
                  <Space size={6} wrap>
                    {selectedVersions.map((v) => (
                      <Tag key={v.id} color="processing">
                        {getVersionTitle(v)}
                      </Tag>
                    ))}
                  </Space>
                )}
                {renderDiff()}
              </Space>
            </div>
          )}
        </div>
      </Space>
    </div>
  )
}

export default memo(CanvasHistoryPanel)
