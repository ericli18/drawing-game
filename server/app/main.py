import asyncio
import secrets
from dataclasses import dataclass, field
from pathlib import Path
from time import time
from uuid import uuid4

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from app.game import (
    ActionResult,
    GameState,
    add_player,
    cast_spell,
    create_game,
    fire,
    pause_game,
    remove_player,
    request_rematch,
    start_game,
)
from app.protocol import (
    CastMessage,
    FireMessage,
    LeaveMessage,
    ReadyMessage,
    RematchMessage,
    client_message_adapter,
)
from app.recognizer import recognizer


GAME_START_COUNTDOWN_MS = 3_000
RECONNECT_GRACE_MS = 30_000
SOCKET_FAILURES = (WebSocketDisconnect, RuntimeError, OSError)


def current_time_ms() -> int:
    return int(time() * 1000)


async def _safe_send(websocket: WebSocket, message: dict[str, object]) -> bool:
    try:
        await websocket.send_json(message)
        return True
    except SOCKET_FAILURES:
        return False


async def _safe_close(websocket: WebSocket, code: int, reason: str) -> None:
    try:
        await websocket.close(code=code, reason=reason)
    except SOCKET_FAILURES:
        pass


async def _send_or_disconnect(
    websocket: WebSocket, message: dict[str, object]
) -> None:
    if not await _safe_send(websocket, message):
        raise WebSocketDisconnect(code=1006)


