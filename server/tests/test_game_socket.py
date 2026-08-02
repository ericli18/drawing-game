import asyncio
from math import cos, pi, sin

import pytest
from fastapi.testclient import TestClient

from app.main import RoomManager, app, rooms


client = TestClient(app)

PLUS_STROKES = [
    [{"x": 0.5, "y": 0.2}, {"x": 0.5, "y": 0.8}],
    [{"x": 0.2, "y": 0.5}, {"x": 0.8, "y": 0.5}],
]
LOOP_STROKES = [
    [
        {
            "x": 0.44 + 0.28 * cos(pi / 4 + 2 * pi * index / 24),
            "y": 0.39 + 0.28 * sin(pi / 4 + 2 * pi * index / 24),
        }
        for index in range(25)
    ]
]
LOOP_STROKES[0].extend(
    [{"x": 0.78, "y": 0.68}, {"x": 0.86, "y": 0.78}]
)


@pytest.fixture(autouse=True)
def immediate_countdown():
    previous = rooms.countdown_ms
    rooms.countdown_ms = 0
    yield
    rooms.countdown_ms = previous


def _url(
    room_id: str,
    player_id: str,
    token: str,
    *,
    create: bool = False,
) -> str:
    suffix = "&create=1" if create else ""
    return f"/ws/{room_id}/{player_id}?token={token}{suffix}"


def _connect_two(room_id: str):
    return (
        client.websocket_connect(
            _url(room_id, "player-one", "token-one", create=True)
        ),
        client.websocket_connect(
            _url(room_id, "player-two", "token-two")
        ),
    )


def _finish_two_player_join(player_one, player_two) -> None:
    first_connected = player_one.receive_json()
    first_waiting = player_one.receive_json()
    assert first_connected["type"] == "connected"
    assert first_waiting["type"] == "game_state"
    assert first_waiting["phase"] == "waiting"
    assert first_waiting["startsAt"] == 0

    second_connected = player_two.receive_json()
    opponent_joined = player_one.receive_json()
    first_state = player_one.receive_json()
    second_state = player_two.receive_json()
    assert second_connected["type"] == "connected"
    assert opponent_joined["type"] == "opponent_joined"
    assert first_state == second_state
    assert first_state["phase"] == "waiting"
    assert not any(player["ready"] for player in first_state["players"])


def _ready_two(player_one, player_two):
    player_one.send_json({"type": "ready", "ready": True})
    first_state = player_one.receive_json()
    second_state = player_two.receive_json()
    assert first_state == second_state
    assert first_state["phase"] == "waiting"

    player_two.send_json({"type": "ready", "ready": True})
    first_state = player_one.receive_json()
    second_state = player_two.receive_json()
    assert first_state == second_state
    assert first_state["phase"] == "playing"
    assert all(player["ready"] for player in first_state["players"])
    return first_state


def _join_and_ready(player_one, player_two) -> None:
    _finish_two_player_join(player_one, player_two)
    _ready_two(player_one, player_two)


def _receive_broadcast(player_one, player_two):
    first_event = player_one.receive_json()
    second_event = player_two.receive_json()
    first_state = player_one.receive_json()
    second_state = player_two.receive_json()
    assert first_event == second_event
    assert first_state == second_state
    return first_event, first_state


def test_create_join_ready_and_authoritative_countdown(monkeypatch) -> None:
    clock = [10_000]
    monkeypatch.setattr("app.main.current_time_ms", lambda: clock[0])
    rooms.countdown_ms = 3_000
    first_connection, second_connection = _connect_two("ready-room")

    with first_connection as player_one, second_connection as player_two:
        _finish_two_player_join(player_one, player_two)
        countdown = _ready_two(player_one, player_two)
        assert countdown["startsAt"] == 13_000

        player_one.send_json({"type": "fire", "targetLocked": True})
        assert player_one.receive_json() == {
            "type": "action_rejected",
            "action": "fire",
            "reason": "game_countdown",
            "message": "The duel countdown is still running.",
            "retryAfterMs": 3_000,
        }

        clock[0] = 13_000
        player_one.send_json({"type": "fire", "targetLocked": True})
        event, state = _receive_broadcast(player_one, player_two)
        assert event["event"] == "shot"
        assert state["players"][1]["health"] == 88


def test_joining_missing_room_and_create_collision_are_rejected() -> None:
    with client.websocket_connect(
        _url("missing-room", "joiner", "join-token")
    ) as missing:
        assert missing.receive_json()["code"] == "room_not_found"

    with client.websocket_connect(
        _url("collision-room", "owner", "owner-token", create=True)
    ) as owner:
        owner.receive_json()
        owner.receive_json()
        with client.websocket_connect(
            _url("collision-room", "other", "other-token", create=True)
        ) as collision:
            assert collision.receive_json()["code"] == "room_exists"


