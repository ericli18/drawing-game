import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

type CameraState = 'requesting' | 'ready' | 'blocked'
type ServerState = 'connecting' | 'connected' | 'offline'
type NoticeTone = 'checking' | 'success' | 'error' | 'opponent'

type Notice = {
  tone: NoticeTone
  title: string
  detail: string
}

type Point = {
  x: number
  y: number
}

type Stroke = Point[]

const CameraOffIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24">
    <path d="m3 3 18 18M10.6 6H5.8A2.8 2.8 0 0 0 3 8.8v6.4A2.8 2.8 0 0 0 5.8 18h10.8M21 8.4l-4 2.3v2.6l4 2.3V8.4Z" />
  </svg>
)

const formatSpellName = (name?: string) => {
  if (!name) return 'Spell'
  return name.charAt(0).toUpperCase() + name.slice(1).replaceAll('_', ' ')
}

function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const strokesRef = useRef<Stroke[]>([])
  const activeStrokeRef = useRef<Stroke | null>(null)
  const castTimeoutRef = useRef<number | null>(null)
  const cameraRequestRef = useRef(0)
  const socketRef = useRef<WebSocket | null>(null)

  const [cameraState, setCameraState] = useState<CameraState>('requesting')
  const [hasDrawing, setHasDrawing] = useState(false)
  const [isCasting, setIsCasting] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [serverState, setServerState] = useState<ServerState>('connecting')

  const drawStroke = useCallback(
    (context: CanvasRenderingContext2D, stroke: Stroke) => {
      if (stroke.length === 0) return

      const canvas = context.canvas
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      const pixelRatio = window.devicePixelRatio || 1

      context.strokeStyle = '#d7ff3f'
      context.lineWidth = 7 * pixelRatio
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.shadowColor = 'rgba(215, 255, 63, 0.65)'
      context.shadowBlur = 12 * pixelRatio
      context.beginPath()

      stroke.forEach((point, index) => {
        const x = point.x * width * pixelRatio
        const y = point.y * height * pixelRatio

        if (index === 0) {
          context.moveTo(x, y)
          context.lineTo(x + 0.01, y + 0.01)
        } else {
          context.lineTo(x, y)
        }
      })

      context.stroke()
    },
    [],
  )

  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const pixelRatio = window.devicePixelRatio || 1
    const { width, height } = canvas.getBoundingClientRect()
    canvas.width = Math.round(width * pixelRatio)
    canvas.height = Math.round(height * pixelRatio)

    const context = canvas.getContext('2d')
    if (!context) return

    strokesRef.current.forEach((stroke) => drawStroke(context, stroke))
  }, [drawStroke])

  const startCamera = useCallback(async () => {
    const requestId = ++cameraRequestRef.current
    streamRef.current?.getTracks().forEach((track) => track.stop())
    setCameraState('requesting')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      })

      if (requestId !== cameraRequestRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
      }
      setCameraState('ready')
    } catch {
      setCameraState('blocked')
    }
  }, [])

  useEffect(() => {
    void startCamera()

    return () => {
      cameraRequestRef.current += 1
      streamRef.current?.getTracks().forEach((track) => track.stop())
      if (castTimeoutRef.current) window.clearTimeout(castTimeoutRef.current)
    }
  }, [startCamera])

  useEffect(() => {
    redrawCanvas()
    window.addEventListener('resize', redrawCanvas)
    return () => window.removeEventListener('resize', redrawCanvas)
  }, [redrawCanvas])

  const getPoint = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
    }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (isCasting || event.button !== 0) return

    event.currentTarget.setPointerCapture(event.pointerId)
    const stroke = [getPoint(event)]
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
      const point = {
        x: (pointerEvent.clientX - bounds.left) / bounds.width,
        y: (pointerEvent.clientY - bounds.top) / bounds.height,
      }
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

  return (
    <main className="spell-arena">
      <video
        ref={videoRef}
        className="camera-feed"
        autoPlay
        muted
        playsInline
        aria-label="Your camera preview"
      />

      <div className="camera-shade" aria-hidden="true" />

      <p className={`server-status server-status--${serverState}`}>
        {serverState === 'connected'
          ? 'Arena connected'
          : serverState === 'connecting'
            ? 'Connecting to arena…'
            : 'Arena offline'}
      </p>

      {notice ? (
        <section
          className={`cast-notice cast-notice--${notice.tone}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="cast-notice__icon" aria-hidden="true">
            {notice.tone === 'checking' ? (
              <span className="cast-notice__spinner" />
            ) : notice.tone === 'success' ? (
              <svg viewBox="0 0 24 24">
                <path d="m6.5 12.5 3.2 3.2 7.8-8" />
              </svg>
            ) : notice.tone === 'opponent' ? (
              <svg viewBox="0 0 24 24">
                <path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z" />
                <path d="m18.5 16 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24">
                <path d="m8 8 8 8M16 8l-8 8" />
              </svg>
            )}
          </span>
          <span className="cast-notice__copy">
            <strong>{notice.title}</strong>
            <span>{notice.detail}</span>
          </span>
        </section>
      ) : null}

      {cameraState !== 'ready' ? (
        <section className="camera-message" aria-live="polite">
          <div className="camera-message__icon">
            <CameraOffIcon />
          </div>
          <h1>
            {cameraState === 'requesting'
              ? 'Summoning your camera…'
              : 'Camera access is off'}
          </h1>
          <p>
            {cameraState === 'requesting'
              ? 'Allow camera access to enter the arena.'
              : 'Allow camera access in your browser, then try again.'}
          </p>
          {cameraState === 'blocked' ? (
            <button className="retry-button" type="button" onClick={startCamera}>
              Try again
            </button>
          ) : null}
        </section>
      ) : null}

      <canvas
        ref={canvasRef}
        className={`drawing-layer${isCasting ? ' drawing-layer--casting' : ''}`}
        aria-label="Spell drawing canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
      />

      <div className="controls" aria-label="Drawing controls">
        <button
          className="control-button control-button--clear"
          type="button"
          onClick={clearDrawing}
          disabled={!hasDrawing || isCasting}
        >
          Clear
        </button>
        <button
          className="control-button control-button--cast"
          type="button"
          onClick={castSpell}
          disabled={!hasDrawing || isCasting || serverState !== 'connected'}
        >
          {isCasting ? 'Casting…' : 'Cast spell'}
        </button>
      </div>
    </main>
  )
}

export default App
