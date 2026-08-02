import { useCallback, useEffect, useRef, useState } from 'react'
import type { CastPayload } from './useDrawingCanvas'

export type Spell =
  | 'plus'
  | 'minus'
  | 'circle'
  | 'star'
  | 'triangle'
  | 'loop'

export type Effect = 'rapid' | 'slow' | 'shield' | 'blind' | 'reflect'
export type MatchPhase = 'waiting' | 'playing' | 'finished'
export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'offline'
  | 'full'
  | 'missing'
  | 'exists'
  | 'replaced'
  | 'unauthorized'

export type PlayerState = {
  playerId: string
  connected: boolean
  ready: boolean
  health: number
  ammo: number
  nextShotAt: number
  effects: Record<Effect, number>
  cooldowns: Record<Spell, number>
  wantsRematch: boolean
}

export type GameState = {
  serverTime: number
  revision: number
  roomId: string
  phase: MatchPhase
  startsAt: number
  winnerId: string | null
  players: PlayerState[]
}

export type CastResult = {
  sequence: number
  accepted: boolean
  drawingType?: Spell
  reason?: string
  retryAfterMs?: number
}

export type GameEvent = {
  sequence: number
  event: 'shot' | 'spell_cast' | 'rematch_requested' | 'rematch_started'
  sourcePlayerId?: string
  targetPlayerId?: string
  damagedPlayerId?: string
  outcome?: 'hit' | 'blocked' | 'reflected' | 'missed'
  damage?: number
  spell?: Spell
  durationMs?: number
}

export type ActionRejection = {
  sequence: number
  action: 'fire' | 'rematch' | 'ready'
  reason: string
  retryAfterMs?: number
}

export type SocketError = {
  sequence: number
  code: string
  message: string
}

const RECONNECT_DELAY_MS = 1_200

function socketUrl(
  roomCode: string,
  playerId: string,
  playerToken: string,
  createRoom: boolean,
) {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const path = `/ws/${encodeURIComponent(roomCode)}/${encodeURIComponent(playerId)}`
  const override = import.meta.env.VITE_WS_URL as string | undefined

  let url: string
  if (!override) {
    url = `${protocol}://${window.location.host}${path}`
  } else if (
    override.includes('{roomId}') ||
    override.includes('{playerId}')
  ) {
    url = override
      .replace('{roomId}', encodeURIComponent(roomCode))
      .replace('{playerId}', encodeURIComponent(playerId))
  } else {
    url = `${override.replace(/\/$/, '')}${path}`
  }

  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}token=${encodeURIComponent(playerToken)}${
    createRoom ? '&create=1' : ''
  }`
}

export function useGameSocket(
  roomCode: string | null,
  playerId: string,
  playerToken: string,
  createRoom = false,
) {
  const socketRef = useRef<WebSocket | null>(null)
  const sequenceRef = useRef(0)
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('idle')
  const [gameState, setGameState] = useState<GameState | null>(null)
  const [serverClockOffset, setServerClockOffset] = useState(0)
  const [castResult, setCastResult] = useState<CastResult | null>(null)
  const [gameEvent, setGameEvent] = useState<GameEvent | null>(null)
  const [actionRejection, setActionRejection] =
    useState<ActionRejection | null>(null)
  const [socketError, setSocketError] = useState<SocketError | null>(null)

  useEffect(() => {
    setGameState(null)
    setCastResult(null)
    setGameEvent(null)
    setActionRejection(null)
    setSocketError(null)

    if (!roomCode) {
      setConnectionState('idle')
      return
    }

    let disposed = false
    let reconnectTimer = 0
    let createOnNextConnection = createRoom

    const connect = () => {
      if (disposed) return
      setConnectionState('connecting')
      const socket = new WebSocket(
        socketUrl(roomCode, playerId, playerToken, createOnNextConnection),
      )
      socketRef.current = socket

      socket.addEventListener('open', () => {
        if (socketRef.current === socket) setConnectionState('connected')
      })

      socket.addEventListener('message', (messageEvent) => {
        if (socketRef.current !== socket) return

        let message: Record<string, unknown>
        try {
          message = JSON.parse(messageEvent.data as string) as Record<
            string,
            unknown
          >
        } catch {
          return
        }

        const type = message.type
        if (type === 'connected') {
          createOnNextConnection = false
        } else if (type === 'game_state') {
          setGameState(message as GameState & { type: 'game_state' })
          setServerClockOffset((message.serverTime as number) - Date.now())
        } else if (type === 'cast_result') {
          setCastResult({
            sequence: ++sequenceRef.current,
            accepted: message.accepted === true,
            drawingType: message.drawingType as Spell | undefined,
            reason: message.reason as string | undefined,
            retryAfterMs: message.retryAfterMs as number | undefined,
          })
        } else if (type === 'game_event') {
          setGameEvent({
            ...(message as Omit<GameEvent, 'sequence'>),
            sequence: ++sequenceRef.current,
          })
        } else if (type === 'action_rejected') {
          setActionRejection({
            ...(message as Omit<ActionRejection, 'sequence'>),
            sequence: ++sequenceRef.current,
          })
        } else if (type === 'error') {
          const code = (message.code as string | undefined) ?? 'server_error'
          const errorMessage =
            (message.message as string | undefined) ?? 'The server rejected the message.'
          if (
            code === 'room_full' ||
            code === 'room_not_found' ||
            code === 'room_exists' ||
            code === 'invalid_reconnect'
          ) {
            disposed = true
            setConnectionState(
              code === 'room_full'
                ? 'full'
                : code === 'room_not_found'
                  ? 'missing'
                  : code === 'room_exists'
                    ? 'exists'
                    : 'unauthorized',
            )
            socket.close()
          } else {
            setSocketError({
              sequence: ++sequenceRef.current,
              code,
              message: errorMessage,
            })
          }
        }
      })

      socket.addEventListener('close', (event) => {
        if (socketRef.current === socket) socketRef.current = null
        if (disposed) return
        if (event.code === 4001) {
          disposed = true
          setConnectionState('replaced')
          return
        }
        setConnectionState('offline')
        reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS)
      })

      socket.addEventListener('error', () => {
        if (socketRef.current === socket) setConnectionState('offline')
      })
    }

    connect()

    return () => {
      disposed = true
      window.clearTimeout(reconnectTimer)
      if (socketRef.current) {
        const socket = socketRef.current
        socketRef.current = null
        socket.close()
      }
    }
  }, [createRoom, playerId, playerToken, roomCode])

  const send = useCallback((message: object) => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(message))
    return true
  }, [])

  const fire = useCallback(
    (targetLocked: boolean) => send({ type: 'fire', targetLocked }),
    [send],
  )
  const cast = useCallback(
    (payload: CastPayload) => send({ type: 'cast', ...payload }),
    [send],
  )
  const requestRematch = useCallback(
    () => send({ type: 'rematch' }),
    [send],
  )
  const setReady = useCallback(
    (ready: boolean) => send({ type: 'ready', ready }),
    [send],
  )
  const leave = useCallback(() => send({ type: 'leave' }), [send])

  return {
    connectionState,
    gameState,
    serverClockOffset,
    castResult,
    gameEvent,
    actionRejection,
    socketError,
    fire,
    cast,
    requestRematch,
    setReady,
    leave,
  }
}
