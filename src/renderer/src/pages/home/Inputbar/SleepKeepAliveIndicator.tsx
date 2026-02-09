import { Tooltip } from 'antd'
import { MoonStar } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const SleepKeepAliveIndicator: FC = () => {
  const { t } = useTranslation()

  return (
    <Tooltip title={t('chat.input.sleep_keepalive_active.tip')} arrow>
      <Container aria-label={t('chat.input.sleep_keepalive_active.label')}>
        <MoonStar size={12} />
        {t('chat.input.sleep_keepalive_active.label')}
      </Container>
    </Tooltip>
  )
}

const Container = styled.div`
  font-size: 11px;
  line-height: 16px;
  color: var(--color-primary);
  user-select: none;
  border-radius: 20px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: var(--color-background-soft);
`

export default SleepKeepAliveIndicator
