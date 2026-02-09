import { loggerService } from '@logger'
import { powerSaveBlocker } from 'electron'

const logger = loggerService.withContext('ChatSleepKeepAliveService')

class ChatSleepKeepAliveService {
  private enabled = false
  private hasActiveChatRequest = false
  private blockerId: number | null = null

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.syncBlockerState()
  }

  public setHasActiveChatRequest(hasActiveChatRequest: boolean): void {
    this.hasActiveChatRequest = hasActiveChatRequest
    this.syncBlockerState()
  }

  public dispose(): void {
    this.stopBlocker()
  }

  private shouldKeepAwake(): boolean {
    return this.enabled && this.hasActiveChatRequest
  }

  private syncBlockerState(): void {
    if (this.shouldKeepAwake()) {
      this.startBlocker()
      return
    }

    this.stopBlocker()
  }

  private startBlocker(): void {
    if (this.blockerId !== null && powerSaveBlocker.isStarted(this.blockerId)) {
      return
    }

    this.blockerId = powerSaveBlocker.start('prevent-app-suspension')
    logger.info('Started powerSaveBlocker for in-flight chat requests', { blockerId: this.blockerId })
  }

  private stopBlocker(): void {
    if (this.blockerId === null) {
      return
    }

    const blockerId = this.blockerId
    this.blockerId = null

    if (!powerSaveBlocker.isStarted(blockerId)) {
      return
    }

    powerSaveBlocker.stop(blockerId)
    logger.info('Stopped powerSaveBlocker for in-flight chat requests', { blockerId })
  }
}

export const chatSleepKeepAliveService = new ChatSleepKeepAliveService()
