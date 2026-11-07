from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

from . import __version__
from .capabilities import action_names
from .compiler import compile_instruction
from .native_api import native_call
from .supervisor import AutomationSupervisor

class RuntimeService:
    def __init__(self) -> None:
        self.supervisor = AutomationSupervisor()
        self.tasks: dict[str, asyncio.Task[Any]] = {}
        self.write_lock = asyncio.Lock()

    async def write(self, message: dict[str, Any]) -> None:
        line = json.dumps(message, ensure_ascii=False, default=str)
        async with self.write_lock:
            await asyncio.to_thread(sys.stdout.write, line + "\n")
            await asyncio.to_thread(sys.stdout.flush)

    async def progress(self, request_id: str, event: dict[str, Any]) -> None:
        await self.write({"event": True, "requestId": request_id, **event})

    async def dispatch(self, request_id: str, method: str, params: dict[str, Any]) -> Any:
        if method == "health":
            return {
                "name": "OmniAgent Python Runtime",
                "version": __version__,
                "python": sys.version.split()[0],
                "capabilities": len(action_names()),
            }
        if method == "capabilities.list":
            return {"actions": action_names()}
        if method == "native.call":
            return await asyncio.to_thread(
                native_call,
                str(params.get("native_method") or ""),
                dict(params.get("native_params") or {}),
            )
        if method == "compile":
            return await asyncio.to_thread(
                compile_instruction,
                str(params.get("instruction") or ""),
                provider=dict(params.get("provider") or {}),
                step_type=str(params.get("step_type") or "normal"),
                context=dict(params.get("context") or {}),
                force_run=bool(params.get("force_run")),
                maximum_attempts=int(params.get("maximum_attempts") or 3),
            )
        if method == "execute":
            return await self.supervisor.execute(
                request_id,
                dict(params["plan"]),
                params,
                lambda event: self.progress(request_id, event),
            )
        if method == "compile_execute":
            plan = await asyncio.to_thread(
                compile_instruction,
                str(params.get("instruction") or ""),
                provider=dict(params.get("provider") or {}),
                step_type=str(params.get("step_type") or "normal"),
                context=dict(params.get("context") or {}),
                force_run=True,
                maximum_attempts=int(params.get("maximum_attempts") or 3),
            )
            return await self.supervisor.execute(
                request_id,
                plan,
                params,
                lambda event: self.progress(request_id, event),
            )
        raise ValueError(f"Unknown Python runtime method: {method}")

    async def handle(self, message: dict[str, Any]) -> None:
        request_id = str(message.get("id") or "")
        method = str(message.get("method") or "")
        params = dict(message.get("params") or {})
        if not request_id:
            return
        if method == "cancel":
            target = str(params.get("request_id") or "")
            task = self.tasks.get(target)
            process_cancelled = await self.supervisor.cancel(target)
            if task and not task.done():
                task.cancel()
            await self.write(
                {
                    "id": request_id,
                    "ok": True,
                    "result": {"cancelled": bool(task or process_cancelled), "request_id": target},
                }
            )
            return
        try:
            result = await self.dispatch(request_id, method, params)
            await self.write({"id": request_id, "ok": True, "result": result})
        except asyncio.CancelledError:
            await self.write(
                {
                    "id": request_id,
                    "ok": False,
                    "error": {"code": "cancelled", "message": "Stopped by the user."},
                }
            )
        except Exception as error:
            await self.write(
                {
                    "id": request_id,
                    "ok": False,
                    "error": {"code": type(error).__name__, "message": str(error)},
                }
            )
        finally:
            self.tasks.pop(request_id, None)

    async def run(self) -> None:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            request_id = str(message.get("id") or "")
            method = str(message.get("method") or "")
            if method == "cancel":
                await self.handle(message)
                continue
            task = asyncio.create_task(self.handle(message))
            if request_id:
                self.tasks[request_id] = task
        if self.tasks:
            await asyncio.gather(*list(self.tasks.values()), return_exceptions=True)

def run_service() -> int:
    asyncio.run(RuntimeService().run())
    return 0
