import './App.css'
import { useCamera } from './useCamera'
import {
  usePersonSegmentation,
  type PersonTrackingState,
} from './usePersonSegmentation'
import { useSpellArena } from './useSpellArena'

function getDrawingHint(state: PersonTrackingState, count: number) {
  if (state === 'loading') return 'Finding player…'
  if (state === 'error') return 'Player scan unavailable'
  if (count > 1) return 'Only one player can be in frame'
  if (count === 0) return 'Step into frame'
  return 'Draw anywhere'
}

function App() {
  const { videoRef, cameraState, startCamera } = useCamera()
  const { highlightCanvasRef, personCount, personTrackingState } =
    usePersonSegmentation(videoRef, cameraState === 'ready')
  const playerReady =
    cameraState === 'ready' &&
    personTrackingState === 'tracking' &&
    personCount === 1
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
  } = useSpellArena(playerReady)

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
      <canvas
        ref={highlightCanvasRef}
        className="person-highlight"
        aria-hidden="true"
      />

      {cameraState !== 'ready' ? (
        <section className="camera-message" aria-live="polite">
          <h1>
            {cameraState === 'requesting'
              ? 'Summoning your camera…'
              : 'Camera access is off'}
          </h1>
          <p>
            {cameraState === 'requesting'
              ? 'Allow camera access to begin.'
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
        aria-disabled={!playerReady}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
      />

      <p
        className="arena-hint"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={notice ? `${notice.title}. ${notice.detail}` : undefined}
      >
        {notice?.title ?? getDrawingHint(personTrackingState, personCount)}
      </p>

      <div className="controls" aria-label="Drawing controls">
        <button
          className="control-button control-button--clear"
          type="button"
          onClick={clearDrawing}
          disabled={!playerReady || !hasDrawing || isCasting}
        >
          Clear
        </button>
        <button
          className="control-button control-button--cast"
          type="button"
          onClick={castSpell}
          disabled={
            !playerReady ||
            !hasDrawing ||
            isCasting ||
            serverState !== 'connected'
          }
        >
          {isCasting ? 'Casting…' : 'Cast spell'}
        </button>
      </div>
    </main>
  )
}

export default App
