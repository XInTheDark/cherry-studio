import { HStack, VStack } from '@renderer/components/Layout'
import MaxContextCount from '@renderer/components/MaxContextCount'
import type { ConversationCompactionState } from '@renderer/types'
import { Button, Collapse, Divider, Popover } from 'antd'
import { ArrowUp, MenuIcon, Package } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

type ContextTokens = {
  current: number
  max: number
  compaction?: {
    summaryTokens: number
    segments: number
    compactedMessageCount: number
    updatedAt: string
    state: ConversationCompactionState
  }
}

type Props = {
  estimateTokenCount: number
  inputTokenCount: number
  contextTokens: ContextTokens
  onCompactConversation?: () => void
  onClearCompaction?: () => void
  showEstimatedTokens?: boolean
} & React.HTMLAttributes<HTMLDivElement>

const TokenCount: FC<Props> = ({
  estimateTokenCount,
  inputTokenCount,
  contextTokens,
  onCompactConversation,
  onClearCompaction,
  showEstimatedTokens = true
}) => {
  const { t } = useTranslation()

  const compactionState = contextTokens.compaction?.state
  const hasCompaction = Boolean(compactionState)

  const popoverContent = (
    <VStack w="260px" background="100%">
      <HStack justifyContent="space-between" w="100%">
        <Text>{t('chat.input.context_count.tip')}</Text>
        <Text>
          <HStack style={{ alignItems: 'center' }}>
            {contextTokens.current}
            <SlashSeparatorSpan>/</SlashSeparatorSpan>
            <MaxContextCount maxContext={contextTokens.max} />
          </HStack>
        </Text>
      </HStack>
      <Divider style={{ margin: '5px 0' }} />
      {showEstimatedTokens && (
        <HStack justifyContent="space-between" w="100%">
          <Text>{t('chat.input.estimated_tokens.tip')}</Text>
          <Text>{estimateTokenCount}</Text>
        </HStack>
      )}

      <Divider style={{ margin: showEstimatedTokens ? '8px 0' : '5px 0' }} />
      <HStack justifyContent="space-between" w="100%" style={{ gap: 8 }}>
        <Button size="small" onClick={onCompactConversation}>
          {t('chat.input.compaction.compact_action')}
        </Button>
        <Button size="small" danger disabled={!hasCompaction} onClick={onClearCompaction}>
          {t('chat.input.compaction.clear_action')}
        </Button>
      </HStack>

      {hasCompaction && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          <VStack w="100%" style={{ gap: 4 }}>
            <HStack justifyContent="space-between" w="100%">
              <Text>{t('chat.input.compaction.segments')}</Text>
              <Text>{contextTokens.compaction?.segments}</Text>
            </HStack>
            <HStack justifyContent="space-between" w="100%">
              <Text>{t('chat.input.compaction.messages')}</Text>
              <Text>{contextTokens.compaction?.compactedMessageCount}</Text>
            </HStack>
            <HStack justifyContent="space-between" w="100%">
              <Text>{t('chat.input.compaction.summary_tokens')}</Text>
              <Text>{contextTokens.compaction?.summaryTokens}</Text>
            </HStack>
            <HStack justifyContent="space-between" w="100%">
              <Text>{t('chat.input.compaction.updated_at')}</Text>
              <Text>{new Date(contextTokens.compaction!.updatedAt).toLocaleString()}</Text>
            </HStack>
          </VStack>

          <DetailsCollapse
            size="small"
            items={[
              {
                key: 'compaction-details',
                label: t('chat.input.compaction.details'),
                children: (
                  <SegmentList>
                    {compactionState!.segments.map((segment, idx) => (
                      <SegmentCard key={segment.id}>
                        <SegmentTitle>
                          #{idx + 1} · {segment.messageCount} msg · {segment.summaryTokenEstimate} tok
                        </SegmentTitle>
                        <SegmentRange>
                          {segment.startMessageCreatedAt} → {segment.endMessageCreatedAt}
                        </SegmentRange>
                        <SegmentSummary>{segment.summary}</SegmentSummary>
                      </SegmentCard>
                    ))}
                  </SegmentList>
                )
              }
            ]}
          />
        </>
      )}
    </VStack>
  )

  return (
    <Container>
      <Popover content={popoverContent} arrow={false}>
        <HStack>
          <HStack style={{ alignItems: 'center' }}>
            <MenuIcon size={12} className="icon" />
            {contextTokens.current}
            <SlashSeparatorSpan>/</SlashSeparatorSpan>
            <MaxContextCount maxContext={contextTokens.max} />
          </HStack>
          {hasCompaction && (
            <CompactionBadge title={t('chat.input.compaction.badge_tip')}>
              <Package size={11} />
              {contextTokens.compaction?.segments}
            </CompactionBadge>
          )}
          {showEstimatedTokens && (
            <>
              <Divider type="vertical" style={{ marginTop: 3, marginLeft: 5, marginRight: 3 }} />
              <HStack style={{ alignItems: 'center' }}>
                <ArrowUp size={12} className="icon" />
                {inputTokenCount}
                <SlashSeparatorSpan>/</SlashSeparatorSpan>
                {estimateTokenCount}
              </HStack>
            </>
          )}
        </HStack>
      </Popover>
    </Container>
  )
}

const Container = styled.div`
  font-size: 11px;
  line-height: 16px;
  color: var(--color-text-2);
  z-index: 10;
  padding: 3px 10px;
  user-select: none;
  border-radius: 20px;
  display: flex;
  align-items: center;
  cursor: pointer;

  .icon {
    margin-right: 3px;
  }

  @media (max-width: 800px) {
    display: none;
  }
`

const DetailsCollapse = styled(Collapse)`
  width: 100%;
  margin-top: 8px;
`

const SegmentList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 220px;
  overflow: auto;
`

const SegmentCard = styled.div`
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 6px;
  background: var(--color-background-soft);
`

const SegmentTitle = styled.div`
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-1);
`

const SegmentRange = styled.div`
  font-size: 11px;
  color: var(--color-text-2);
  margin-top: 2px;
`

const SegmentSummary = styled.div`
  margin-top: 4px;
  white-space: pre-wrap;
  font-size: 11px;
  color: var(--color-text-1);
  max-height: 100px;
  overflow: auto;
`

const CompactionBadge = styled.span`
  margin-left: 6px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  padding: 1px 6px;
  font-size: 10px;
`

const Text = styled.div`
  font-size: 12px;
  color: var(--color-text-1);
`

const SlashSeparatorSpan = styled.span`
  margin-left: 2px;
  margin-right: 2px;
`

export default TokenCount
