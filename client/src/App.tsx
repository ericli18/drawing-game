import { useEffect, useState } from 'react'
import './App.css'
import { GameArena } from './GameArena'
import { LobbyScreen } from './LobbyScreen'
import { useGameSocket } from './useGameSocket'

const ROOM_CODE_LENGTH = 5
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const PLAYER_ID_KEY = 'shotta-flow-player-id'
const PLAYER_TOKEN_KEY = 'shotta-flow-player-token'

type RoomEntry = {
  code: string
  create: boolean
}

function randomToken(length: number, alphabet = ROOM_ALPHABET) {
  const values = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join(
    '',
  )
}

function getPlayerId() {
  const existing = window.sessionStorage.getItem(PLAYER_ID_KEY)
  if (existing) return existing
  const playerId = `player-${randomToken(10).toLowerCase()}`
  window.sessionStorage.setItem(PLAYER_ID_KEY, playerId)
  return playerId
}

function getPlayerToken() {
  const existing = window.sessionStorage.getItem(PLAYER_TOKEN_KEY)
  if (existing) return existing
  const token = randomToken(24)
  window.sessionStorage.setItem(PLAYER_TOKEN_KEY, token)
  return token
}

function roomFromUrl(): RoomEntry | null {
  const room = new URLSearchParams(window.location.search)
    .get('room')
    ?.toUpperCase()
  return room?.length === ROOM_CODE_LENGTH
    ? { code: room, create: false }
    : null
}

function setRoomInUrl(roomCode: string | null) {
  const url = new URL(window.location.href)
  if (roomCode) url.searchParams.set('room', roomCode)
  else url.searchParams.delete('room')
  window.history.replaceState({}, '', url)
}

function App() {
  const [playerId] = useState(getPlayerId)
  const [playerToken] = useState(getPlayerToken)
  const [roomEntry, setRoomEntry] = useState<RoomEntry | null>(roomFromUrl)
  const [lobbyError, setLobbyError] = useState<string | null>(null)
  const roomCode = roomEntry?.code ?? null
  const game = useGameSocket(
    roomCode,
    playerId,
    playerToken,
    roomEntry?.create,
  )

  useEffect(() => {
    const errors = {
      full: 'That room already has two players. Try another code.',
      missing: 'No duel uses that code. Check it and try again.',
      exists: 'That room code was just claimed. Create another duel.',
      unauthorized: 'This player slot belongs to another session.',
      replaced: 'This player is already active in another tab.',
    } as const
    if (!(game.connectionState in errors)) return
    setLobbyError(errors[game.connectionState as keyof typeof errors])
    setRoomEntry(null)
    setRoomInUrl(null)
  }, [game.connectionState])

  const enterRoom = (code: string, create = false) => {
    setLobbyError(null)
    setRoomEntry({ code, create })
    setRoomInUrl(code)
  }

  const createRoom = () => enterRoom(randomToken(ROOM_CODE_LENGTH), true)

  const leaveRoom = () => {
    game.leave()
    setRoomEntry(null)
    setRoomInUrl(null)
  }

  if (!roomCode) {
    return (
      <main className="app-shell">
        <div className="lobby-backdrop" aria-hidden="true">
          <span className="lobby-backdrop__plus">+</span>
          <span className="lobby-backdrop__circle" />
          <span className="lobby-backdrop__triangle" />
          <span className="lobby-backdrop__line" />
        </div>
        <LobbyScreen
          onCreate={createRoom}
          onJoin={enterRoom}
          connecting={false}
          error={lobbyError}
        />
      </main>
    )
  }

  return (
    <GameArena
      roomCode={roomCode}
      playerId={playerId}
      game={game}
      onLeave={leaveRoom}
    />
  )
}

export default App
