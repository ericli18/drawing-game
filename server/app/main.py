from collections import defaultdict
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field, ValidationError

from app.recognizer import recognizer


class Point(BaseModel):
    x: Annotated[float, Field(ge=0.0, le=1.0, allow_inf_nan=False)]
    y: Annotated[float, Field(ge=0.0, le=1.0, allow_inf_nan=False)]


Stroke = Annotated[list[Point], Field(min_length=1, max_length=2048)]


class CastMessage(BaseModel):
    type: Literal["cast"]
    strokes: Annotated[list[Stroke], Field(min_length=1, max_length=8)]
    aspect_ratio: float = Field(
        default=1.0,
        alias="aspectRatio",
        gt=0.0,
        le=10.0,
        allow_inf_nan=False,
    )


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

            recognition = recognizer.recognize(
                [
                    [(point.x, point.y) for point in stroke]
                    for stroke in cast.strokes
                ],
                aspect_ratio=cast.aspect_ratio,
            )

            if not recognition.accepted:
                await websocket.send_json(
                    {
                        "type": "cast_result",
                        "accepted": False,
                        "score": recognition.score,
                        "reason": recognition.reason,
                    }
                )
                continue

            spell_id = str(uuid4())
            await websocket.send_json(
                {
                    "type": "cast_result",
                    "accepted": True,
                    "spellId": spell_id,
                    "drawingType": recognition.drawing_type,
                    "score": recognition.score,
                }
            )
            await rooms.send_to_opponents(
                room_id,
                player_id,
                {
                    "type": "effect",
                    "effect": recognition.drawing_type,
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
