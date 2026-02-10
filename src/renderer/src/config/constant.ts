export const DEFAULT_TEMPERATURE = 1.0
// Context window budget (prompt tokens) for each assistant.
// UNLIMITED_MAX_CONTEXT_TOKENS is a sentinel used by UI/settings to represent Max.
export const UNLIMITED_MAX_CONTEXT_TOKENS = 10000000
export const DEFAULT_MAX_CONTEXT_TOKENS = UNLIMITED_MAX_CONTEXT_TOKENS
// Reserve a small margin to avoid hitting provider hard limits due to estimation variance.
export const CONTEXT_HARD_SAFETY_MARGIN_TOKENS = 512
export const DEFAULT_MAX_TOKENS = 4096
export const SYSTEM_PROMPT_THRESHOLD = 128
export const DEFAULT_KNOWLEDGE_DOCUMENT_COUNT = 6
// Sentinel value for Knowledge Base "Requested Document Chunks" slider.
// When selected, the app injects full document contents (files/notes) instead of per-message chunk retrieval.
export const KNOWLEDGE_DOCUMENT_COUNT_FULL_FILES = 51
// Sentinel value for Knowledge Base "Requested Document Chunks" slider.
// When selected, the app attaches raw files directly to the model request (no text extraction fallback).
export const KNOWLEDGE_DOCUMENT_COUNT_FULL_FILES_RAW = 52
export const DEFAULT_KNOWLEDGE_THRESHOLD = 0.0
export const DEFAULT_WEBSEARCH_RAG_DOCUMENT_COUNT = 1
export const DEFAULT_STREAM_OPTIONS_INCLUDE_USAGE = true

export const platform = window.electron?.process?.platform
export const isMac = platform === 'darwin'
export const isWin = platform === 'win32' || platform === 'win64'
export const isLinux = platform === 'linux'
export const isDev = window.electron?.process?.env?.NODE_ENV === 'development'
export const isProd = window.electron?.process?.env?.NODE_ENV === 'production'

export const SILICON_CLIENT_ID = 'SFaJLLq0y6CAMoyDm81aMu'
export const PPIO_CLIENT_ID = '37d0828c96b34936a600b62c'
export const PPIO_APP_SECRET = import.meta.env.RENDERER_VITE_PPIO_APP_SECRET || ''
export const TOKENFLUX_HOST = 'https://tokenflux.ai'

// Messages loading configuration
export const INITIAL_MESSAGES_COUNT = 20
export const LOAD_MORE_COUNT = 20

export const DEFAULT_COLOR_PRIMARY = '#00b96b'
export const THEME_COLOR_PRESETS = [
  DEFAULT_COLOR_PRIMARY,
  '#FF5470', // Coral Pink
  '#14B8A6', // Teal
  '#6366F1', // Indigo
  '#8B5CF6', // Purple
  '#EC4899', // Pink
  '#3B82F6', // Blue
  '#F59E0B', // Amber
  '#6D28D9', // Violet
  '#0EA5E9', // Sky Blue
  '#0284C7' // Light Blue
]

export const MAX_COLLAPSED_CODE_HEIGHT = 350
