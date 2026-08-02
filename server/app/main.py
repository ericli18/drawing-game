from collections import defaultdict
from typing import Literal
from uuid import uuid4

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ValidationError


class Point(BaseModel):
    x: float
    y: float


class CastMessage(BaseModel):
    type: Literal["cast"]
    strokes: list[list[Point]]


class RoomManager:
    def __init__(self) -> None:
        self.rooms: dict[str, dict[str, WebSocket]] = defaultdict(dict)

    async def connect(
        self, room_id: str, player_id: str, websocket: WebSocket
    ) -> None:
        await websocket.accept()
        room = self.rooms[room_id]
        room[player_id] = websocket
        await websocket.send_json(
            {
                "type": "connected",
                "roomId": room_id,
                "playerId": player_id,
                "opponentConnected": len(room) > 1,
            }
        )
        await self.send_to_opponents(
            room_id,
            player_id,
            {"type": "opponent_joined", "playerId": player_id},
        )

    def disconnect(self, room_id: str, player_id: str) -> None:
        room = self.rooms.get(room_id)
        if not room:
            return
        room.pop(player_id, None)
        if not room:
            self.rooms.pop(room_id, None)

    async def send_to_opponents(
        self, room_id: str, player_id: str, message: dict[str, object]
    ) -> None:
        room = self.rooms.get(room_id, {})
        for opponent_id, connection in room.items():
            if opponent_id != player_id:
                await connection.send_json(message)


app = FastAPI(title="Drawing Spells Server")
rooms = RoomManager()


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/ws/{room_id}/{player_id}")
async def game_socket(websocket: WebSocket, room_id: str, player_id: str) -> None:
    await rooms.connect(room_id, player_id, websocket)

    try:
        while True:
            raw_message = await websocket.receive_json()
            try:
                cast = CastMessage.model_validate(raw_message)
            except ValidationError as error:
                await websocket.send_json(
                    {
                        "type": "error",
                        "message": "Invalid cast message",
                        "details": error.errors(include_url=False),
                    }
                )
                continue

            spell_id = str(uuid4())
            drawing_type = "mock_spell"

            await websocket.send_json(
                {
                    "type": "cast_result",
                    "accepted": True,
                    "spellId": spell_id,
                    "drawingType": drawing_type,
                }
            )
            await rooms.send_to_opponents(
                room_id,
                player_id,
                {
                    "type": "effect",
                    "effect": drawing_type,
                    "spellId": spell_id,
                    "sourcePlayerId": player_id,
                    "strokes": [
                        [point.model_dump() for point in stroke]
                        for stroke in cast.strokes
                    ],
                },
            )
    except WebSocketDisconnect:
        rooms.disconnect(room_id, player_id)
        await rooms.send_to_opponents(
            room_id,
            player_id,
            {"type": "opponent_left", "playerId": player_id},
        )
