// don't reorder this file, it's used to initialize the app data dir and
// other which should be run before the main process is ready
// eslint-disable-next-line
import './bootstrap'

import '@main/config'

import { loggerService } from '@logger'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { replaceDevtoolsFont } from '@main/utils/windowUtil'
import { API_SERVER_DEFAULTS } from '@shared/config/constant'
import { IpcChannel } from '@shared/IpcChannel'
import { app, BrowserWindow, crashReporter, powerMonitor } from 'electron'
import installExtension, { REACT_DEVELOPER_TOOLS, REDUX_DEVTOOLS } from 'electron-devtools-installer'
import { isDev, isLinux, isWin } from './constant'

import process from 'node:process'

import { registerIpc } from './ipc'
import { agentService } from './services/agents'
import { apiServerService } from './services/ApiServerService'
import { appMenuService } from './services/AppMenuService'
import { chatSleepKeepAliveService } from './services/ChatSleepKeepAliveService'
import { configManager } from './services/ConfigManager'
import { lanTransferClientService } from './services/lanTransfer'
import mcpService from './services/MCPService'
import { localTransferService } from './services/LocalTransferService'
import { nodeTraceService } from './services/NodeTraceService'
import powerMonitorService from './services/PowerMonitorService'
import { proxyManager } from './services/ProxyManager'
import {
  CHERRY_STUDIO_PROTOCOL,
  handleProtocolUrl,
  registerProtocolClient,
  setupAppImageDeepLink
} from './services/ProtocolClient'
import { reduxService } from './services/ReduxService'
import selectionService, { initSelectionService } from './services/SelectionService'
import { registerShortcuts } from './services/ShortcutService'
import { TrayService } from './services/TrayService'
import { versionService } from './services/VersionService'
import { windowService } from './services/WindowService'
import { initWebviewHotkeys } from './services/WebviewService'
import { runAsyncFunction } from './utils'
import { isOvmsSupported } from './services/OvmsManager'

const logger = loggerService.withContext('MainEntry')

// enable local crash reports
crashReporter.start({
  companyName: 'CherryHQ',
  productName: 'CherryStudio',
  submitURL: '',
  uploadToServer: false
})

/**
 * Disable hardware acceleration if setting is enabled
 */
const disableHardwareAcceleration = configManager.getDisableHardwareAcceleration()
if (disableHardwareAcceleration) {
  app.disableHardwareAcceleration()
}

/**
 * Disable chromium's window animations
 * main purpose for this is to avoid the transparent window flashing when it is shown
 * (especially on Windows for SelectionAssistant Toolbar)
 * Know Issue: https://github.com/electron/electron/issues/12130#issuecomment-627198990
 */
if (isWin) {
  app.commandLine.appendSwitch('wm-window-animations-disabled')
}

/**
 * Enable GlobalShortcutsPortal for Linux Wayland Protocol
 * see: https://www.electronjs.org/docs/latest/api/global-shortcut
 */
if (isLinux && process.env.XDG_SESSION_TYPE === 'wayland') {
  app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')
}

// DocumentPolicyIncludeJSCallStacksInCrashReports: Enable features for unresponsive renderer js call stacks
// EarlyEstablishGpuChannel,EstablishGpuChannelAsync: Enable features for early establish gpu channel
// speed up the startup time
// https://github.com/microsoft/vscode/pull/241640/files
app.commandLine.appendSwitch(
  'enable-features',
  'DocumentPolicyIncludeJSCallStacksInCrashReports,EarlyEstablishGpuChannel,EstablishGpuChannelAsync'
)
app.on('web-contents-created', (_, webContents) => {
  webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Document-Policy': ['include-js-call-stacks-in-crash-reports']
      }
    })
  })

  webContents.on('unresponsive', async () => {
    // Interrupt execution and collect call stack from unresponsive renderer
    logger.error('Renderer unresponsive start')
    const callStack = await webContents.mainFrame.collectJavaScriptCallStack()
    logger.error(`Renderer unresponsive js call stack\n ${callStack}`)
  })
})

