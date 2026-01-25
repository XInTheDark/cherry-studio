export type ApiServerConfig = {
  enabled: boolean
  host: string
  port: number
  apiKey: string
  /**
   * HTTP server request timeout in minutes.
   * - 0 means disable (no timeout).
   */
  requestTimeoutMinutes: number
}

export type GetApiServerStatusResult = {
  running: boolean
  config: ApiServerConfig | null
}

export type StartApiServerStatusResult =
  | {
      success: true
    }
  | {
      success: false
      error: string
    }

export type RestartApiServerStatusResult =
  | {
      success: true
    }
  | {
      success: false
      error: string
    }

export type StopApiServerStatusResult =
  | {
      success: true
    }
  | {
      success: false
      error: string
    }
