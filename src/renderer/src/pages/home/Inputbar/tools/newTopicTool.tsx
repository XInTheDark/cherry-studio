import { ActionIconButton } from '@renderer/components/Buttons'
import { useShortcutDisplay } from '@renderer/hooks/useShortcuts'
import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'
import { Tooltip } from 'antd'
import { MessageSquareDiff } from 'lucide-react'

const newTopicTool = defineTool({
  key: 'new_topic',
  label: (t) => t('chat.input.new_topic', { Command: '' }),

  visibleInScopes: [TopicType.Chat, 'mini-window'],

  dependencies: {
    actions: ['addNewTopic'] as const
  },

  render: function NewTopicRender(context) {
    const { actions, t } = context
    const newTopicShortcut = useShortcutDisplay('new_topic')
    const isMiniWindow = context.scope === 'mini-window'

    return (
      <Tooltip
        placement="top"
        title={isMiniWindow ? 'New conversation' : t('chat.input.new_topic', { Command: newTopicShortcut })}
        mouseLeaveDelay={0}
        arrow>
        <ActionIconButton onClick={actions.addNewTopic}>
          <MessageSquareDiff size={19} />
        </ActionIconButton>
      </Tooltip>
    )
  }
})

// Register the tool
registerTool(newTopicTool)

export default newTopicTool
