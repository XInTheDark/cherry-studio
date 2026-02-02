import { loggerService } from '@logger'
import { useTrash } from '@renderer/hooks/useTrash'
import type { RootState } from '@renderer/store'
import { useAppSelector } from '@renderer/store'
import type { TrashedTopic } from '@renderer/types'
import { Button, Drawer, Empty, Flex, Popconfirm } from 'antd'
import dayjs from 'dayjs'
import { Trash2 } from 'lucide-react'
import type { FC } from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const logger = loggerService.withContext('TrashDrawer')

type Props = {
  open: boolean
  onClose: () => void
  placement?: 'left' | 'right'
}

const TrashDrawer: FC<Props> = ({ open, onClose, placement = 'left' }) => {
  const { t } = useTranslation()
  const { trashedTopics, restoreFromTrash, deletePermanently, emptyTrash } = useTrash()
  const assistants = useAppSelector((state: RootState) => state.assistants.assistants)

  const assistantNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of assistants) {
      map.set(a.id, a.name)
    }
    return map
  }, [assistants])

  const title = (
    <Flex align="center" gap={8}>
      <Trash2 size={16} />
      {t('chat.trash.title')}
      {trashedTopics.length > 0 ? <CountBadge>{trashedTopics.length}</CountBadge> : null}
    </Flex>
  )

  const extra =
    trashedTopics.length > 0 ? (
      <Popconfirm
        title={t('chat.trash.empty.confirm.title')}
        description={t('chat.trash.empty.confirm.content', { count: trashedTopics.length })}
        okButtonProps={{ danger: true }}
        onConfirm={async () => {
          try {
            await emptyTrash()
          } catch (error) {
            logger.error('Failed to empty trash:', error as Error)
          }
        }}>
        <Button size="small" danger type="text">
          {t('chat.trash.empty.action')}
        </Button>
      </Popconfirm>
    ) : null

  return (
    <Drawer
      title={title}
      open={open}
      onClose={onClose}
      placement={placement}
      width="var(--assistants-width)"
      closeIcon={null}
      extra={extra}
      styles={{ body: { padding: 12, overflow: 'auto' } }}>
      {trashedTopics.length === 0 ? (
        <Empty description={t('chat.trash.empty.state')} />
      ) : (
        <TrashList>
          {trashedTopics.map((item: TrashedTopic) => {
            const assistantName = assistantNameById.get(item.assistantId) || t('chat.trash.unknown_assistant')
            const trashedAt = dayjs(item.trashedAt).format('MM/DD HH:mm')

            return (
              <TrashItem key={item.id}>
                <TrashItemMain>
                  <TrashItemTitle title={item.topic.name}>{item.topic.name}</TrashItemTitle>
                  <TrashItemMeta title={`${assistantName} · ${trashedAt}`}>
                    {assistantName} · {trashedAt}
                  </TrashItemMeta>
                </TrashItemMain>
                <TrashItemActions>
                  <Button size="small" type="primary" onClick={() => void restoreFromTrash(item.id)}>
                    {t('chat.trash.restore.action')}
                  </Button>
                  <Popconfirm
                    title={t('chat.trash.delete.confirm.title')}
                    description={t('chat.trash.delete.confirm.content')}
                    okButtonProps={{ danger: true }}
                    onConfirm={() => deletePermanently(item.id)}>
                    <Button size="small" danger type="text">
                      {t('chat.trash.delete.action')}
                    </Button>
                  </Popconfirm>
                </TrashItemActions>
              </TrashItem>
            )
          })}
        </TrashList>
      )}
    </Drawer>
  )
}

const CountBadge = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 18px;
  color: var(--color-text-2);
  background: var(--color-fill-2);
`

const TrashList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
`

const TrashItem = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px;
  border-radius: 10px;
  background: var(--color-background-soft);
`

const TrashItemMain = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
`

const TrashItemTitle = styled.div`
  font-size: 13px;
  color: var(--color-text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 240px;
`

const TrashItemMeta = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 240px;
`

const TrashItemActions = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
`

export default TrashDrawer