@dataclass
class Room:
    state: GameState
    player_tokens: dict[str, str]
    connections: dict[str, WebSocket] = field(default_factory=dict)
    ready_players: set[str] = field(default_factory=set)
    starts_at_ms: int = 0
    reconnect_tasks: dict[str, asyncio.Task[None]] = field(default_factory=dict)
    revision: int = 0
    closed: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class RoomManager:
    def __init__(
        self,
        *,
        countdown_ms: int = GAME_START_COUNTDOWN_MS,
        reconnect_grace_ms: int = RECONNECT_GRACE_MS,
    ) -> None:
        self.rooms: dict[str, Room] = {}
        self.countdown_ms = countdown_ms
        self.reconnect_grace_ms = reconnect_grace_ms
        self._rooms_lock = asyncio.Lock()

    async def connect(
        self,
        room_id: str,
        player_id: str,
        token: str,
        create: bool,
        websocket: WebSocket,
    ) -> Room | None:
        await websocket.accept()
        if not token:
            await self._reject_socket(
                websocket,
                "invalid_reconnect",
                "A private player token is required.",
            )
            return None

        while True:
            room_created = False
            async with self._rooms_lock:
                room = self.rooms.get(room_id)
                if room is None and create:
                    room = Room(
                        state=create_game(room_id, player_id),
                        player_tokens={player_id: token},
                    )
                    self.rooms[room_id] = room
                    room_created = True

            if room is None:
                await self._reject_socket(
                    websocket,
                    "room_not_found",
                    "No room exists for that code.",
                )
                return None

            async with room.lock:
                if room.closed:
                    continue

                existing_player = player_id in room.state.players
                if create and not room_created and not existing_player:
                    await self._reject_socket(
                        websocket,
                        "room_exists",
                        "That room code is already in use.",
                    )
                    return None

                if existing_player:
                    expected_token = room.player_tokens[player_id]
                    if not secrets.compare_digest(
                        expected_token.encode(), token.encode()
                    ):
                        await self._reject_socket(
                            websocket,
                            "invalid_reconnect",
                            "That player slot belongs to another session.",
                        )
                        return None
                else:
                    join = add_player(room.state, player_id)
                    if not join.accepted:
                        await self._reject_socket(
                            websocket,
                            "room_full",
                            "Room already has two players.",
                        )
                        return None
                    room.state = join.state
                    room.player_tokens[player_id] = token

                reconnected = existing_player
                self._cancel_reconnect_locked(room, player_id)
                previous_connection = room.connections.get(player_id)
                room.connections[player_id] = websocket
                room.revision += 1

                if previous_connection is not None and previous_connection is not websocket:
                    await _safe_close(
                        previous_connection,
                        4001,
                        "Player reconnected",
                    )

                opponent_connected = any(
                    current_id != player_id for current_id in room.connections
                )
                if not await _safe_send(
                    websocket,
                    {
                        "type": "connected",
                        "roomId": room_id,
                        "playerId": player_id,
                        "opponentConnected": opponent_connected,
                        "reconnected": reconnected,
                    },
                ):
                    self._mark_disconnected_locked(room, player_id, websocket)
                    room.revision += 1
                    await self.broadcast_state_locked(room, current_time_ms())
                    return None

                await self._send_to_opponents_locked(
                    room,
                    player_id,
                    {
                        "type": "opponent_joined",
                        "playerId": player_id,
                        "reconnected": reconnected,
                    },
                )
                await self.broadcast_state_locked(room, current_time_ms())
                return room

    async def disconnect(
        self,
        room_id: str,
        player_id: str,
        websocket: WebSocket,
    ) -> None:
        room = self.rooms.get(room_id)
        if room is None:
            return

        async with room.lock:
            if room.closed or room.connections.get(player_id) is not websocket:
                return
            self._mark_disconnected_locked(room, player_id, websocket)
            room.revision += 1
            await self._send_to_opponents_locked(
                room,
                player_id,
                {"type": "opponent_left", "playerId": player_id},
            )
            await self.broadcast_state_locked(room, current_time_ms())

    async def leave(
        self,
        room: Room,
        player_id: str,
        websocket: WebSocket,
    ) -> bool:
        should_evict = False
        async with room.lock:
            if room.closed or room.connections.get(player_id) is not websocket:
                return False

            await _safe_send(websocket, {"type": "left"})
            room.connections.pop(player_id, None)
            self._cancel_reconnect_locked(room, player_id)
            room.player_tokens.pop(player_id, None)
            room.ready_players.discard(player_id)
            room.starts_at_ms = 0
            removal = remove_player(room.state, player_id)
            room.state = removal.state
            room.revision += 1
            await self._send_to_opponents_locked(
                room,
                player_id,
                {"type": "opponent_left", "playerId": player_id},
            )
            await self.broadcast_state_locked(room, current_time_ms())
            await _safe_close(websocket, 1000, "Player left")
            should_evict = not room.state.players

        if should_evict:
            await self._evict_if_empty(room)
        return True

    def all_players_connected(self, room: Room) -> bool:
        return len(room.state.players) == 2 and all(
            player_id in room.connections for player_id in room.state.players
        )

    def all_players_ready(self, room: Room) -> bool:
        return self.all_players_connected(room) and all(
            player_id in room.ready_players for player_id in room.state.players
        )

    def gameplay_rejection(
        self, room: Room, now_ms: int
    ) -> tuple[str, int | None] | None:
        if not self.all_players_connected(room):
            return ("opponent_disconnected", None)
        if not self.all_players_ready(room):
            return ("players_not_ready", None)
        if room.state.phase != "playing":
            return ("game_not_active", None)
        if room.starts_at_ms > now_ms:
            return ("game_countdown", room.starts_at_ms - now_ms)
        return None

    async def set_ready(
        self,
        room: Room,
        player_id: str,
        websocket: WebSocket,
        ready: bool,
    ) -> None:
        async with room.lock:
            if room.connections.get(player_id) is not websocket:
                return

            now_ms = current_time_ms()
            match_live = (
                room.state.phase == "playing"
                and room.starts_at_ms <= now_ms
            )
            if match_live and not ready:
                await _send_or_disconnect(
                    websocket,
                    _rejection_message("ready", reason="game_already_started"),
                )
                return

            before_ready = player_id in room.ready_players
            if ready:
                room.ready_players.add(player_id)
            else:
                room.ready_players.discard(player_id)

            changed = before_ready != ready
            if not ready and room.state.phase == "playing":
                room.state = pause_game(room.state)
                room.starts_at_ms = 0
                changed = True
            elif room.state.phase == "waiting" and self.all_players_ready(room):
                started = start_game(room.state)
                if started.accepted:
                    room.state = started.state
                    room.starts_at_ms = now_ms + self.countdown_ms
                    changed = True

            if changed:
                room.revision += 1
            await self.broadcast_state_locked(room, now_ms)

    async def broadcast_event_locked(
        self, room: Room, event: dict[str, object]
    ) -> None:
        await self._broadcast_locked(room, _serialize_game_event(event))

    async def broadcast_state_locked(self, room: Room, now_ms: int) -> None:
        failed = await self._broadcast_locked(room, _state_message(room, now_ms))
        if failed and room.connections:
            await self._broadcast_locked(
                room,
                _state_message(room, current_time_ms()),
            )

    async def _broadcast_locked(
        self, room: Room, message: dict[str, object]
    ) -> bool:
        failed = False
        for player_id, connection in list(room.connections.items()):
            if await _safe_send(connection, message):
                continue
            if self._mark_disconnected_locked(room, player_id, connection):
                room.revision += 1
                failed = True
        return failed

    async def _send_to_opponents_locked(
        self,
        room: Room,
        player_id: str,
        message: dict[str, object],
    ) -> None:
        for opponent_id, connection in list(room.connections.items()):
            if opponent_id == player_id:
                continue
            if not await _safe_send(connection, message):
                if self._mark_disconnected_locked(room, opponent_id, connection):
                    room.revision += 1

    def _mark_disconnected_locked(
        self,
        room: Room,
        player_id: str,
        websocket: WebSocket,
    ) -> bool:
        if room.connections.get(player_id) is not websocket:
            return False
        room.connections.pop(player_id, None)
        room.ready_players.discard(player_id)
        room.state = pause_game(room.state)
        room.starts_at_ms = 0
        self._cancel_reconnect_locked(room, player_id)
        room.reconnect_tasks[player_id] = asyncio.create_task(
            self._expire_after_grace(room, player_id)
        )
        return True

    def _cancel_reconnect_locked(self, room: Room, player_id: str) -> None:
        task = room.reconnect_tasks.pop(player_id, None)
        if task is not None and task is not asyncio.current_task():
            task.cancel()

    async def _expire_after_grace(self, room: Room, player_id: str) -> None:
        try:
            await asyncio.sleep(self.reconnect_grace_ms / 1_000)
        except asyncio.CancelledError:
            return

        should_evict = False
        async with room.lock:
            task = asyncio.current_task()
            if (
                room.closed
                or room.reconnect_tasks.get(player_id) is not task
                or player_id in room.connections
            ):
                return
            room.reconnect_tasks.pop(player_id, None)
            room.player_tokens.pop(player_id, None)
            room.ready_players.discard(player_id)
            room.starts_at_ms = 0
            removal = remove_player(room.state, player_id)
            if removal.accepted:
                room.state = removal.state
                room.revision += 1
                await self.broadcast_state_locked(room, current_time_ms())
            should_evict = not room.state.players

        if should_evict:
            await self._evict_if_empty(room)

    async def _evict_if_empty(self, room: Room) -> None:
        async with self._rooms_lock:
            async with room.lock:
                if room.state.players or room.connections or room.closed:
                    return
                room.closed = True
                for task in room.reconnect_tasks.values():
                    if task is not asyncio.current_task():
                        task.cancel()
                room.reconnect_tasks.clear()
                if self.rooms.get(room.state.room_id) is room:
                    self.rooms.pop(room.state.room_id, None)

    async def _reject_socket(
        self,
        websocket: WebSocket,
        code: str,
        message: str,
    ) -> None:
        await _safe_send(
            websocket,
            {"type": "error", "code": code, "message": message},
        )
        await _safe_close(websocket, 1008, message)


