import asyncio
import json

from websockets.asyncio.client import connect


async def main() -> None:
    uri = (
        "ws://localhost:8000/ws/DEMO1/mock-opponent"
        "?token=mock-opponent-secret&create=1"
    )
    async with connect(uri) as websocket:
        print(f"Mock opponent connected to {uri}")
        await websocket.send(json.dumps({"type": "ready", "ready": True}))
        async for message in websocket:
            event = json.loads(message)
            if event["type"] == "game_event":
                print(
                    f"Received {event['event']} from "
                    f"{event.get('sourcePlayerId', 'server')}"
                )
            else:
                print(json.dumps(event))


if __name__ == "__main__":
    asyncio.run(main())
