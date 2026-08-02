import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  AmmoMeter,
  PlayerVitals,
  SpellRail,
  type SpellRailStates,
} from './GameHud'
import { useCamera, type CameraState } from './useCamera'
import { useDrawingCanvas } from './useDrawingCanvas'
import {
  type Effect,
  type PlayerState,
  type Spell,
  useGameSocket,
} from './useGameSocket'
import {
  usePersonSegmentation,
  type PersonTrackingState,
} from './usePersonSegmentation'
import { SPELL_LABELS } from './spellLabels'

/* ─────────────────────────────────────────────────────────
 * INTERACTION STORYBOARD
 *
 *    0ms   shot snaps from the weapon toward the crosshair
 *   90ms   hit, block, or reflection flare reaches full strength
 *  420ms   shot feedback clears from the camera
 *    0ms   accepted glyph flashes lime and begins fading
 *  360ms   the accepted drawing finishes clearing
 * 2300ms   transient match notice leaves the screen
 * ───────────────────────────────────────────────────────── */

const TIMING = {
  shotFeedback: 420,
  notice: 2_300,
}

const MAX_AMMO = 6
const MAX_HEALTH = 100
const SPELLS: readonly Spell[] = [
  'plus',
  'minus',
  'circle',
  'star',
  'triangle',
  'loop',
]

const SPELL_DURATION_MS: Record<Spell, number> = {
  plus: 6_000,
  minus: 5_000,
  circle: 4_000,
  star: 2_250,
  triangle: 4_000,
  loop: 0,
}

const SPELL_COOLDOWN_MS: Record<Spell, number> = {
  plus: 12_000,
  minus: 12_000,
  circle: 14_000,
  star: 15_000,
  triangle: 16_000,
  loop: 5_000,
}

const SPELL_EFFECT: Partial<Record<Spell, Effect>> = {
  plus: 'rapid',
  minus: 'slow',
  circle: 'shield',
  star: 'blind',
  triangle: 'reflect',
}

const EFFECT_LABELS: Record<Effect, string> = {
  rapid: 'Rapid',
  slow: 'Slowed',
  shield: 'Shield',
  blind: 'Blinded',
  reflect: 'Reflect',
}

type NoticeTone = 'neutral' | 'success' | 'danger'

type MatchNotice = {
  id: number
  tone: NoticeTone
  title: string
  detail?: string
}

type ShotFeedback = {
  id: number
  direction: 'outgoing' | 'incoming'
  outcome: 'hit' | 'blocked' | 'reflected' | 'missed'
}

export interface GameArenaProps {
  roomCode: string
  playerId: string
  onLeave: () => void
  game: ReturnType<typeof useGameSocket>
}

function rejectionCopy(reason?: string) {
  if (reason === 'out_of_ammo') return 'Draw the reload loop before firing again.'
  if (reason === 'fire_rate_limited') return 'Your blaster is still cycling.'
  if (reason === 'game_not_active') return 'Wait for your rival to join.'
  if (reason === 'players_not_ready') return 'Both cameras must be ready.'
  if (reason === 'game_countdown') return 'Hold fire until the countdown ends.'
  if (reason === 'opponent_disconnected') return 'Wait for your rival to reconnect.'
  if (reason === 'spell_cooldown') return 'That glyph is still cooling down.'
  if (reason === 'ammo_full') return 'Your blaster is already fully loaded.'
  return 'That action is not available yet.'
}

function castFailureCopy(reason?: string, retryAfterMs?: number) {
  if (reason === 'players_not_ready') return 'Both cameras must be ready.'
  if (reason === 'game_countdown') return 'Wait for the countdown to finish.'
  if (reason === 'opponent_disconnected') return 'Wait for your rival to reconnect.'
  if (reason === 'spell_cooldown') {
    const seconds = Math.max(1, Math.ceil((retryAfterMs ?? 0) / 1_000))
    return `That glyph needs ${seconds}s more.`
  }
  if (reason === 'ammo_full') return 'Your blaster is already fully loaded.'
  if (reason === 'ambiguous') return 'The shape matches more than one glyph.'
  if (reason === 'invalid_drawing') return 'Draw one complete glyph, then cast.'
  return 'The glyph was not recognized. Adjust it and try again.'
}

