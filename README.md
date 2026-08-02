# SPELLSHOT

SPELLSHOT is a two-player AR laser-tag game where hand-drawn glyphs change the
duel. Both players join the same private room, point their rear cameras at each
other, and fire. Shots only damage the rival while the on-device person scan
has exactly one target centered beneath the crosshair; firing without a lock
misses and still spends ammo.

The FastAPI server is authoritative for health, ammo, fire rate, spell timers,
cooldowns, reflection, victory, and rematches. Camera video and person masks
stay on each device.

## Play

1. One player selects **Create duel** and shares the five-character room code.
2. The other selects **Join duel** and enters that code.
3. Select **Enable camera** in the room, allow rear-camera access, and wait for
   the private on-device target scan to become ready.
4. Once both players are ready, a server-timed three-second countdown begins.
5. Keep one rival centered and use **Fire** (or <kbd>Space</kbd>) to shoot. Each
   blaster holds six shots, and unlocked shots miss but still spend ammo.
6. Draw a glyph directly on the camera view at any time, then cast with
   **Cast glyph** or <kbd>Enter</kbd>; clear with **Clear** or <kbd>Escape</kbd>.

| Glyph | Effect | Active | Cooldown |
| --- | --- | ---: | ---: |
| Plus | Your blaster fires faster | 6s | 12s |
| Minus | Rival's blaster fires slower | 5s | 12s |
| Circle | Blocks incoming shots | 4s | 14s |
| Star | Whites out the rival's screen | 2.25s | 15s |
| Triangle | Reflects incoming shots | 4s | 16s |
| Lasso loop | Refills all six shots | Instant | 5s |

The reload glyph is deliberately a closed loop with a short lower-right tail,
which keeps it distinct from the shield circle.

## Run locally

Start the backend:

```sh
cd server
uv sync
uv run uvicorn app.main:app --reload
```

Start the client in another terminal:

```sh
cd client
npm install
npm run dev
```

Open the client on two browser sessions and join the same room. Vite proxies
`/ws` to `ws://127.0.0.1:8000` in development.

For a separately hosted backend, `VITE_WS_URL` can be either a WebSocket origin
such as `wss://game.example.com` or a full template containing `{roomId}` and
`{playerId}`. Browsers require HTTPS for camera access away from localhost.

## Verify

```sh
cd server && uv run pytest
cd client && npm run lint && npm run build
```

The server tests cover recognition for all six glyphs, authenticated two-player
rooms, ready/countdown gating, combat, timing, every spell, reconnect grace,
explicit leave, game-over, reload, reflection, and rematch reset.

## Architecture

- `server/app/game.py` contains pure, deterministic game rules.
- `server/app/protocol.py` validates client WebSocket messages.
- `server/app/main.py` owns rooms, connections, and state broadcasts.
- `client/src/useGameSocket.ts` translates the protocol into React state.
- `client/src/useDrawingCanvas.ts` owns high-frequency canvas input in refs.
- `client/src/GameArena.tsx` composes camera targeting, HUD, drawing, and match
  feedback.

Rooms are intentionally in memory for this checkpoint. A disconnected slot is
reserved for 30 seconds; **Leave room** frees it immediately. Rooms do not
survive a server restart, and a production multi-process deployment will need
shared room storage plus server-issued player authentication.
