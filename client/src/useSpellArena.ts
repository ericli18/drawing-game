import { useCallback, useEffect, useRef, useState } from 'react'

export type ServerState = 'connecting' | 'connected' | 'offline'

export type Notice = {
  tone: 'checking' | 'success' | 'error' | 'opponent'
  title: string
  detail: string
}

type Point = { x: number; y: number }

type Stroke = Point[]

function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke) {
  if (stroke.length === 0) return

  const canvas = context.canvas
  const pixelRatio = window.devicePixelRatio || 1

  context.strokeStyle = '#d7ff3f'
  context.lineWidth = 7 * pixelRatio
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.shadowColor = 'rgba(215, 255, 63, 0.65)'
  context.shadowBlur = 12 * pixelRatio
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

function pointIn(
  bounds: DOMRect,
  pointer: Pick<PointerEvent, 'clientX' | 'clientY'>,
): Point {
  return {
    x: (pointer.clientX - bounds.left) / bounds.width,
    y: (pointer.clientY - bounds.top) / bounds.height,
  }
}

function formatSpellName(name?: string) {
  if (!name) return 'Spell'
  return name.charAt(0).toUpperCase() + name.slice(1).replaceAll('_', ' ')
}

export function useSpellArena() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const strokesRef = useRef<Stroke[]>([])
  const activeStrokeRef = useRef<Stroke | null>(null)
  const castTimeoutRef = useRef<number | null>(null)
  const socketRef = useRef<WebSocket | null>(null)

  const [hasDrawing, setHasDrawing] = useState(false)
  const [isCasting, setIsCasting] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [serverState, setServerState] = useState<ServerState>('connecting')

  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const pixelRatio = window.devicePixelRatio || 1
    const { width, height } = canvas.getBoundingClientRect()
    canvas.width = Math.round(width * pixelRatio)
    canvas.height = Math.round(height * pixelRatio)

    const context = canvas.getContext('2d')
    if (context) strokesRef.current.forEach((stroke) => drawStroke(context, stroke))
  }, [])

  useEffect(() => {
    redrawCanvas()
    window.addEventListener('resize', redrawCanvas)
    return () => window.removeEventListener('resize', redrawCanvas)
  }, [redrawCanvas])

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (isCasting || event.button !== 0) return

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
    if (!stroke || !canvas) return

    const events = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent]
    const bounds = canvas.getBoundingClientRect()
    const previousPoint = stroke.at(-1)
    const addedPoints: Stroke = previousPoint ? [previousPoint] : []

    events.forEach((pointerEvent) => {
      const point = pointIn(bounds, pointerEvent)
      stroke.push(point)
      addedPoints.push(point)
    })

    const context = canvas.getContext('2d')
    if (context) drawStroke(context, addedPoints)
  }

  const finishStroke = () => {
    activeStrokeRef.current = null
  }

  const clearDrawing = useCallback(() => {
    strokesRef.current = []
    activeStrokeRef.current = null
    setHasDrawing(false)
    redrawCanvas()
  }, [redrawCanvas])

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const defaultUrl = `${protocol}://${window.location.host}/ws/demo-room/player-one`
    const socket = new WebSocket(import.meta.env.VITE_WS_URL ?? defaultUrl)
    socketRef.current = socket

    socket.addEventListener('open', () => {
      if (socketRef.current === socket) setServerState('connected')
    })
    socket.addEventListener('close', () => {
      if (socketRef.current === socket) setServerState('offline')
    })
    socket.addEventListener('error', () => {
      if (socketRef.current === socket) setServerState('offline')
    })
    socket.addEventListener('message', (event) => {
      if (socketRef.current !== socket) return

      const message = JSON.parse(event.data) as {
        type: string
        accepted?: boolean
        drawingType?: string
        effect?: string
        reason?: string
      }

      if (message.type === 'cast_result') {
        if (message.accepted) {
          setNotice({
            tone: 'success',
            title: `${formatSpellName(message.drawingType)} applied`,
            detail: 'Your opponent received the spell effect.',
          })
          castTimeoutRef.current = window.setTimeout(() => {
            clearDrawing()
            setIsCasting(false)
          }, 650)
        } else {
          setIsCasting(false)
          setNotice({
            tone: 'error',
            title: 'Spell rejected',
            detail:
              message.reason === 'ambiguous'
                ? 'The shape is too close to multiple spells. Adjust it and try again.'
                : 'The shape was not recognized. Adjust it and try again.',
          })
        }
      } else if (message.type === 'effect') {
        setNotice({
          tone: 'opponent',
          title: `Incoming ${formatSpellName(message.effect)}`,
          detail: 'Your opponent applied a spell effect.',
        })
      } else if (message.type === 'error') {
        setIsCasting(false)
        setNotice({
          tone: 'error',
          title: 'Cast failed',
          detail: 'The server could not read that spell.',
        })
      }
    })

    return () => {
      if (socketRef.current === socket) socketRef.current = null
      socket.close()
      if (castTimeoutRef.current) window.clearTimeout(castTimeoutRef.current)
    }
  }, [clearDrawing])

  const castSpell = () => {
    if (!hasDrawing || isCasting) return

    const socket = socketRef.current
    const canvas = canvasRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setNotice({
        tone: 'error',
        title: 'Arena offline',
        detail: 'Reconnect before casting another spell.',
      })
      return
    }
    if (!canvas) return

    setIsCasting(true)
    setNotice({
      tone: 'checking',
      title: 'Reading spell…',
      detail: 'The server is checking your drawing.',
    })
    const bounds = canvas.getBoundingClientRect()
    socket.send(
      JSON.stringify({
        type: 'cast',
        strokes: strokesRef.current,
        aspectRatio: bounds.width / bounds.height,
      }),
    )
  }

  return {
    canvasRef,
    hasDrawing,
    isCasting,
    notice,
    serverState,
    handlePointerDown,
    handlePointerMove,
    finishStroke,
    clearDrawing,
    castSpell,
  }
}
