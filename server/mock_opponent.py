import asyncio
import json

from websockets.asyncio.client import connect


async def main() -> None:
    uri = "ws://localhost:8000/ws/demo-room/mock-opponent"
    async with connect(uri) as websocket:
        print(f"Mock opponent connected to {uri}")
        async for message in websocket:
            event = json.loads(message)
            if event["type"] == "effect":
                print(
                    f"Received {event['effect']} from "
                    f"{event['sourcePlayerId']} ({event['spellId']})"
                )
            else:
                print(json.dumps(event))


if __name__ == "__main__":
    asyncio.run(main())
