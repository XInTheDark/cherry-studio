import { UNLIMITED_MAX_CONTEXT_TOKENS } from '@renderer/config/constant'
import { Infinity as InfinityIcon } from 'lucide-react'
import type { CSSProperties } from 'react'

type Props = {
  maxContext: number
  style?: CSSProperties
  size?: number
}

export default function MaxContextCount({ maxContext, style, size = 14 }: Props) {
  return maxContext >= UNLIMITED_MAX_CONTEXT_TOKENS ? (
    <InfinityIcon size={size} style={style} aria-label="infinity" />
  ) : (
    <span style={style}>{maxContext.toString()}</span>
  )
}
