import type { Topic } from '@renderer/types'

export interface SetActiveTopicOptions {
  openInNewTab?: boolean
  preserveTabState?: boolean
}

export type SetActiveTopicHandler = (topic: Topic, options?: SetActiveTopicOptions) => void
