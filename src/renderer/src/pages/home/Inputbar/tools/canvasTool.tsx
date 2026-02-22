import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'

import CanvasButton from './components/CanvasButton'

/**
 * Canvas Tool (toggle)
 *
 * Enables Canvas edit tools inside normal chats.
 * Canvas chat sidebar enables tools automatically regardless of this toggle.
 */
const canvasTool = defineTool({
  key: 'canvas',
  label: (t) => t('chat.input.canvas.label'),
  visibleInScopes: [TopicType.Chat, 'mini-window'],
  render: ({ assistant, quickPanelController }) => (
    <CanvasButton assistantId={assistant.id} quickPanelController={quickPanelController} />
  )
})

registerTool(canvasTool)

export default canvasTool
