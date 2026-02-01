import { ActionIconButton } from '@renderer/components/Buttons'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useTimer } from '@renderer/hooks/useTimer'
import { Tooltip } from 'antd'
import { PenSquare } from 'lucide-react'
import type { FC } from 'react'
import { memo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  assistantId: string
}

/**
 * Toggle Canvas tools for normal chats.
 *
 * Note: Canvas chat sidebar enables Canvas tools automatically regardless of this toggle.
 */
const CanvasButton: FC<Props> = ({ assistantId }) => {
  const { t } = useTranslation()
  const { assistant, updateAssistant } = useAssistant(assistantId)
  const { setTimeoutTimer } = useTimer()

  const nextState = !assistant.enableCanvas

  const handleToggle = useCallback(() => {
    setTimeoutTimer(
      'toggleCanvasTools',
      () => {
        updateAssistant({ ...assistant, enableCanvas: nextState })
      },
      100
    )
  }, [assistant, nextState, setTimeoutTimer, updateAssistant])

  const ariaLabel = t('chat.input.canvas.label')

  return (
    <Tooltip placement="top" title={ariaLabel} arrow>
      <ActionIconButton
        onClick={handleToggle}
        active={!!assistant.enableCanvas}
        aria-label={ariaLabel}
        aria-pressed={!!assistant.enableCanvas}>
        <PenSquare size={18} />
      </ActionIconButton>
    </Tooltip>
  )
}

export default memo(CanvasButton)