def _state_message(room: Room, now_ms: int) -> dict[str, object]:
    return {
        "type": "game_state",
        "serverTime": now_ms,
        "revision": room.revision,
        "roomId": room.state.room_id,
        "phase": room.state.phase,
        "startsAt": room.starts_at_ms,
        "winnerId": room.state.winner_id,
        "players": [
            {
                "playerId": player.player_id,
                "connected": player.player_id in room.connections,
                "ready": player.player_id in room.ready_players,
                "health": player.health,
                "ammo": player.ammo,
                "nextShotAt": player.next_shot_at_ms,
                "effects": dict(player.effects),
                "cooldowns": dict(player.cooldowns),
                "wantsRematch": player.wants_rematch,
            }
            for player in room.state.players.values()
        ],
    }


def _serialize_game_event(event: dict[str, object]) -> dict[str, object]:
    message: dict[str, object] = {
        "type": "game_event",
        "event": event["event"],
    }
    key_mapping = {
        "source_player_id": "sourcePlayerId",
        "target_player_id": "targetPlayerId",
        "damaged_player_id": "damagedPlayerId",
        "duration_ms": "durationMs",
    }
    for key, value in event.items():
        if key == "event" or value is None:
            continue
        message[key_mapping.get(key, key)] = value
    return message


REASON_MESSAGES = {
    "ammo_full": "Ammo is already full.",
    "fire_rate_limited": "Gun is not ready to fire yet.",
    "game_already_started": "Readiness is locked after the duel starts.",
    "game_countdown": "The duel countdown is still running.",
    "game_not_active": "The game is not active.",
    "game_not_finished": "A rematch can only be requested after the game.",
    "opponent_disconnected": "Wait for the other player to reconnect.",
    "opponent_missing": "The room needs another player.",
    "out_of_ammo": "Draw a loop to reload.",
    "player_defeated": "A defeated player cannot act.",
    "players_not_ready": "Both players must be ready.",
    "rematch_already_requested": "Rematch already requested.",
    "spell_cooldown": "That spell is still cooling down.",
    "unknown_player": "Player is not in this room.",
    "unsupported_spell": "That drawing is not a supported spell.",
}


