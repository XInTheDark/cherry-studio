import { Crop, Pencil, Redo2, RotateCcw, RotateCw, Square, Type, Undo2 } from 'lucide-react'
import type { FC, PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { ActionIconButton } from '../Buttons'

type Tool = 'pen' | 'rect' | 'arrow' | 'text' | 'crop'

type Point = {
  x: number
  y: number
}

type PreviewShape = {
  type: 'rect' | 'arrow' | 'crop'
  start: Point
  end: Point
} | null

interface ImageMarkupEditorProps {
  src: string
  onCancel: () => void
  onSave: (blob: Blob) => Promise<void> | void
  saveLabel?: string
  cancelLabel?: string
}

type DrawingState = {
  tool: Tool
  start: Point
  last?: Point
}

const MIN_CROP_SIZE = 4

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.floor(width))
  canvas.height = Math.max(1, Math.floor(height))
  return canvas
}

async function loadImageToCanvas(src: string): Promise<HTMLCanvasElement> {
  const image = new Image()
  image.src = src
  await image.decode()

  const canvas = createCanvas(image.width, image.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Failed to create canvas context')

  context.drawImage(image, 0, 0)
  return canvas
}

function drawArrow(context: CanvasRenderingContext2D, start: Point, end: Point): void {
  const headLength = 12
  const angle = Math.atan2(end.y - start.y, end.x - start.x)

  context.beginPath()
  context.moveTo(start.x, start.y)
  context.lineTo(end.x, end.y)
  context.stroke()

  context.beginPath()
  context.moveTo(end.x, end.y)
  context.lineTo(end.x - headLength * Math.cos(angle - Math.PI / 6), end.y - headLength * Math.sin(angle - Math.PI / 6))
  context.lineTo(end.x - headLength * Math.cos(angle + Math.PI / 6), end.y - headLength * Math.sin(angle + Math.PI / 6))
  context.lineTo(end.x, end.y)
  context.closePath()
  context.fill()
}

const ImageMarkupEditor: FC<ImageMarkupEditorProps> = ({ src, onCancel, onSave, saveLabel, cancelLabel }) => {
  const { t } = useTranslation()

  const workspaceRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const displayRectRef = useRef<{ x: number; y: number; width: number; height: number; scale: number }>({
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    scale: 1
  })

  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawingStateRef = useRef<DrawingState | null>(null)
  const historyRef = useRef<string[]>([])
  const historyIndexRef = useRef<number>(-1)

  const [tool, setTool] = useState<Tool>('pen')
  const [lineWidth] = useState<number>(3)
  const [color] = useState<string>('#ff3b30')
  const [previewShape, setPreviewShape] = useState<PreviewShape>(null)
  const [workspaceSize, setWorkspaceSize] = useState<{ width: number; height: number }>({ width: 1, height: 1 })
  const [renderTick, setRenderTick] = useState(0)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  const requestRender = useCallback(() => {
    setRenderTick((tick) => tick + 1)
  }, [])

  const updateHistoryFlags = useCallback(() => {
    const currentIndex = historyIndexRef.current
    const total = historyRef.current.length
    setCanUndo(currentIndex > 0)
    setCanRedo(currentIndex >= 0 && currentIndex < total - 1)
  }, [])

  const pushHistory = useCallback(
    (canvas: HTMLCanvasElement) => {
      const dataUrl = canvas.toDataURL('image/png')
      const nextHistory = historyRef.current.slice(0, historyIndexRef.current + 1)
      nextHistory.push(dataUrl)
      historyRef.current = nextHistory
      historyIndexRef.current = nextHistory.length - 1
      updateHistoryFlags()
    },
    [updateHistoryFlags]
  )

  const applyHistoryState = useCallback(
    async (index: number) => {
      const target = historyRef.current[index]
      if (!target) {
        return
      }

      const nextCanvas = await loadImageToCanvas(target)
      baseCanvasRef.current = nextCanvas
      historyIndexRef.current = index
      updateHistoryFlags()
      requestRender()
    },
    [requestRender, updateHistoryFlags]
  )

  const toImagePoint = useCallback((event: ReactPointerEvent<HTMLCanvasElement>): Point | null => {
    const canvasElement = canvasRef.current
    if (!canvasElement || !baseCanvasRef.current) {
      return null
    }

    const rect = canvasElement.getBoundingClientRect()
    const px = event.clientX - rect.left
    const py = event.clientY - rect.top

    const displayRect = displayRectRef.current
    if (
      px < displayRect.x ||
      py < displayRect.y ||
      px > displayRect.x + displayRect.width ||
      py > displayRect.y + displayRect.height
    ) {
      return null
    }

    const x = (px - displayRect.x) / displayRect.scale
    const y = (py - displayRect.y) / displayRect.scale

    return {
      x: Math.max(0, Math.min(baseCanvasRef.current.width, x)),
      y: Math.max(0, Math.min(baseCanvasRef.current.height, y))
    }
  }, [])

  const drawPreviewShape = useCallback(
    (
      context: CanvasRenderingContext2D,
      shape: Exclude<PreviewShape, null>,
      scale: number,
      offsetX: number,
      offsetY: number
    ) => {
      const startX = offsetX + shape.start.x * scale
      const startY = offsetY + shape.start.y * scale
      const endX = offsetX + shape.end.x * scale
      const endY = offsetY + shape.end.y * scale

      context.save()
      context.lineWidth = lineWidth
      context.strokeStyle = shape.type === 'crop' ? '#4f9dff' : color
      context.fillStyle = shape.type === 'crop' ? 'rgba(79, 157, 255, 0.2)' : color

      if (shape.type === 'rect' || shape.type === 'crop') {
        const x = Math.min(startX, endX)
        const y = Math.min(startY, endY)
        const width = Math.abs(endX - startX)
        const height = Math.abs(endY - startY)
        context.strokeRect(x, y, width, height)
        if (shape.type === 'crop') {
          context.fillRect(x, y, width, height)
        }
      }

      if (shape.type === 'arrow') {
        drawArrow(
          context,
          { x: startX, y: startY },
          {
            x: endX,
            y: endY
          }
        )
      }

      context.restore()
    },
    [color, lineWidth]
  )

  useEffect(() => {
    let mounted = true

    const init = async () => {
      setIsLoading(true)
      try {
        const initialCanvas = await loadImageToCanvas(src)
        if (!mounted) {
          return
        }

        baseCanvasRef.current = initialCanvas
        historyRef.current = [initialCanvas.toDataURL('image/png')]
        historyIndexRef.current = 0
        updateHistoryFlags()
        requestRender()
      } finally {
        if (mounted) {
          setIsLoading(false)
        }
      }
    }

    void init()

    return () => {
      mounted = false
    }
  }, [requestRender, src, updateHistoryFlags])

  useEffect(() => {
    const workspace = workspaceRef.current
    if (!workspace) {
      return
    }

    const observer = new ResizeObserver(() => {
      const rect = workspace.getBoundingClientRect()
      setWorkspaceSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) })
    })

    observer.observe(workspace)
    const initialRect = workspace.getBoundingClientRect()
    setWorkspaceSize({ width: Math.max(1, initialRect.width), height: Math.max(1, initialRect.height) })

    return () => {
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    const canvasElement = canvasRef.current
    const baseCanvas = baseCanvasRef.current
    if (!canvasElement || !baseCanvas) {
      return
    }

    canvasElement.width = Math.max(1, Math.floor(workspaceSize.width))
    canvasElement.height = Math.max(1, Math.floor(workspaceSize.height))

    const context = canvasElement.getContext('2d')
    if (!context) {
      return
    }

    context.clearRect(0, 0, canvasElement.width, canvasElement.height)

    const scale = Math.min(canvasElement.width / baseCanvas.width, canvasElement.height / baseCanvas.height)
    const drawWidth = baseCanvas.width * scale
    const drawHeight = baseCanvas.height * scale
    const offsetX = (canvasElement.width - drawWidth) / 2
    const offsetY = (canvasElement.height - drawHeight) / 2

    displayRectRef.current = { x: offsetX, y: offsetY, width: drawWidth, height: drawHeight, scale }

    context.drawImage(baseCanvas, offsetX, offsetY, drawWidth, drawHeight)

    if (previewShape) {
      drawPreviewShape(context, previewShape, scale, offsetX, offsetY)
    }
  }, [drawPreviewShape, previewShape, renderTick, workspaceSize.height, workspaceSize.width])

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!baseCanvasRef.current) {
        return
      }

      const point = toImagePoint(event)
      if (!point) {
        return
      }

      drawingStateRef.current = {
        tool,
        start: point,
        last: point
      }

      if (tool === 'pen') {
        const context = baseCanvasRef.current.getContext('2d')
        if (!context) {
          return
        }

        context.strokeStyle = color
        context.lineWidth = lineWidth
        context.lineCap = 'round'
        context.lineJoin = 'round'

        context.beginPath()
        context.moveTo(point.x, point.y)
        context.lineTo(point.x + 0.1, point.y + 0.1)
        context.stroke()
        requestRender()
      }

      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [color, lineWidth, requestRender, toImagePoint, tool]
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const drawingState = drawingStateRef.current
      const baseCanvas = baseCanvasRef.current

      if (!drawingState || !baseCanvas) {
        return
      }

      const point = toImagePoint(event)
      if (!point) {
        return
      }

      if (drawingState.tool === 'pen') {
        const context = baseCanvas.getContext('2d')
        if (!context) {
          return
        }

        const lastPoint = drawingState.last || drawingState.start
        context.strokeStyle = color
        context.lineWidth = lineWidth
        context.lineCap = 'round'
        context.lineJoin = 'round'

        context.beginPath()
        context.moveTo(lastPoint.x, lastPoint.y)
        context.lineTo(point.x, point.y)
        context.stroke()
        drawingStateRef.current = {
          ...drawingState,
          last: point
        }
        requestRender()
        return
      }

      if (drawingState.tool === 'rect' || drawingState.tool === 'arrow' || drawingState.tool === 'crop') {
        setPreviewShape({
          type: drawingState.tool,
          start: drawingState.start,
          end: point
        })
      }
    },
    [color, lineWidth, requestRender, toImagePoint]
  )

  const commitRect = useCallback(
    (start: Point, end: Point) => {
      const baseCanvas = baseCanvasRef.current
      if (!baseCanvas) return

      const context = baseCanvas.getContext('2d')
      if (!context) return

      context.strokeStyle = color
      context.lineWidth = lineWidth
      const x = Math.min(start.x, end.x)
      const y = Math.min(start.y, end.y)
      const width = Math.abs(end.x - start.x)
      const height = Math.abs(end.y - start.y)

      if (width < 1 || height < 1) {
        return
      }

      context.strokeRect(x, y, width, height)
    },
    [color, lineWidth]
  )

  const commitArrow = useCallback(
    (start: Point, end: Point) => {
      const baseCanvas = baseCanvasRef.current
      if (!baseCanvas) return

      const context = baseCanvas.getContext('2d')
      if (!context) return

      context.strokeStyle = color
      context.fillStyle = color
      context.lineWidth = lineWidth
      drawArrow(context, start, end)
    },
    [color, lineWidth]
  )

  const commitCrop = useCallback((start: Point, end: Point): boolean => {
    const baseCanvas = baseCanvasRef.current
    if (!baseCanvas) return false

    const x = Math.floor(Math.min(start.x, end.x))
    const y = Math.floor(Math.min(start.y, end.y))
    const width = Math.floor(Math.abs(end.x - start.x))
    const height = Math.floor(Math.abs(end.y - start.y))

    if (width < MIN_CROP_SIZE || height < MIN_CROP_SIZE) {
      return false
    }

    const cropped = createCanvas(width, height)
    const context = cropped.getContext('2d')
    if (!context) return false

    context.drawImage(baseCanvas, x, y, width, height, 0, 0, width, height)
    baseCanvasRef.current = cropped
    return true
  }, [])

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const drawingState = drawingStateRef.current
      const baseCanvas = baseCanvasRef.current
      drawingStateRef.current = null

      if (!drawingState || !baseCanvas) {
        setPreviewShape(null)
        return
      }

      const point = toImagePoint(event) ?? drawingState.start

      let shouldPushHistory = false

      if (drawingState.tool === 'pen') {
        shouldPushHistory = true
      }

      if (drawingState.tool === 'rect') {
        commitRect(drawingState.start, point)
        shouldPushHistory = true
      }

      if (drawingState.tool === 'arrow') {
        commitArrow(drawingState.start, point)
        shouldPushHistory = true
      }

      if (drawingState.tool === 'crop') {
        shouldPushHistory = commitCrop(drawingState.start, point)
      }

      if (drawingState.tool === 'text') {
        const content = window.prompt(t('image_editor.text_prompt'))
        if (content?.trim()) {
          const context = baseCanvas.getContext('2d')
          if (context) {
            context.fillStyle = color
            context.font = '24px sans-serif'
            context.fillText(content.trim(), point.x, point.y)
            shouldPushHistory = true
          }
        }
      }

      setPreviewShape(null)

      if (shouldPushHistory && baseCanvasRef.current) {
        pushHistory(baseCanvasRef.current)
      }

      requestRender()
    },
    [color, commitArrow, commitCrop, commitRect, pushHistory, requestRender, t, toImagePoint]
  )

  const handleUndo = useCallback(() => {
    const current = historyIndexRef.current
    if (current <= 0) return
    void applyHistoryState(current - 1)
  }, [applyHistoryState])

  const handleRedo = useCallback(() => {
    const current = historyIndexRef.current
    const next = current + 1
    if (next >= historyRef.current.length) return
    void applyHistoryState(next)
  }, [applyHistoryState])

  const handleRotate = useCallback(
    (direction: 'left' | 'right') => {
      const baseCanvas = baseCanvasRef.current
      if (!baseCanvas) return

      const rotated = createCanvas(baseCanvas.height, baseCanvas.width)
      const context = rotated.getContext('2d')
      if (!context) return

      context.translate(rotated.width / 2, rotated.height / 2)
      context.rotate(direction === 'right' ? Math.PI / 2 : -Math.PI / 2)
      context.drawImage(baseCanvas, -baseCanvas.width / 2, -baseCanvas.height / 2)

      baseCanvasRef.current = rotated
      pushHistory(rotated)
      requestRender()
    },
    [pushHistory, requestRender]
  )

  const handleReset = useCallback(() => {
    if (historyRef.current.length === 0) {
      return
    }

    void applyHistoryState(0)
  }, [applyHistoryState])

  const handleSave = useCallback(async () => {
    const baseCanvas = baseCanvasRef.current
    if (!baseCanvas || isSaving) {
      return
    }

    setIsSaving(true)
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        baseCanvas.toBlob((output) => {
          if (!output) {
            reject(new Error('Failed to export image'))
            return
          }
          resolve(output)
        }, 'image/png')
      })

      await onSave(blob)
    } finally {
      setIsSaving(false)
    }
  }, [isSaving, onSave])

  const toolButtons = useMemo(
    () => [
      { key: 'pen' as const, icon: <Pencil size={16} />, title: t('image_editor.tool.pen') },
      { key: 'rect' as const, icon: <Square size={16} />, title: t('image_editor.tool.rect') },
      { key: 'arrow' as const, icon: <Redo2 size={16} />, title: t('image_editor.tool.arrow') },
      { key: 'text' as const, icon: <Type size={16} />, title: t('image_editor.tool.text') },
      { key: 'crop' as const, icon: <Crop size={16} />, title: t('image_editor.tool.crop') }
    ],
    [t]
  )

  return (
    <Container>
      <Toolbar>
        <ToolGroup>
          {toolButtons.map((button) => (
            <ActionIconButton
              key={button.key}
              active={tool === button.key}
              onClick={() => setTool(button.key)}
              aria-label={button.title}
              title={button.title}>
              {button.icon}
            </ActionIconButton>
          ))}
        </ToolGroup>

        <ToolGroup>
          <ActionIconButton onClick={handleUndo} disabled={!canUndo} aria-label={t('image_editor.undo')}>
            <Undo2 size={16} />
          </ActionIconButton>
          <ActionIconButton onClick={handleRedo} disabled={!canRedo} aria-label={t('image_editor.redo')}>
            <Redo2 size={16} />
          </ActionIconButton>
          <ActionIconButton onClick={() => handleRotate('left')} aria-label={t('image_editor.rotate_left')}>
            <RotateCcw size={16} />
          </ActionIconButton>
          <ActionIconButton onClick={() => handleRotate('right')} aria-label={t('image_editor.rotate_right')}>
            <RotateCw size={16} />
          </ActionIconButton>
          <ActionIconButton onClick={handleReset} aria-label={t('preview.reset')}>
            <Undo2 size={16} />
          </ActionIconButton>
        </ToolGroup>

        <FooterActions>
          <CancelButton onClick={onCancel}>{cancelLabel || t('common.cancel')}</CancelButton>
          <SaveButton type="button" onClick={handleSave} disabled={isSaving || isLoading}>
            {saveLabel || t('common.save')}
          </SaveButton>
        </FooterActions>
      </Toolbar>

      <Workspace ref={workspaceRef}>
        <Canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => {
            drawingStateRef.current = null
            setPreviewShape(null)
          }}
        />
        {isLoading && <LoadingMask>{t('common.loading')}</LoadingMask>}
      </Workspace>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: var(--color-background);
`

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
`

const ToolGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
`

const FooterActions = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`

const Workspace = styled.div`
  position: relative;
  flex: 1;
  min-height: 0;
  background: #0b0d10;
`

const Canvas = styled.canvas`
  width: 100%;
  height: 100%;
  display: block;
  touch-action: none;
  cursor: crosshair;
`

const LoadingMask = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: rgba(0, 0, 0, 0.45);
`

const CancelButton = styled.button`
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text);
  border-radius: 8px;
  padding: 4px 10px;
  cursor: pointer;
`

const SaveButton = styled.button`
  border: 0;
  background: var(--color-primary);
  color: #fff;
  border-radius: 8px;
  padding: 4px 10px;
  cursor: pointer;

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`

export default ImageMarkupEditor
