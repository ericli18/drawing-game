## Run locally

Start the backend:

```sh
cd server
uv sync
uv run uvicorn app.main:app --reload
```

In another terminal, start the mock opponent. It joins the demo room and prints
every effect routed to it:

```sh
cd server
uv run python mock_opponent.py
```

Then start the browser client:

```sh
cd client
npm install
npm run dev
```

The client connects to `/ws/demo-room/player-one` on the current origin by
default. During development, Vite proxies `/ws` to `ws://127.0.0.1:8000`. Set
`VITE_WS_URL` to override the full WebSocket URL.

## WebSocket protocol

Clients connect at `/ws/{room_id}/{player_id}` and cast normalized canvas
points with:

```json
{"type":"cast","strokes":[[{"x":0.1,"y":0.2},{"x":0.3,"y":0.4}]],"aspectRatio":0.5625}
```

`aspectRatio` is the drawing canvas width divided by its height. It lets the
server undo the visual distortion caused by normalizing each axis separately.

The server recognizes `plus`, `circle`, and `star` drawings. An accepted cast
returns its recognized type and score:

```json
{"type":"cast_result","accepted":true,"spellId":"...","drawingType":"plus","score":0.97}
```

A drawing that does not confidently match returns `accepted: false` with a
`no_match`, `ambiguous`, or `invalid_drawing` reason. Only accepted casts send
an `effect` event to the other WebSocket in the room.