def _rejection_message(
    action: str,
    result: ActionResult | None = None,
    reason: str | None = None,
    retry_after_ms: int | None = None,
) -> dict[str, object]:
    rejection_reason = reason or (result.reason if result else None) or "rejected"
    message: dict[str, object] = {
        "type": "action_rejected",
        "action": action,
        "reason": rejection_reason,
        "message": REASON_MESSAGES.get(rejection_reason, "Action was rejected."),
    }
    retry = retry_after_ms
    if retry is None and result is not None:
        retry = result.retry_after_ms
    if retry is not None:
        message["retryAfterMs"] = retry
    return message


def _cast_rejection_message(
    drawing_type: str | None,
    score: float,
    reason: str,
    retry_after_ms: int | None = None,
) -> dict[str, object]:
    message: dict[str, object] = {
        "type": "cast_result",
        "accepted": False,
        "drawingType": drawing_type,
        "score": score,
        "reason": reason,
        "message": REASON_MESSAGES.get(reason, "The drawing was not accepted."),
    }
    if retry_after_ms is not None:
        message["retryAfterMs"] = retry_after_ms
    return message


app = FastAPI(title="Drawing Spells Server")
rooms = RoomManager()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/ws/{room_id}/{player_id}")
async def game_socket(websocket: WebSocket, room_id: str, player_id: str) -> None:
    room: Room | None = None
    try:
        token = websocket.query_params.get("token", "")
        create = websocket.query_params.get("create") == "1"
        room = await rooms.connect(
            room_id,
            player_id,
            token,
            create,
            websocket,
        )
        if room is None:
            return

        while True:
            try:
                raw_message = await websocket.receive_json()
            except ValueError:
                await _send_or_disconnect(
                    websocket,
                    {
                        "type": "error",
                        "code": "invalid_json",
                        "message": "Message must be valid JSON.",
                    },
                )
                continue

            try:
                message = client_message_adapter.validate_python(raw_message)
            except ValidationError as error:
                invalid_cast = (
                    isinstance(raw_message, dict)
                    and raw_message.get("type") == "cast"
                )
                if invalid_cast:
                    await _send_or_disconnect(
                        websocket,
                        _cast_rejection_message(None, 0.0, "invalid_drawing"),
                    )
                else:
                    await _send_or_disconnect(
                        websocket,
                        {
                            "type": "error",
                            "code": "invalid_message",
                            "message": "Invalid game message",
                            "details": error.errors(include_url=False),
                        },
                    )
                continue

            if isinstance(message, CastMessage):
                await _handle_cast(room, player_id, websocket, message)
            elif isinstance(message, FireMessage):
                await _handle_fire(room, player_id, websocket, message)
            elif isinstance(message, RematchMessage):
                await _handle_rematch(room, player_id, websocket)
            elif isinstance(message, ReadyMessage):
                await rooms.set_ready(
                    room,
                    player_id,
                    websocket,
                    message.ready,
                )
            elif isinstance(message, LeaveMessage):
                if await rooms.leave(room, player_id, websocket):
                    return
    except WebSocketDisconnect:
        pass
    finally:
        if room is not None:
            await rooms.disconnect(room_id, player_id, websocket)


