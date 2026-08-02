from math import cos, pi, sin

from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


PLUS_STROKES = [
    [{"x": 0.5, "y": 0.2}, {"x": 0.5, "y": 0.8}],
    [{"x": 0.2, "y": 0.5}, {"x": 0.8, "y": 0.5}],
]


def test_cast_is_accepted_and_sent_to_opponent() -> None:
    with client.websocket_connect("/ws/test-room/player-one") as player_one:
        connected = player_one.receive_json()
        assert connected == {
            "type": "connected",
            "roomId": "test-room",
            "playerId": "player-one",
            "opponentConnected": False,
        }

        with client.websocket_connect("/ws/test-room/mock-opponent") as opponent:
            assert opponent.receive_json()["opponentConnected"] is True
            assert player_one.receive_json() == {
                "type": "opponent_joined",
                "playerId": "mock-opponent",
            }

            player_one.send_json({"type": "cast", "strokes": PLUS_STROKES})

            result = player_one.receive_json()
            assert result["type"] == "cast_result"
            assert result["accepted"] is True
            assert result["drawingType"] == "plus"
            assert result["score"] > 0.9

            effect = opponent.receive_json()
            assert effect == {
                "type": "effect",
                "effect": "plus",
                "spellId": result["spellId"],
                "sourcePlayerId": "player-one",
                "strokes": PLUS_STROKES,
            }


def test_rejected_cast_is_not_sent_to_opponent() -> None:
    with client.websocket_connect("/ws/rejection-room/player-one") as player_one:
        player_one.receive_json()
        with client.websocket_connect("/ws/rejection-room/player-two") as opponent:
            opponent.receive_json()
            player_one.receive_json()

            scribble = [
                [
                    {"x": 0.1, "y": 0.1},
                    {"x": 0.8, "y": 0.2},
                    {"x": 0.2, "y": 0.4},
                    {"x": 0.9, "y": 0.6},
                    {"x": 0.1, "y": 0.9},
                ]
            ]
            player_one.send_json({"type": "cast", "strokes": scribble})

            rejection = player_one.receive_json()
            assert rejection["type"] == "cast_result"
            assert rejection["accepted"] is False
            assert rejection["reason"] in {"ambiguous", "no_match"}

            player_one.send_json({"type": "cast", "strokes": PLUS_STROKES})
            accepted = player_one.receive_json()
            assert accepted["accepted"] is True

            effect = opponent.receive_json()
            assert effect["spellId"] == accepted["spellId"]
            assert effect["effect"] == "plus"


def test_out_of_bounds_points_are_invalid() -> None:
    with client.websocket_connect("/ws/validation-room/player-one") as player:
        player.receive_json()
        player.send_json(
            {
                "type": "cast",
                "strokes": [[{"x": -0.1, "y": 0.2}, {"x": 0.3, "y": 0.4}]],
            }
        )

        error = player.receive_json()
        assert error["type"] == "error"
        assert error["message"] == "Invalid cast message"


def test_cast_uses_canvas_aspect_ratio() -> None:
    width = 390
    height = 844
    circle = [
        [
            {
                "x": (195 + 120 * cos(2 * pi * index / 32)) / width,
                "y": (360 + 120 * sin(2 * pi * index / 32)) / height,
            }
            for index in range(33)
        ]
    ]

    with client.websocket_connect("/ws/aspect-room/player-one") as player:
        player.receive_json()
        player.send_json(
            {
                "type": "cast",
                "strokes": circle,
                "aspectRatio": width / height,
            }
        )

        result = player.receive_json()
        assert result["accepted"] is True
        assert result["drawingType"] == "circle"