def test_room_rejects_third_player_and_wrong_reconnect_token() -> None:
    first_connection, second_connection = _connect_two("auth-room")
    with first_connection as player_one, second_connection as player_two:
        _finish_two_player_join(player_one, player_two)

        with client.websocket_connect(
            _url("auth-room", "player-three", "token-three")
        ) as third:
            assert third.receive_json()["code"] == "room_full"

        with client.websocket_connect(
            _url("auth-room", "player-one", "wrong-token", create=True)
        ) as attacker:
            assert attacker.receive_json()["code"] == "invalid_reconnect"

        player_one.send_json({"type": "ready", "ready": True})
        assert player_one.receive_json()["players"][0]["ready"] is True
        player_two.receive_json()


def test_valid_creator_reconnect_preserves_state_and_requires_ready_again() -> None:
    first_connection, second_connection = _connect_two("reconnect-room")
    with first_connection as original, second_connection as opponent:
        _join_and_ready(original, opponent)
        original.send_json({"type": "fire", "targetLocked": True})
        _receive_broadcast(original, opponent)

        with client.websocket_connect(
            _url(
                "reconnect-room",
                "player-one",
                "token-one",
                create=True,
            )
        ) as replacement:
            connected = replacement.receive_json()
            assert connected["reconnected"] is True
            assert opponent.receive_json()["type"] == "opponent_joined"
            opponent_state = opponent.receive_json()
            replacement_state = replacement.receive_json()
            assert opponent_state == replacement_state
            assert opponent_state["players"][1]["health"] == 88


def test_explicit_leave_frees_slot_and_resets_survivor() -> None:
    first_connection, second_connection = _connect_two("leave-room")
    with first_connection as player_one, second_connection as player_two:
        _join_and_ready(player_one, player_two)
        player_one.send_json({"type": "fire", "targetLocked": True})
        _receive_broadcast(player_one, player_two)

        player_one.send_json({"type": "leave"})
        assert player_one.receive_json() == {"type": "left"}
        assert player_two.receive_json()["type"] == "opponent_left"
        reset = player_two.receive_json()
        assert reset["phase"] == "waiting"
        assert len(reset["players"]) == 1
        assert reset["players"][0]["health"] == 100

        with client.websocket_connect(
            _url("leave-room", "player-three", "token-three")
        ) as replacement:
            assert replacement.receive_json()["type"] == "connected"
            player_two.receive_json()
            player_two.receive_json()
            joined = replacement.receive_json()
            assert len(joined["players"]) == 2


def test_disconnect_grace_expires_and_frees_slot() -> None:
    class FakeSocket:
        def __init__(self) -> None:
            self.messages: list[dict[str, object]] = []

        async def accept(self) -> None:
            pass

        async def send_json(self, message: dict[str, object]) -> None:
            self.messages.append(message)

        async def close(self, code: int, reason: str) -> None:
            pass

    async def scenario() -> None:
        manager = RoomManager(countdown_ms=0, reconnect_grace_ms=5)
        first = FakeSocket()
        second = FakeSocket()
        room = await manager.connect(
            "grace-room", "one", "token-one", True, first  # type: ignore[arg-type]
        )
        assert room is not None
        await manager.connect(
            "grace-room", "two", "token-two", False, second  # type: ignore[arg-type]
        )
        await manager.set_ready(
            room, "one", first, True  # type: ignore[arg-type]
        )
        await manager.set_ready(
            room, "two", second, True  # type: ignore[arg-type]
        )
        assert room.state.phase == "playing"

        await manager.disconnect(
            "grace-room", "one", first  # type: ignore[arg-type]
        )
        assert "one" in room.state.players
        assert "one" not in room.ready_players
        assert room.state.phase == "waiting"

        reconnected = FakeSocket()
        await manager.connect(
            "grace-room", "one", "token-one", True, reconnected  # type: ignore[arg-type]
        )
        assert "one" not in room.ready_players
        await manager.set_ready(
            room, "one", reconnected, True  # type: ignore[arg-type]
        )
        assert room.state.phase == "playing"

        await manager.disconnect(
            "grace-room", "one", reconnected  # type: ignore[arg-type]
        )
        await asyncio.sleep(0.02)
        assert "one" not in room.state.players

        third = FakeSocket()
        joined = await manager.connect(
            "grace-room", "three", "token-three", False, third  # type: ignore[arg-type]
        )
        assert joined is room
        assert set(room.state.players) == {"two", "three"}

    asyncio.run(scenario())


