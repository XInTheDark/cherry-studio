import { useCallback, useEffect, useRef } from 'react'

interface UseSmoothStreamOptions {
  onUpdate: (text: string) => void
  streamDone: boolean
  minDelay?: number
  initialText?: string
}

const languages = ['en-US', 'de-DE', 'es-ES', 'zh-CN', 'zh-TW', 'ja-JP', 'ru-RU', 'el-GR', 'fr-FR', 'pt-PT', 'ro-RO']
const segmenter = new Intl.Segmenter(languages)

export const useSmoothStream = ({ onUpdate, streamDone, minDelay = 16, initialText = '' }: UseSmoothStreamOptions) => {
  const chunkQueueRef = useRef<string[]>([])
  const animationFrameRef = useRef<number | null>(null)
  const displayedTextRef = useRef<string>(initialText)
  const lastUpdateTimeRef = useRef<number>(0)
  const streamDoneRef = useRef<boolean>(streamDone)

  const cancelRenderLoop = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
  }, [])

  const renderLoop = useCallback(
    (currentTime: number) => {
      // Mark current frame as consumed; schedule explicitly if we still need work.
      animationFrameRef.current = null

      if (chunkQueueRef.current.length === 0) {
        if (streamDoneRef.current) {
          onUpdate(displayedTextRef.current)
        }
        return
      }

      if (currentTime - lastUpdateTimeRef.current < minDelay) {
        animationFrameRef.current = requestAnimationFrame(renderLoop)
        return
      }

      lastUpdateTimeRef.current = currentTime

      let charsToRenderCount = Math.max(1, Math.floor(chunkQueueRef.current.length / 5))
      if (streamDoneRef.current) {
        charsToRenderCount = chunkQueueRef.current.length
      }

      const charsToRender = chunkQueueRef.current.slice(0, charsToRenderCount)
      displayedTextRef.current += charsToRender.join('')
      onUpdate(displayedTextRef.current)

      chunkQueueRef.current = chunkQueueRef.current.slice(charsToRenderCount)

      if (chunkQueueRef.current.length > 0) {
        animationFrameRef.current = requestAnimationFrame(renderLoop)
      } else if (streamDoneRef.current) {
        onUpdate(displayedTextRef.current)
      }
    },
    [minDelay, onUpdate]
  )

  const ensureRenderLoop = useCallback(() => {
    if (animationFrameRef.current === null) {
      animationFrameRef.current = requestAnimationFrame(renderLoop)
    }
  }, [renderLoop])

  const addChunk = useCallback(
    (chunk: string) => {
      const chars = Array.from(segmenter.segment(chunk)).map((s) => s.segment)
      if (!chars.length) return

      chunkQueueRef.current.push(...chars)
      ensureRenderLoop()
    },
    [ensureRenderLoop]
  )

  const reset = useCallback(
    (newText = '') => {
      cancelRenderLoop()
      chunkQueueRef.current = []
      displayedTextRef.current = newText
      lastUpdateTimeRef.current = 0
      onUpdate(newText)
    },
    [cancelRenderLoop, onUpdate]
  )

  useEffect(() => {
    streamDoneRef.current = streamDone

    // Flush immediately once the stream ends, even if no new chunk arrives.
    if (streamDoneRef.current) {
      if (chunkQueueRef.current.length > 0) {
        ensureRenderLoop()
      } else {
        onUpdate(displayedTextRef.current)
      }
    }
  }, [ensureRenderLoop, onUpdate, streamDone])

  useEffect(() => {
    return () => {
      cancelRenderLoop()
    }
  }, [cancelRenderLoop])

  return { addChunk, reset }
}
