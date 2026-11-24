# mock_gateway.py - mock local xiaobao gateway (AG-UI protocol) for tests
# - sends gateway.connected on connect
# - accepts {type:req, requestId, event:"agent.run", payload:{...}}
# - replies ACK + ag_ui_event stream (TEXT_MESSAGE_CONTENT deltas, RUN_FINISHED)
import asyncio, websockets, json, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 18767
REPLY = "这是 mock 网关的回复"


async def handler(ws):
    await ws.send(json.dumps({
        "type": "event", "event": "gateway.connected",
        "data": {"agentConnectionStatus": "Ready"},
    }))
    async for raw in ws:
        try:
            msg = json.loads(raw)
        except Exception:
            continue
        if msg.get("event") != "agent.run":
            await ws.send(json.dumps({
                "type": "error", "event": "unknown",
                "message": "unsupported event", "requestId": msg.get("requestId", ""),
            }))
            continue
        rid = msg.get("requestId")
        payload = msg.get("payload")
        if not isinstance(payload, dict):
            await ws.send(json.dumps({
                "type": "error", "event": "agent.run",
                "message": "agent.run payload 必须为对象", "requestId": rid,
            }))
            continue
        conv = payload.get("conversation_id")
        resp = payload.get("response_id")
        await ws.send(json.dumps({
            "type": "res", "requestId": rid, "ok": True,
            "data": {"conversation_id": conv, "ok": True, "response_id": resp},
        }))
        await ws.send(json.dumps({
            "type": "event", "event": "ag_ui_event",
            "data": {"conversation_id": conv, "response_id": resp,
                     "event": "TEXT_MESSAGE_CONTENT", "delta": REPLY,
                     "messageId": "msg_mock"},
        }))
        await ws.send(json.dumps({
            "type": "event", "event": "ag_ui_event",
            "data": {"conversation_id": conv, "response_id": resp,
                     "event": "RUN_FINISHED", "model": "mock-gateway-model"},
        }))


async def main():
    async with websockets.serve(handler, "127.0.0.1", PORT):
        await asyncio.sleep(120)

asyncio.run(main())
