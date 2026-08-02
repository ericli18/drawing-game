import './App.css'
import { useCamera } from './useCamera'
import { useSpellArena, type Notice, type ServerState } from './useSpellArena'

const SERVER_LABELS: Record<ServerState, string> = {
  connecting: 'Connecting to arena…',
  connected: 'Arena connected',
  offline: 'Arena offline',
}

function CameraOffIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m3 3 18 18M10.6 6H5.8A2.8 2.8 0 0 0 3 8.8v6.4A2.8 2.8 0 0 0 5.8 18h10.8M21 8.4l-4 2.3v2.6l4 2.3V8.4Z" />
    </svg>
  )
}

function NoticeIcon({ tone }: { tone: Notice['tone'] }) {
  if (tone === 'checking') return <span className="cast-notice__spinner" />
  if (tone === 'success') {
    return (
      <svg viewBox="0 0 24 24">
        <path d="m6.5 12.5 3.2 3.2 7.8-8" />
      </svg>
    )
  }
  if (tone === 'opponent') {
    return (
      <svg viewBox="0 0 24 24">
        <path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z" />
        <path d="m18.5 16 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24">
      <path d="m8 8 8 8M16 8l-8 8" />
    </svg>
  )
}

function App() {
  const { videoRef, cameraState, startCamera } = useCamera()
  const {
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
  } = useSpellArena()

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
        {SERVER_LABELS[serverState]}
      </p>

      {notice ? (
        <section
          className={`cast-notice cast-notice--${notice.tone}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="cast-notice__icon" aria-hidden="true">
            <NoticeIcon tone={notice.tone} />
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
