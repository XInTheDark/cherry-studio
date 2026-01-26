import { loggerService } from '@logger'
import CanvasHistoryService, { type CanvasVersionEntryV1 } from '@renderer/services/CanvasHistoryService'
import { Button, Empty, List, Modal, Space, Tag, Typography } from 'antd'
import dayjs from 'dayjs'
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

  const sorted = useMemo(() => {
    // Latest first.
    return [...versions].reverse()
  }, [versions])

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

  return (
    <div style={{ padding: 12 }}>
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <Typography.Text type="secondary">
          {t('notes.history.canvas_id')}: {canvasId || '-'}
        </Typography.Text>
        <List
          loading={loading}
          dataSource={sorted}
          renderItem={(v) => (
            <List.Item
              actions={[
                <Button key="restore" danger size="small" onClick={() => void handleRestore(v.id)}>
                  {t('notes.history.restore')}
                </Button>
              ]}>
              <List.Item.Meta
                title={
                  <Space size={8} wrap>
                    <Typography.Text>{dayjs(v.createdAt).format('YYYY-MM-DD HH:mm:ss')}</Typography.Text>
                    {getActorTag(v.actor)}
                  </Space>
                }
                description={
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
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
          )}
        />
      </Space>
    </div>
  )
}

export default memo(CanvasHistoryPanel)
