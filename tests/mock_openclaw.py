# mock_openclaw.py - test openclaw WS server, mirrors real gateway handshake/event order
import asyncio, websockets, json, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18766

async def handler(ws):
    async for raw in ws:
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        if msg.get("method") == "connect":
            await ws.send(json.dumps({
                "type": "res", "id": msg["id"], "ok": True,
                "payload": {"type": "hello-ok", "protocol": 3, "server": {"version": "1.0.0"}},
            }))
        elif msg.get("method") == "chat.send":
            text = "这是 mock 网关的回复"
            await ws.send(json.dumps({
                "type": "event", "event": "chat",
                "payload": {"message": {"role": "assistant", "model": "mock-model", "content": [
                    {"type": "text", "text": text, "isAgentTextFinal": True},
                ]}},
            }))
            await ws.send(json.dumps({
                "type": "event", "event": "agent",
                "payload": {"data": {"phase": "end"}},
            }))

async def main():
    async with websockets.serve(handler, "127.0.0.1", PORT):
        await asyncio.sleep(120)

asyncio.run(main())
