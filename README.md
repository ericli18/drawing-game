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
{"type":"cast","strokes":[[{"x":0.1,"y":0.2},{"x":0.3,"y":0.4}]]}
```

For now, every valid cast is accepted as `mock_spell`. The caster receives a
`cast_result`, and every other WebSocket in that room receives an `effect`
event containing the drawing.