function useTicker(enabled: boolean) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!enabled) return
    const timer = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(timer)
  }, [enabled])

  return now
}

function activeEffects(player: PlayerState | undefined, now: number) {
  if (!player) return []
  return (Object.entries(player.effects) as [Effect, number][]).filter(
    ([, expiresAt]) => expiresAt > now,
  )
}

function StatusChips({
  player,
  now,
  align,
}: {
  player?: PlayerState
  now: number
  align: 'left' | 'right'
}) {
  const effects = activeEffects(player, now)
  if (effects.length === 0) return null

  return (
    <ul className={`status-chips status-chips--${align}`} aria-label="Effects">
      {effects.map(([effect, expiresAt]) => (
        <li className="status-chip" key={effect}>
          <span>{EFFECT_LABELS[effect]}</span>
          <time>{Math.ceil((expiresAt - now) / 1_000)}s</time>
        </li>
      ))}
    </ul>
  )
}

function buildSpellRailStates(
  player: PlayerState | undefined,
  opponent: PlayerState | undefined,
  now: number,
): SpellRailStates {
  if (!player) return {}

  return Object.fromEntries(
    SPELLS.map((spell) => {
      const effect = SPELL_EFFECT[spell]
      const effectOwner = spell === 'minus' || spell === 'star' ? opponent : player
      const activeUntil = effect ? (effectOwner?.effects[effect] ?? 0) : 0
      const cooldownUntil = player.cooldowns[spell]

      if (activeUntil > now) {
        const remaining = activeUntil - now
        return [
          spell,
          {
            phase: 'active',
            remainingProgress: remaining / SPELL_DURATION_MS[spell],
            remainingSeconds: remaining / 1_000,
          },
        ]
      }

      if (cooldownUntil > now) {
        const remaining = cooldownUntil - now
        return [
          spell,
          {
            phase: 'cooldown',
            remainingProgress: remaining / SPELL_COOLDOWN_MS[spell],
            remainingSeconds: remaining / 1_000,
          },
        ]
      }

      return [spell, { phase: 'ready' }]
    }),
  ) as SpellRailStates
}

function WaitingRoom({
  roomCode,
  localReady,
  opponentPresent,
  opponentConnected,
  opponentReady,
  cameraState,
  targetingState,
  onCopy,
  onLeave,
  onRetryCamera,
  onRetryTargeting,
}: {
  roomCode: string
  localReady: boolean
  opponentPresent: boolean
  opponentConnected: boolean
  opponentReady: boolean
  cameraState: CameraState
  targetingState: PersonTrackingState
  onCopy: () => void
  onLeave: () => void
  onRetryCamera: () => void
  onRetryTargeting: () => void
}) {
  const localStatus = localReady
    ? 'Ready'
    : cameraState === 'blocked'
      ? 'Camera off'
      : cameraState === 'idle'
        ? 'Camera needed'
        : targetingState === 'error'
          ? 'Target scan off'
        : 'Setting up…'
  const opponentStatus = !opponentPresent
    ? 'Waiting…'
    : !opponentConnected
      ? 'Reconnecting…'
    : opponentReady
      ? 'Ready'
      : 'Setting up…'

  return (
    <section
      className="waiting-room"
      aria-labelledby="waiting-title"
    >
      <p className="waiting-room__eyebrow">Private duel</p>
      <h1 id="waiting-title">
        {opponentPresent ? 'Prepare to duel' : 'Invite your rival'}
      </h1>
      <p className="waiting-room__copy">
        Open Spellshot on their phone and enter this room code.
      </p>
      <button
        className="room-code"
        type="button"
        onClick={onCopy}
        aria-label={`Copy room code ${roomCode}`}
      >
        <span>{roomCode}</span>
        <small>Tap to copy</small>
      </button>
      <ol className="player-slots" aria-label="Players in room">
        <li className={`player-slot${localReady ? ' player-slot--ready' : ''}`}>
          <span className="player-slot__marker" aria-hidden="true" />
          <span>You</span>
          <strong>{localStatus}</strong>
        </li>
        <li
          className={`player-slot${
            opponentReady ? ' player-slot--ready' : ''
          }`}
        >
          <span className="player-slot__marker" aria-hidden="true" />
          <span>Rival</span>
          <strong>{opponentStatus}</strong>
        </li>
      </ol>
      {cameraState === 'idle' || cameraState === 'blocked' ? (
        <button className="primary-button" type="button" onClick={onRetryCamera}>
          {cameraState === 'blocked' ? 'Try camera again' : 'Enable camera'}
        </button>
      ) : null}
      {cameraState === 'ready' && targetingState === 'error' ? (
        <button
          className="primary-button"
          type="button"
          onClick={onRetryTargeting}
        >
          Retry target scan
        </button>
      ) : null}
      <button className="text-button" type="button" onClick={onLeave}>
        Leave room
      </button>
    </section>
  )
}