async def _handle_cast(
    room: Room,
    player_id: str,
    websocket: WebSocket,
    message: CastMessage,
) -> None:
    async with room.lock:
        if room.connections.get(player_id) is not websocket:
            return
        rejection = rooms.gameplay_rejection(room, current_time_ms())
        if rejection is not None:
            reason, retry_after_ms = rejection
            await _send_or_disconnect(
                websocket,
                _cast_rejection_message(None, 0.0, reason, retry_after_ms),
            )
            return

    recognition = recognizer.recognize(
        [
            [(point.x, point.y) for point in stroke]
            for stroke in message.strokes
        ],
        aspect_ratio=message.aspect_ratio,
    )
    if not recognition.accepted:
        await _send_or_disconnect(
            websocket,
            _cast_rejection_message(
                drawing_type=None,
                score=recognition.score,
                reason=recognition.reason or "no_match",
            ),
        )
        return

    async with room.lock:
        if room.connections.get(player_id) is not websocket:
            return
        now_ms = current_time_ms()
        rejection = rooms.gameplay_rejection(room, now_ms)
        if rejection is not None:
            reason, retry_after_ms = rejection
            await _send_or_disconnect(
                websocket,
                _cast_rejection_message(
                    recognition.drawing_type,
                    recognition.score,
                    reason,
                    retry_after_ms,
                ),
            )
            return

        result = cast_spell(
            room.state,
            player_id,
            recognition.drawing_type or "",
            now_ms,
        )
        if not result.accepted:
            await _send_or_disconnect(
                websocket,
                _cast_rejection_message(
                    recognition.drawing_type,
                    recognition.score,
                    result.reason or "rejected",
                    result.retry_after_ms,
                ),
            )
            return

        room.state = result.state
        room.revision += 1
        event = result.event or {}
        result_delivered = await _safe_send(
            websocket,
            {
                "type": "cast_result",
                "accepted": True,
                "spellId": str(uuid4()),
                "drawingType": recognition.drawing_type,
                "score": recognition.score,
                "targetPlayerId": event.get("target_player_id"),
            },
        )
        await rooms.broadcast_event_locked(room, event)
        await rooms.broadcast_state_locked(room, now_ms)
        if not result_delivered:
            raise WebSocketDisconnect(code=1006)


async def _handle_fire(
    room: Room,
    player_id: str,
    websocket: WebSocket,
    message: FireMessage,
) -> None:
    async with room.lock:
        if room.connections.get(player_id) is not websocket:
            return
        now_ms = current_time_ms()
        rejection = rooms.gameplay_rejection(room, now_ms)
        if rejection is not None:
            reason, retry_after_ms = rejection
            await _send_or_disconnect(
                websocket,
                _rejection_message(
                    "fire",
                    reason=reason,
                    retry_after_ms=retry_after_ms,
                ),
            )
            return

        result = fire(
            room.state,
            player_id,
            now_ms,
            target_locked=message.target_locked,
        )
        if not result.accepted:
            await _send_or_disconnect(
                websocket,
                _rejection_message("fire", result=result),
            )
            return

        room.state = result.state
        if room.state.phase == "finished":
            room.starts_at_ms = 0
        room.revision += 1
        await rooms.broadcast_event_locked(room, result.event or {})
        await rooms.broadcast_state_locked(room, now_ms)


async def _handle_rematch(
    room: Room, player_id: str, websocket: WebSocket
) -> None:
    async with room.lock:
        if room.connections.get(player_id) is not websocket:
            return
        if not rooms.all_players_connected(room):
            await _send_or_disconnect(
                websocket,
                _rejection_message("rematch", reason="opponent_disconnected"),
            )
            return

        result = request_rematch(room.state, player_id)
        if not result.accepted:
            await _send_or_disconnect(
                websocket,
                _rejection_message("rematch", result=result),
            )
            return

        now_ms = current_time_ms()
        room.state = result.state
        room.starts_at_ms = 0
        if (
            result.event is not None
            and result.event.get("event") == "rematch_started"
            and rooms.all_players_ready(room)
        ):
            started = start_game(room.state)
            if started.accepted:
                room.state = started.state
                room.starts_at_ms = now_ms + rooms.countdown_ms
        room.revision += 1
        await rooms.broadcast_event_locked(room, result.event or {})
        await rooms.broadcast_state_locked(room, now_ms)


client_dist = Path(__file__).resolve().parents[2] / "client" / "dist"
if client_dist.is_dir():
    app.mount("/", StaticFiles(directory=client_dist, html=True), name="client")
