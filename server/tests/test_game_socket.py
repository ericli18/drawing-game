from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


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

            strokes = [[{"x": 0.1, "y": 0.2}, {"x": 0.3, "y": 0.4}]]
            player_one.send_json({"type": "cast", "strokes": strokes})

            result = player_one.receive_json()
            assert result["type"] == "cast_result"
            assert result["accepted"] is True
            assert result["drawingType"] == "mock_spell"

            effect = opponent.receive_json()
            assert effect == {
                "type": "effect",
                "effect": "mock_spell",
                "spellId": result["spellId"],
                "sourcePlayerId": "player-one",
                "strokes": strokes,
            }