export function GameArena({
  roomCode,
  playerId,
  onLeave,
  game,
}: GameArenaProps) {
  const connectionState = game.connectionState
  const sendReady = game.setReady
  const cameraEnabled = Boolean(game.gameState)
  const [cameraStarted, setCameraStarted] = useState(false)
  const { videoRef, cameraState, startCamera } = useCamera(
    cameraEnabled && cameraStarted,
  )
  const {
    targetLocked,
    personTrackingState,
    retryPersonTracking,
  } = usePersonSegmentation(videoRef, cameraState === 'ready')
  const [notice, setNotice] = useState<MatchNotice | null>(null)
  const [shotFeedback, setShotFeedback] = useState<ShotFeedback | null>(null)
  const noticeTimerRef = useRef(0)
  const feedbackTimerRef = useRef(0)
  const handledCastRef = useRef(0)
  const handledEventRef = useRef(0)
  const handledRejectionRef = useRef(0)
  const handledSocketErrorRef = useRef(0)
  const now = useTicker(Boolean(game.gameState)) + game.serverClockOffset
  const state = game.gameState
  const localPlayer = state?.players.find(
    (player) => player.playerId === playerId,
  )
  const opponent = state?.players.find((player) => player.playerId !== playerId)
  const connectedPlayers = state?.players.filter((player) => player.connected)
    .length ?? 1
  const isPlaying = state?.phase === 'playing'
  const matchLive = Boolean(
    isPlaying && state && (state.startsAt === 0 || state.startsAt <= now),
  )
  const targetingReady =
    cameraState === 'ready' &&
    personTrackingState === 'tracking'
  const serverReady = localPlayer?.ready
  const playerReady = targetingReady && targetLocked
  const canFire = Boolean(
    matchLive &&
      localPlayer &&
      localPlayer.ammo > 0 &&
      localPlayer.nextShotAt <= now &&
      game.connectionState === 'connected',
  )
  const spellStates = useMemo(
    () => buildSpellRailStates(localPlayer, opponent, now),
    [localPlayer, now, opponent],
  )
  const {
    canvasRef,
    hasDrawing,
    isCasting,
    handlePointerDown,
    handlePointerMove,
    finishStroke,
    clearDrawing,
    prepareCast,
    resolveCast,
  } = useDrawingCanvas(matchLive)

  useEffect(() => {
    if (
      connectionState !== 'connected' ||
      serverReady === undefined ||
      serverReady === targetingReady
    ) {
      return
    }
    sendReady(targetingReady)
  }, [connectionState, sendReady, serverReady, targetingReady])

  useEffect(() => {
    if (state?.phase === 'playing' && state.startsAt === 0) return
    clearDrawing()
  }, [clearDrawing, state?.phase, state?.startsAt])

  const showNotice = useCallback(
    (title: string, detail?: string, tone: NoticeTone = 'neutral') => {
      window.clearTimeout(noticeTimerRef.current)
      setNotice({ id: Date.now(), tone, title, detail })
      noticeTimerRef.current = window.setTimeout(
        () => setNotice(null),
        TIMING.notice,
      )
    },
    [],
  )

  useEffect(
    () => () => {
      window.clearTimeout(noticeTimerRef.current)
      window.clearTimeout(feedbackTimerRef.current)
    },
    [],
  )

  const handleFire = useCallback(() => {
    if (!canFire) {
      if ((localPlayer?.ammo ?? 0) === 0) {
        showNotice('Blaster empty', 'Draw the reload loop.', 'danger')
      } else if (!matchLive) {
        showNotice('Hold fire', 'The duel has not started yet.')
      } else if ((localPlayer?.nextShotAt ?? 0) > now) {
        showNotice('Blaster cycling', 'Your next shot is charging.')
      } else if (connectionState !== 'connected') {
        showNotice('Arena offline', 'Reconnecting…', 'danger')
      }
      return
    }

    if (!game.fire(playerReady)) {
      showNotice('Arena offline', 'Reconnecting…', 'danger')
    }
  }, [
    canFire,
    connectionState,
    game,
    localPlayer?.ammo,
    localPlayer?.nextShotAt,
    matchLive,
    now,
    playerReady,
    showNotice,
  ])

  const handleCast = useCallback(() => {
    const payload = prepareCast()
    if (!payload) return
    if (!game.cast(payload)) {
      resolveCast(false)
      showNotice('Arena offline', 'Your drawing is safe. Reconnecting…', 'danger')
    }
  }, [game, prepareCast, resolveCast, showNotice])

  useEffect(() => {
    const result = game.castResult
    if (!result || result.sequence === handledCastRef.current) return
    handledCastRef.current = result.sequence
    resolveCast(result.accepted)

    if (result.accepted) {
      const effect = result.drawingType
        ? SPELL_LABELS[result.drawingType]
        : 'Spell'
      showNotice(effect, undefined, 'success')
    } else {
      showNotice(
        'Glyph rejected',
        castFailureCopy(result.reason, result.retryAfterMs),
        'danger',
      )
    }
  }, [game.castResult, resolveCast, showNotice])

  useEffect(() => {
    if (!isCasting || game.connectionState !== 'offline') return
    resolveCast(false)
    showNotice(
      'Cast interrupted',
      'Your drawing is safe. Reconnecting…',
      'danger',
    )
  }, [game.connectionState, isCasting, resolveCast, showNotice])

  useEffect(() => {
    const event = game.gameEvent
    if (!event || event.sequence === handledEventRef.current) return
    handledEventRef.current = event.sequence

    if (event.event === 'shot' && event.outcome) {
      const direction =
        event.sourcePlayerId === playerId ? 'outgoing' : 'incoming'
      setShotFeedback({ id: event.sequence, direction, outcome: event.outcome })
      window.clearTimeout(feedbackTimerRef.current)
      feedbackTimerRef.current = window.setTimeout(
        () => setShotFeedback(null),
        TIMING.shotFeedback,
      )

      if (event.damagedPlayerId === playerId) {
        showNotice(
          event.outcome === 'reflected' ? 'Shot reflected back' : 'You were tagged',
          `${event.damage ?? 0} damage`,
          'danger',
        )
      } else if (direction === 'incoming' && event.outcome === 'blocked') {
        showNotice('Shield held', 'No damage', 'success')
      } else if (direction === 'incoming' && event.outcome === 'reflected') {
        showNotice('Reflection landed', 'The shot returned to your rival.', 'success')
      }
    } else if (
      event.event === 'spell_cast' &&
      event.sourcePlayerId !== playerId &&
      event.spell
    ) {
      showNotice(
        `Incoming ${event.spell}`,
        event.spell === 'star' ? 'Your vision is compromised.' : 'Rival cast a glyph.',
        'danger',
      )
    } else if (event.event === 'rematch_requested') {
      showNotice('Rematch requested', 'Both players must lock it in.')
    }
  }, [game.gameEvent, playerId, showNotice])

  useEffect(() => {
    const rejection = game.actionRejection
    if (!rejection || rejection.sequence === handledRejectionRef.current) return
    handledRejectionRef.current = rejection.sequence
    const actionLabel =
      rejection.action === 'fire'
        ? 'Shot'
        : rejection.action === 'ready'
          ? 'Readiness'
          : 'Rematch'
    showNotice(
      `${actionLabel} unavailable`,
      rejectionCopy(rejection.reason),
      'danger',
    )
  }, [game.actionRejection, showNotice])

  useEffect(() => {
    const error = game.socketError
    if (!error || error.sequence === handledSocketErrorRef.current) return
    handledSocketErrorRef.current = error.sequence
    if (isCasting) resolveCast(false)
    showNotice('Server rejected the action', error.message, 'danger')
  }, [game.socketError, isCasting, resolveCast, showNotice])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        target?.matches(
          'button, a, input, textarea, select, [contenteditable="true"]',
        )
      ) {
        return
      }

      if (event.key === 'Escape') {
        clearDrawing()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        handleCast()
      } else if (event.code === 'Space') {
        event.preventDefault()
        handleFire()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [clearDrawing, handleCast, handleFire])

  const copyRoomCode = () => {
    if (!navigator.clipboard) {
      showNotice('Room code', roomCode)
      return
    }
    void navigator.clipboard.writeText(roomCode).then(
      () => showNotice('Room code copied', roomCode, 'success'),
      () => showNotice('Room code', roomCode),
    )
  }

  const enableCamera = () => {
    if (!cameraStarted) setCameraStarted(true)
    else void startCamera()
  }

  const localBlindUntil = localPlayer?.effects.blind ?? 0
  const isBlinded = localBlindUntil > now
  const winnerIsLocal = state?.winnerId === playerId

  return (
    <main
      className="game-arena"
      data-shot-outcome={shotFeedback?.outcome}
      data-shot-direction={shotFeedback?.direction}
    >
      <video
        ref={videoRef}
        className="camera-feed"
        autoPlay
        muted
        playsInline
        aria-label="Rear camera view"
      />
      <div className="camera-shade" aria-hidden="true" />

      <header className="match-hud">
        <div className="match-hud__player match-hud__player--local">
          <PlayerVitals
            className="player-vitals--local"
            label="You"
            health={localPlayer?.health ?? MAX_HEALTH}
          />
          <StatusChips player={localPlayer} now={now} align="left" />
        </div>
        <div className="match-mark" aria-label={`Room ${roomCode}`}>
          <span className="match-mark__logo">S/S</span>
          <span
            className={`connection-dot connection-dot--${game.connectionState}`}
            title={game.connectionState}
          />
          <button
            className="match-mark__leave"
            type="button"
            onClick={onLeave}
          >
            Exit
          </button>
        </div>
        <div className="match-hud__player match-hud__player--opponent">
          <PlayerVitals
            className="player-vitals--opponent"
            label="Rival"
            health={opponent?.health ?? MAX_HEALTH}
          />
          <StatusChips player={opponent} now={now} align="right" />
        </div>
      </header>

      <SpellRail states={spellStates} />

      <div className="aim-layer" aria-hidden="true">
        <span
          className={`reticle${playerReady ? ' reticle--locked' : ''}`}
        >
          <i />
        </span>
      </div>

      <canvas
        ref={canvasRef}
        className={`drawing-layer${isCasting ? ' drawing-layer--casting' : ''}`}
        aria-label="Spell drawing canvas"
        aria-disabled={!matchLive}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishStroke}
        onPointerCancel={finishStroke}
      />

      {hasDrawing ? (
        <div className="cast-tray" aria-label="Glyph controls">
          <button
            className="secondary-button"
            type="button"
            disabled={isCasting}
            onClick={clearDrawing}
          >
            Clear
            <kbd>Esc</kbd>
          </button>
          <button
            className="cast-button"
            type="button"
            disabled={isCasting || !matchLive}
            onClick={handleCast}
          >
            {isCasting ? 'Reading…' : 'Cast glyph'}
            <kbd>Enter</kbd>
          </button>
        </div>
      ) : null}

      <section className="combat-controls" aria-label="Blaster controls">
        <AmmoMeter ammo={localPlayer?.ammo ?? MAX_AMMO} />
        <button
          className="fire-button"
          type="button"
          aria-describedby="fire-help"
          aria-disabled={!canFire}
          onClick={handleFire}
        >
          <span>Fire</span>
          <kbd>Space</kbd>
        </button>
        <span className="sr-only" id="fire-help">
          Shots without a target lock miss and still spend ammo.
        </span>
      </section>

      {shotFeedback ? (
        <div
          className={`shot-feedback shot-feedback--${shotFeedback.direction} shot-feedback--${shotFeedback.outcome}`}
          key={shotFeedback.id}
          aria-hidden="true"
        >
          <span className="shot-feedback__beam" />
          <span className="shot-feedback__impact" />
        </div>
      ) : null}

      {notice ? (
        <section
          className={`match-notice match-notice--${notice.tone}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          key={notice.id}
        >
          <strong>{notice.title}</strong>
          {notice.detail ? <span>{notice.detail}</span> : null}
        </section>
      ) : null}

      {matchLive &&
      (cameraState === 'requesting' ||
        cameraState === 'blocked' ||
        personTrackingState === 'error') ? (
        <section className="camera-message" aria-live="polite">
          <span className="camera-message__target" aria-hidden="true" />
          <h1>
            {cameraState === 'requesting'
              ? 'Opening your camera'
              : personTrackingState === 'error'
                ? 'Target scan unavailable'
                : 'Camera access is off'}
          </h1>
          <p>
            {cameraState === 'requesting'
              ? 'Your rear camera turns the room into the arena.'
              : personTrackingState === 'error'
                ? 'Restart the on-device rival scan to keep playing.'
                : 'Allow camera access, then try again.'}
          </p>
          {cameraState === 'blocked' || personTrackingState === 'error' ? (
            <button
              className="primary-button"
              type="button"
              onClick={
                personTrackingState === 'error'
                  ? retryPersonTracking
                  : startCamera
              }
            >
              {personTrackingState === 'error'
                ? 'Retry target scan'
                : 'Try camera again'}
            </button>
          ) : null}
        </section>
      ) : null}

      {!state ? (
        <section className="arena-loading" aria-live="polite">
          <p className="waiting-room__eyebrow">Room {roomCode}</p>
          <h1>Entering the arena</h1>
          <p>Connecting your blaster to the match…</p>
          <button className="text-button" type="button" onClick={onLeave}>
            Cancel
          </button>
        </section>
      ) : null}

      {state &&
      state.phase !== 'finished' &&
      (state.phase === 'waiting' ||
        connectedPlayers < 2 ||
        !localPlayer?.ready ||
        !opponent?.ready) ? (
        <WaitingRoom
          roomCode={roomCode}
          localReady={localPlayer?.ready ?? false}
          opponentPresent={Boolean(opponent)}
          opponentConnected={opponent?.connected ?? false}
          opponentReady={opponent?.ready ?? false}
          cameraState={cameraState}
          targetingState={personTrackingState}
          onCopy={copyRoomCode}
          onLeave={onLeave}
          onRetryCamera={enableCamera}
          onRetryTargeting={retryPersonTracking}
        />
      ) : null}

      {state?.phase === 'playing' && state.startsAt > now ? (
        <div className="countdown-overlay" role="status" aria-live="assertive">
          <span>{Math.ceil((state.startsAt - now) / 1_000)}</span>
          <small>Get ready</small>
        </div>
      ) : null}

      {state?.phase === 'finished' ? (
        <section
          className="results-screen"
          aria-labelledby="result-title"
        >
          <p className="results-screen__eyebrow">Match complete</p>
          <h1 id="result-title">{winnerIsLocal ? 'Victory' : 'Tagged out'}</h1>
          <p>
            {winnerIsLocal
              ? 'Your last shot landed. Run it back?'
              : 'Your rival took the round. Reset and retaliate.'}
          </p>
          <div className="results-screen__actions">
            <button
              className="primary-button"
              type="button"
              aria-disabled={localPlayer?.wantsRematch}
              onClick={() => {
                if (!localPlayer?.wantsRematch) game.requestRematch()
              }}
            >
              {localPlayer?.wantsRematch ? 'Waiting for rival…' : 'Rematch'}
            </button>
            <button className="text-button" type="button" onClick={onLeave}>
              Leave room
            </button>
          </div>
        </section>
      ) : null}

      {game.connectionState === 'offline' ? (
        <p className="offline-banner" role="status">
          Connection lost. Rejoining…
        </p>
      ) : null}

      {isBlinded ? <div className="blind-overlay" aria-hidden="true" /> : null}
      <p className="sr-only" aria-live="assertive">
        {isBlinded ? 'You are blinded.' : ''}
      </p>
    </main>
  )
}