// in production mode, handle uncaught exception and unhandled rejection globally
if (!isDev) {
  // handle uncaught exception
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error)
  })

  // handle unhandled rejection
  process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection at: ${promise} reason: ${reason}`)
  })
}

// Check for single instance lock
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
} else {
  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.

  app.whenReady().then(async () => {
    // Record current version for tracking
    // A preparation for v2 data refactoring
    versionService.recordCurrentVersion()

    initWebviewHotkeys()
    // Set app user model id for windows
    electronApp.setAppUserModelId(import.meta.env.VITE_MAIN_BUNDLE_ID || 'com.kangfenmao.CherryStudio')

    // Mac: Hide dock icon before window creation when launch to tray is set
    const isLaunchToTray = configManager.getLaunchToTray()
    if (isLaunchToTray) {
      app.dock?.hide()
    }

    const mainWindow = windowService.createMainWindow()
    new TrayService()

    // Setup macOS application menu
    appMenuService?.setupApplicationMenu()

    nodeTraceService.init()
    powerMonitorService.init()

    powerMonitor.on('resume', () => {
      const resumedAt = Date.now()
      logger.info('System resume detected, broadcasting to renderer windows', { resumedAt })

      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) {
          continue
        }

        win.webContents.send(IpcChannel.App_SystemResumed, resumedAt)
      }
    })

    app.on('activate', function () {
      const mainWindow = windowService.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) {
        windowService.createMainWindow()
      } else {
        windowService.showMainWindow()
      }
    })

    registerShortcuts(mainWindow)

    await registerIpc(mainWindow, app)

    // Keep the global Node HTTP client timeouts in sync with the "Request Timeout" setting.
    // This prevents Undici defaults (~300s) from cutting off long-running requests.
    runAsyncFunction(async () => {
      const normalizeTimeoutMinutes = (value: unknown): number => {
        const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
        if (!Number.isFinite(parsed) || parsed < 0) {
          return API_SERVER_DEFAULTS.REQUEST_TIMEOUT_MINUTES
        }
        return Math.floor(parsed)
      }

      try {
        const initialTimeoutMinutes = await reduxService.select('state.settings.apiServer.requestTimeoutMinutes')
        proxyManager.setRequestTimeoutMinutes(normalizeTimeoutMinutes(initialTimeoutMinutes))
      } catch (error) {
        logger.warn('Failed to read request timeout setting from Redux; using defaults', { error })
        proxyManager.setRequestTimeoutMinutes(API_SERVER_DEFAULTS.REQUEST_TIMEOUT_MINUTES)
      }

      try {
        await reduxService.subscribe('state.settings.apiServer.requestTimeoutMinutes', (value) => {
          proxyManager.setRequestTimeoutMinutes(normalizeTimeoutMinutes(value))
        })
      } catch (error) {
        logger.warn('Failed to subscribe to request timeout setting changes', { error })
      }
    })

    // Keep in-flight chat requests alive during system sleep when enabled by user.
    runAsyncFunction(async () => {
      const keepAliveEnabledSelector = 'state.settings.keepChatRequestsAliveOnSleep'
      const hasActiveChatRequestSelector = [
        '(() => {',
        'const loadingByTopic = state.messages?.loadingByTopic ?? {}',
        'return Object.values(loadingByTopic).some((loading) => Boolean(loading))',
        '})()'
      ].join('\n')

      try {
        const keepAliveEnabled = await reduxService.select<boolean>(keepAliveEnabledSelector)
        chatSleepKeepAliveService.setEnabled(Boolean(keepAliveEnabled))
      } catch (error) {
        logger.warn('Failed to read keep-alive-on-sleep setting from Redux; disabling feature', { error })
        chatSleepKeepAliveService.setEnabled(false)
      }

      try {
        const hasActiveChatRequest = await reduxService.select<boolean>(hasActiveChatRequestSelector)
        chatSleepKeepAliveService.setHasActiveChatRequest(Boolean(hasActiveChatRequest))
      } catch (error) {
        logger.warn('Failed to read in-flight chat status from Redux; assuming no active requests', { error })
        chatSleepKeepAliveService.setHasActiveChatRequest(false)
      }

      try {
        await reduxService.subscribe(keepAliveEnabledSelector, (value) => {
          chatSleepKeepAliveService.setEnabled(Boolean(value))
        })
      } catch (error) {
        logger.warn('Failed to subscribe to keep-alive-on-sleep setting changes', { error })
      }

      try {
        await reduxService.subscribe(hasActiveChatRequestSelector, (value) => {
          chatSleepKeepAliveService.setHasActiveChatRequest(Boolean(value))
        })
      } catch (error) {
        logger.warn('Failed to subscribe to in-flight chat status changes', { error })
      }
    })

    localTransferService.startDiscovery({ resetList: true })

    replaceDevtoolsFont(mainWindow)

    // Setup deep link for AppImage on Linux
    await setupAppImageDeepLink()

    if (isDev) {
      installExtension([REDUX_DEVTOOLS, REACT_DEVELOPER_TOOLS])
        .then((name) => logger.info(`Added Extension:  ${name}`))
        .catch((err) => logger.error('An error occurred: ', err))
    }

    //start selection assistant service
    initSelectionService()

    runAsyncFunction(async () => {
      // Start API server if enabled or if agents exist
      try {
        const config = await apiServerService.getCurrentConfig()
        logger.info('API server config:', config)

        // Check if there are any agents
        let shouldStart = config.enabled
        if (!shouldStart) {
          try {
            const { total } = await agentService.listAgents({ limit: 1 })
            if (total > 0) {
              shouldStart = true
              logger.info(`Detected ${total} agent(s), auto-starting API server`)
            }
          } catch (error: any) {
            logger.warn('Failed to check agent count:', error)
          }
        }

        if (shouldStart) {
          await apiServerService.start()
        }
      } catch (error: any) {
        logger.error('Failed to check/start API server:', error)
      }
    })
  })

  registerProtocolClient(app)

  // macOS specific: handle protocol when app is already running

  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleProtocolUrl(url)
  })

  const handleOpenUrl = (args: string[]) => {
    const url = args.find((arg) => arg.startsWith(CHERRY_STUDIO_PROTOCOL + '://'))
    if (url) handleProtocolUrl(url)
  }

  // for windows to start with url
  handleOpenUrl(process.argv)

  // Listen for second instance
  app.on('second-instance', (_event, argv) => {
    windowService.showMainWindow()

    // Protocol handler for Windows/Linux
    // The commandLine is an array of strings where the last item might be the URL
    handleOpenUrl(argv)
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  app.on('before-quit', () => {
    app.isQuitting = true

    // quit selection service
    if (selectionService) {
      selectionService.quit()
    }

    lanTransferClientService.dispose()
    localTransferService.dispose()
    chatSleepKeepAliveService.dispose()
  })

  app.on('will-quit', async () => {
    // 简单的资源清理，不阻塞退出流程
    if (isOvmsSupported) {
      const { ovmsManager } = await import('./services/OvmsManager')
      if (ovmsManager) {
        await ovmsManager.stopOvms()
      } else {
        logger.warn('Unexpected behavior: undefined ovmsManager, but OVMS should be supported.')
      }
    }

    try {
      await mcpService.cleanup()
      await apiServerService.stop()
    } catch (error) {
      logger.warn('Error cleaning up MCP service:', error as Error)
    }

    // finish the logger
    logger.finish()
  })

  // In this file you can include the rest of your app"s specific main process
  // code. You can also put them in separate files and require them here.
}
