import { useId, useState, type FormEvent } from 'react'

const ROOM_CODE_LENGTH = 5
const ROOM_CODE_PATTERN = /^[A-Z0-9]*$/

export interface LobbyScreenProps {
  onCreate: () => void
  onJoin: (code: string) => void
  connecting: boolean
  error?: string | null
}

function normalizeRoomCode(value: string) {
  return value
    .toUpperCase()
    .split('')
    .filter((character) => ROOM_CODE_PATTERN.test(character))
    .join('')
    .slice(0, ROOM_CODE_LENGTH)
}

export function LobbyScreen({
  onCreate,
  onJoin,
  connecting,
  error,
}: LobbyScreenProps) {
  const [roomCode, setRoomCode] = useState('')
  const inputId = useId()
  const helpId = useId()
  const errorId = useId()
  const canJoin = roomCode.length === ROOM_CODE_LENGTH && !connecting

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (canJoin) onJoin(roomCode)
  }

  return (
    <section
      className="lobby-screen"
      aria-busy={connecting}
      aria-labelledby="lobby-title"
    >
      <header className="lobby-screen__header">
        <h1 className="lobby-screen__title" id="lobby-title">
          Shotta Flow
        </h1>
      </header>

      <div className="lobby-screen__actions">
        <button
          className="lobby-screen__create-button"
          type="button"
          disabled={connecting}
          onClick={onCreate}
        >
          Create duel
        </button>

        <div className="lobby-screen__divider" aria-hidden="true">
          <span>or join a room</span>
        </div>

        <form className="lobby-screen__join-form" onSubmit={handleSubmit}>
          <div className="lobby-screen__field">
            <label className="lobby-screen__label" htmlFor={inputId}>
              Room code
            </label>
            <input
              className="lobby-screen__code-input"
              id={inputId}
              name="roomCode"
              type="text"
              value={roomCode}
              maxLength={ROOM_CODE_LENGTH}
              pattern="[A-Z0-9]{5}"
              inputMode="text"
              autoCapitalize="characters"
              autoComplete="off"
              autoCorrect="off"
              enterKeyHint="go"
              spellCheck={false}
              aria-describedby={`${helpId}${error ? ` ${errorId}` : ''}`}
              aria-invalid={Boolean(error)}
              disabled={connecting}
              onChange={(event) =>
                setRoomCode(normalizeRoomCode(event.currentTarget.value))
              }
            />
            <p className="lobby-screen__field-help" id={helpId}>
              Enter the 5-character code from your rival.
            </p>
            {error ? (
              <p className="lobby-screen__error" id={errorId} role="alert">
                {error}
              </p>
            ) : null}
          </div>

          <button
            className="lobby-screen__join-button"
            type="submit"
            disabled={!canJoin}
          >
            Join duel
          </button>
        </form>
      </div>

      <p className="lobby-screen__connection-status" role="status">
        {connecting ? 'Connecting to the arena…' : ''}
      </p>
    </section>
  )
}
