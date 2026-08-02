import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

type CameraState = 'requesting' | 'ready' | 'blocked'

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

function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const strokesRef = useRef<Stroke[]>([])
  const activeStrokeRef = useRef<Stroke | null>(null)
  const castTimeoutRef = useRef<number | null>(null)
  const cameraRequestRef = useRef(0)

  const [cameraState, setCameraState] = useState<CameraState>('requesting')
  const [hasDrawing, setHasDrawing] = useState(false)
  const [isCasting, setIsCasting] = useState(false)
  const [announcement, setAnnouncement] = useState('')

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

  const castSpell = () => {
    if (!hasDrawing || isCasting) return

    setIsCasting(true)
    setAnnouncement('Spell cast')
    castTimeoutRef.current = window.setTimeout(() => {
      clearDrawing()
      setIsCasting(false)
      setAnnouncement('Canvas cleared. Draw your next spell.')
    }, 650)
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
          disabled={!hasDrawing || isCasting}
        >
          {isCasting ? 'Casting…' : 'Cast spell'}
        </button>
      </div>

      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </main>
  )
}

export default App
