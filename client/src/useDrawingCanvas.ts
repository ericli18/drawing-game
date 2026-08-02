import { useCallback, useEffect, useRef, useState } from 'react'

export type Point = { x: number; y: number }
export type Stroke = Point[]

export type CastPayload = {
  strokes: Stroke[]
  aspectRatio: number
}

const BRUSH_WIDTH = 8
const CAST_FADE_MS = 360
const MAX_STROKES = 8
const MAX_POINTS_PER_STROKE = 2_048
// Strokes smaller than this fraction of the screen are accidental taps.
const NEGLIGIBLE_STROKE_EXTENT = 0.015

function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke) {
  if (stroke.length === 0) return

  const canvas = context.canvas
  const pixelRatio = window.devicePixelRatio || 1

  context.strokeStyle = '#1c67b4'
  context.shadowColor = 'rgba(28, 103, 180, 0.62)'
  context.shadowBlur = 8 * pixelRatio
  context.lineWidth = BRUSH_WIDTH * pixelRatio
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.beginPath()

  stroke.forEach((point, index) => {
    const x = point.x * canvas.clientWidth * pixelRatio
    const y = point.y * canvas.clientHeight * pixelRatio

    if (index === 0) {
      context.moveTo(x, y)
      context.lineTo(x + 0.01, y + 0.01)
    } else {
      context.lineTo(x, y)
    }
  })

  context.stroke()
}

function isNegligible(stroke: Stroke) {
  const xs = stroke.map((point) => point.x)
  const ys = stroke.map((point) => point.y)
  return (
    Math.max(...xs) - Math.min(...xs) < NEGLIGIBLE_STROKE_EXTENT &&
    Math.max(...ys) - Math.min(...ys) < NEGLIGIBLE_STROKE_EXTENT
  )
}

function pointIn(
  bounds: DOMRect,
  pointer: Pick<PointerEvent, 'clientX' | 'clientY'>,
): Point {
  return {
    x: Math.min(1, Math.max(0, (pointer.clientX - bounds.left) / bounds.width)),
    y: Math.min(1, Math.max(0, (pointer.clientY - bounds.top) / bounds.height)),
  }
}

export function useDrawingCanvas(enabled: boolean) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const strokesRef = useRef<Stroke[]>([])
  const activeStrokeRef = useRef<Stroke | null>(null)
  const clearTimeoutRef = useRef<number | null>(null)
  const [hasDrawing, setHasDrawing] = useState(false)
  const [isCasting, setIsCasting] = useState(false)
  const [limitReached, setLimitReached] = useState(false)

  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const pixelRatio = window.devicePixelRatio || 1
    const bounds = canvas.getBoundingClientRect()
    canvas.width = Math.round(bounds.width * pixelRatio)
    canvas.height = Math.round(bounds.height * pixelRatio)

    const context = canvas.getContext('2d')
    if (context) {
      strokesRef.current.forEach((stroke) => drawStroke(context, stroke))
    }
  }, [])

  useEffect(() => {
    redrawCanvas()
    window.addEventListener('resize', redrawCanvas)
    return () => window.removeEventListener('resize', redrawCanvas)
  }, [redrawCanvas])

  useEffect(
    () => () => {
      if (clearTimeoutRef.current !== null) {
        window.clearTimeout(clearTimeoutRef.current)
      }
    },
    [],
  )

  const finishStroke = useCallback(() => {
    const stroke = activeStrokeRef.current
    activeStrokeRef.current = null
    if (stroke && isNegligible(stroke)) {
      strokesRef.current = strokesRef.current.filter(
        (existing) => existing !== stroke,
      )
      if (strokesRef.current.length === 0) setHasDrawing(false)
      redrawCanvas()
    }
    return strokesRef.current.length > 0
  }, [redrawCanvas])

  useEffect(() => {
    if (!enabled) finishStroke()
  }, [enabled, finishStroke])

  const clearDrawing = useCallback(() => {
    if (clearTimeoutRef.current !== null) {
      window.clearTimeout(clearTimeoutRef.current)
      clearTimeoutRef.current = null
    }
    strokesRef.current = []
    activeStrokeRef.current = null
    setHasDrawing(false)
    setIsCasting(false)
    setLimitReached(false)
    redrawCanvas()
  }, [redrawCanvas])

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!enabled || isCasting || event.button !== 0) return
    if (strokesRef.current.length >= MAX_STROKES) {
      setLimitReached(true)
      return
    }

    event.currentTarget.setPointerCapture(event.pointerId)
    const stroke = [
      pointIn(event.currentTarget.getBoundingClientRect(), event.nativeEvent),
    ]
    strokesRef.current.push(stroke)
    activeStrokeRef.current = stroke
    setHasDrawing(true)

    const context = event.currentTarget.getContext('2d')
    if (context) drawStroke(context, stroke)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const stroke = activeStrokeRef.current
    const canvas = canvasRef.current
    if (!enabled || !stroke || !canvas) return

    const events = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent]
    const bounds = canvas.getBoundingClientRect()
    const previousPoint = stroke.at(-1)
    const addedPoints: Stroke = previousPoint ? [previousPoint] : []

    events
      .slice(0, Math.max(0, MAX_POINTS_PER_STROKE - stroke.length))
      .forEach((pointerEvent) => {
        const point = pointIn(bounds, pointerEvent)
        stroke.push(point)
        addedPoints.push(point)
      })

    if (stroke.length >= MAX_POINTS_PER_STROKE) {
      activeStrokeRef.current = null
      setLimitReached(true)
    }

    const context = canvas.getContext('2d')
    if (context) drawStroke(context, addedPoints)
  }

  const prepareCast = useCallback((): CastPayload | null => {
    const canvas = canvasRef.current
    if (!enabled || !hasDrawing || isCasting || !canvas) return null

    const bounds = canvas.getBoundingClientRect()
    setIsCasting(true)
    return {
      strokes: strokesRef.current,
      aspectRatio: bounds.width / bounds.height,
    }
  }, [enabled, hasDrawing, isCasting])

  const resolveCast = useCallback(
    (accepted: boolean) => {
      if (!accepted) {
        setIsCasting(false)
        return
      }

      clearTimeoutRef.current = window.setTimeout(
        clearDrawing,
        CAST_FADE_MS,
      )
    },
    [clearDrawing],
  )

  return {
    canvasRef,
    hasDrawing,
    isCasting,
    limitReached,
    handlePointerDown,
    handlePointerMove,
    finishStroke,
    clearDrawing,
    prepareCast,
    resolveCast,
  }
}
