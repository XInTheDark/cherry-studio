import { resolve } from 'node:path'

import { defineConfig } from 'vitest/config'

// NOTE:
// We intentionally do not import `electron.vite.config.ts` here.
// That config pulls in the Electron/Vite toolchain and may introduce ESM/CJS interop issues
// when Vitest loads its config. For tests we only need stable alias resolution.
//
// Keep Vitest aliases aligned with electron-vite so tests can resolve @renderer/@shared/etc.
const mainAlias = {
  '@main': resolve('src/main'),
  '@types': resolve('src/renderer/src/types'),
  '@shared': resolve('packages/shared'),
  '@logger': resolve('src/main/services/LoggerService'),
  '@mcp-trace/trace-core': resolve('packages/mcp-trace/trace-core'),
  '@mcp-trace/trace-node': resolve('packages/mcp-trace/trace-node')
}

const rendererAlias = {
  '@renderer': resolve('src/renderer/src'),
  '@shared': resolve('packages/shared'),
  '@types': resolve('src/renderer/src/types'),
  '@logger': resolve('src/renderer/src/services/LoggerService'),
  '@mcp-trace/trace-core': resolve('packages/mcp-trace/trace-core'),
  '@mcp-trace/trace-web': resolve('packages/mcp-trace/trace-web'),
  '@cherrystudio/ai-core/provider': resolve('packages/aiCore/src/core/providers'),
  '@cherrystudio/ai-core/built-in/plugins': resolve('packages/aiCore/src/core/plugins/built-in'),
  '@cherrystudio/ai-core': resolve('packages/aiCore/src'),
  '@cherrystudio/extension-table-plus': resolve('packages/extension-table-plus/src'),
  '@cherrystudio/ai-sdk-provider': resolve('packages/ai-sdk-provider/src')
}

export default defineConfig({
  test: {
    projects: [
      // 主进程单元测试配置
      {
        extends: true,
        resolve: {
          alias: mainAlias
        },
        test: {
          name: 'main',
          environment: 'node',
          setupFiles: ['tests/main.setup.ts'],
          include: ['src/main/**/*.{test,spec}.{ts,tsx}', 'src/main/**/__tests__/**/*.{test,spec}.{ts,tsx}']
        }
      },
      // 渲染进程单元测试配置
      {
        extends: true,
        resolve: {
          alias: rendererAlias
        },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          setupFiles: ['@vitest/web-worker', 'tests/renderer.setup.ts'],
          include: ['src/renderer/**/*.{test,spec}.{ts,tsx}', 'src/renderer/**/__tests__/**/*.{test,spec}.{ts,tsx}']
        }
      },
      // 脚本单元测试配置
      {
        extends: true,
        test: {
          name: 'scripts',
          environment: 'node',
          include: ['scripts/**/*.{test,spec}.{ts,tsx}', 'scripts/**/__tests__/**/*.{test,spec}.{ts,tsx}']
        }
      },
      // aiCore 包单元测试配置
      {
        extends: 'packages/aiCore/vitest.config.ts',
        test: {
          name: 'aiCore',
          environment: 'node',
          include: [
            'packages/aiCore/**/*.{test,spec}.{ts,tsx}',
            'packages/aiCore/**/__tests__/**/*.{test,spec}.{ts,tsx}'
          ]
        }
      },
      // shared 包单元测试配置
      {
        extends: true,
        test: {
          name: 'shared',
          environment: 'node',
          include: [
            'packages/shared/**/*.{test,spec}.{ts,tsx}',
            'packages/shared/**/__tests__/**/*.{test,spec}.{ts,tsx}'
          ]
        }
      }
    ],
    // 全局共享配置
    globals: true,
    setupFiles: [],
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/build/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov', 'text-summary'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/out/**',
        '**/build/**',
        '**/coverage/**',
        '**/tests/**',
        '**/.yarn/**',
        '**/.cursor/**',
        '**/.vscode/**',
        '**/.github/**',
        '**/.husky/**',
        '**/*.d.ts',
        '**/types/**',
        '**/__tests__/**',
        '**/*.{test,spec}.{ts,tsx}',
        '**/*.config.{js,ts}'
      ]
    },
    testTimeout: 20000,
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: false
      }
    }
  }
})