def test_cast_fire_and_damage_event_use_authoritative_state(monkeypatch) -> None:
    monkeypatch.setattr("app.main.current_time_ms", lambda: 10_000)
    first_connection, second_connection = _connect_two("combat-room")
    with first_connection as player_one, second_connection as player_two:
        _join_and_ready(player_one, player_two)

        player_one.send_json({"type": "cast", "strokes": PLUS_STROKES})
        cast_result = player_one.receive_json()
        assert cast_result["accepted"] is True
        event, state = _receive_broadcast(player_one, player_two)
        assert event["spell"] == "plus"
        assert state["players"][0]["effects"]["rapid"] == 16_000

        player_one.send_json({"type": "fire", "targetLocked": True})
        event, state = _receive_broadcast(player_one, player_two)
        assert event["damagedPlayerId"] == "player-two"
        assert state["players"][0]["ammo"] == 5
        assert state["players"][1]["health"] == 88


def test_reflected_shot_names_shooter_as_damaged_player(monkeypatch) -> None:
    monkeypatch.setattr("app.main.current_time_ms", lambda: 20_000)
    first_connection, second_connection = _connect_two("reflection-room")
    with first_connection as player_one, second_connection as player_two:
        _join_and_ready(player_one, player_two)
        triangle = [[
            {"x": 0.5, "y": 0.15},
            {"x": 0.84, "y": 0.8},
            {"x": 0.16, "y": 0.8},
            {"x": 0.5, "y": 0.15},
        ]]
        player_two.send_json({"type": "cast", "strokes": triangle})
        assert player_two.receive_json()["accepted"] is True
        _receive_broadcast(player_one, player_two)

        player_one.send_json({"type": "fire", "targetLocked": True})
        event, state = _receive_broadcast(player_one, player_two)
        assert event["outcome"] == "reflected"
        assert event["damagedPlayerId"] == "player-one"
        assert state["players"][0]["health"] == 88
        assert state["players"][1]["health"] == 100


def test_fire_without_target_lock_misses_but_spends_ammo() -> None:
    first_connection, second_connection = _connect_two("target-room")
    with first_connection as player_one, second_connection as player_two:
        _join_and_ready(player_one, player_two)
        player_one.send_json({"type": "fire", "targetLocked": False})
        event, state = _receive_broadcast(player_one, player_two)
        assert event["outcome"] == "missed"
        assert "damagedPlayerId" not in event
        assert state["players"][0]["ammo"] == 5
        assert state["players"][1]["health"] == 100


def test_schema_invalid_cast_returns_cast_result_instead_of_wedging() -> None:
    with client.websocket_connect(
        _url("validation-room", "player-one", "token-one", create=True)
    ) as player:
        player.receive_json()
        player.receive_json()
        player.send_json(
            {
                "type": "cast",
                "strokes": [
                    [{"x": -0.1, "y": 0.2}, {"x": 0.3, "y": 0.4}]
                ],
            }
        )
        result = player.receive_json()
        assert result["type"] == "cast_result"
        assert result["accepted"] is False
        assert result["reason"] == "invalid_drawing"


def test_actions_wait_for_connected_and_ready_players() -> None:
    with client.websocket_connect(
        _url("wait-room", "player-one", "token-one", create=True)
    ) as player:
        player.receive_json()
        player.receive_json()
        player.send_json({"type": "fire", "targetLocked": True})
        rejection = player.receive_json()
        assert rejection["reason"] == "opponent_disconnected"

    first_connection, second_connection = _connect_two("not-ready-room")
    with first_connection as player_one, second_connection as player_two:
        _finish_two_player_join(player_one, player_two)
        player_one.send_json({"type": "fire", "targetLocked": True})
        assert player_one.receive_json()["reason"] == "players_not_ready"


def test_rematch_resets_and_starts_a_new_countdown(monkeypatch) -> None:
    clock = [1_000]
    monkeypatch.setattr("app.main.current_time_ms", lambda: clock[0])
    first_connection, second_connection = _connect_two("rematch-room")
    with first_connection as player_one, second_connection as player_two:
        _join_and_ready(player_one, player_two)

        for _ in range(6):
            player_one.send_json({"type": "fire", "targetLocked": True})
            _receive_broadcast(player_one, player_two)
            clock[0] += 800
        player_one.send_json({"type": "cast", "strokes": LOOP_STROKES})
        assert player_one.receive_json()["accepted"] is True
        _receive_broadcast(player_one, player_two)
        for _ in range(3):
            player_one.send_json({"type": "fire", "targetLocked": True})
            _, state = _receive_broadcast(player_one, player_two)
            clock[0] += 800
        assert state["phase"] == "finished"

        player_one.send_json({"type": "rematch"})
        _, state = _receive_broadcast(player_one, player_two)
        assert state["phase"] == "finished"
        player_two.send_json({"type": "rematch"})
        event, state = _receive_broadcast(player_one, player_two)
        assert event["event"] == "rematch_started"
        assert state["phase"] == "playing"
        assert state["startsAt"] == clock[0]
        assert [player["health"] for player in state["players"]] == [100, 100]
