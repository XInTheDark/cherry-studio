import { vi } from 'vitest'

// Mock LoggerService globally for main process tests
vi.mock('@logger', async () => {
  const { MockMainLoggerService, mockMainLoggerService } = await import('./__mocks__/MainLoggerService')
  return {
    LoggerService: MockMainLoggerService,
    loggerService: mockMainLoggerService
  }
})

// Mock electron modules that are commonly used in main process
vi.mock('electron', () => ({
  app: {
    hide: vi.fn(),
    show: vi.fn(),
    isHidden: vi.fn(() => false),
    setPath: vi.fn(),
    getPath: vi.fn((key: string) => {
      switch (key) {
        case 'userData':
          return '/mock/userData'
        case 'temp':
          return '/mock/temp'
        case 'logs':
          return '/mock/logs'
        default:
          return '/mock/unknown'
      }
    }),
    getVersion: vi.fn(() => '1.0.0')
  },
  nativeTheme: {
    shouldUseDarkColors: false,
    themeSource: 'system',
    on: vi.fn()
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn()
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: vi.fn(() => []) }),
  dialog: {
    showErrorBox: vi.fn(),
    showMessageBox: vi.fn(),
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn()
  },
  shell: {
    openExternal: vi.fn(),
    openPath: vi.fn(),
    showItemInFolder: vi.fn()
  },
  session: {
    defaultSession: {
      clearCache: vi.fn(),
      clearStorageData: vi.fn()
    }
  },
  webContents: {
    getAllWebContents: vi.fn(() => [])
  },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(),
    askForMediaAccess: vi.fn()
  },
  screen: {
    getPrimaryDisplay: vi.fn(),
    getAllDisplays: vi.fn(),
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
    getDisplayNearestPoint: vi.fn(() => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }))
  },
  Notification: vi.fn()
}))

// Mock Winston for LoggerService dependencies
vi.mock('winston', () => ({
  createLogger: vi.fn(() => ({
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    level: 'info',
    on: vi.fn(),
    end: vi.fn()
  })),
  format: {
    combine: vi.fn(),
    splat: vi.fn(),
    timestamp: vi.fn(),
    errors: vi.fn(),
    json: vi.fn()
  },
  transports: {
    Console: vi.fn(),
    File: vi.fn()
  }
}))

// Mock winston-daily-rotate-file
vi.mock('winston-daily-rotate-file', () => {
  return vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    log: vi.fn()
  }))
})

// Mock Node.js modules
vi.mock('node:os', () => ({
  platform: vi.fn(() => 'darwin'),
  arch: vi.fn(() => 'x64'),
  version: vi.fn(() => '20.0.0'),
  cpus: vi.fn(() => [{ model: 'Mock CPU' }]),
  totalmem: vi.fn(() => 8 * 1024 * 1024 * 1024) // 8GB
}))

vi.mock('node:path', async () => {
  const actual = await vi.importActual('node:path')
  return {
    ...actual,
    join: vi.fn((...args: string[]) => args.join('/')),
    resolve: vi.fn((...args: string[]) => args.join('/'))
  }
})

vi.mock('node:fs', () => ({
  promises: {
    access: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    unlink: vi.fn(),
    rmdir: vi.fn()
  },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
  rmdirSync: vi.fn(),
  createReadStream: vi.fn(),
  createWriteStream: vi.fn()
}))
