from __future__ import annotations

import asyncio
import hashlib
import json
import os
import pathlib
import signal
import shutil
import subprocess
import sys
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from .compiler import repair_plan
from .context import EVENT_PREFIX

ProgressHandler = Callable[[dict[str, Any]], Awaitable[None]]
_cached_worker_executable: str | None = None

def _frozen_worker_executable() -> str:
    global _cached_worker_executable
    if _cached_worker_executable and pathlib.Path(_cached_worker_executable).exists():
        return _cached_worker_executable
    source = pathlib.Path(sys.executable).resolve()
    digest = hashlib.sha256(source.read_bytes()).hexdigest()[:16]
    local_app_data = pathlib.Path(
        os.environ.get("LOCALAPPDATA")
        or pathlib.Path.home() / "AppData" / "Local"
    )
    cache = local_app_data / "OmniAgent" / "PythonRuntime"
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / f"OmniAgent.Worker-{digest}.exe"
    if not target.exists() or target.stat().st_size != source.stat().st_size:
        temporary = cache / f".{target.name}.{uuid.uuid4().hex}.tmp"
        shutil.copy2(source, temporary)
        os.replace(temporary, target)
    for old_worker in cache.glob("OmniAgent.Worker-*.exe"):
        if old_worker == target:
            continue
        try:
            old_worker.unlink()
        except OSError:
            pass
    _cached_worker_executable = str(target)
    return _cached_worker_executable

def _worker_command(program_path: str, context_path: str, result_path: str) -> list[str]:
    if getattr(sys, "frozen", False):
        return [_frozen_worker_executable(), "--worker", program_path, context_path, result_path]
    return [
        sys.executable,
        "-m",
        "omniagent_runtime",
        "--worker",
        program_path,
        context_path,
        result_path,
    ]

def _clear_inherited_windows_dll_directory() -> str | None:
    if os.name != "nt" or not getattr(sys, "frozen", False):
        return None
    import ctypes

    bundle_directory = str(getattr(sys, "_MEIPASS", "") or "")
    ctypes.windll.kernel32.SetDllDirectoryW(None)
    return bundle_directory

def _restore_windows_dll_directory(bundle_directory: str | None) -> None:
    if not bundle_directory:
        return
    import ctypes

    ctypes.windll.kernel32.SetDllDirectoryW(bundle_directory)

async def _terminate_process_tree(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            check=False,
            capture_output=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
    try:
        await asyncio.wait_for(process.wait(), timeout=5)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()

def _verification(
    plan: dict[str, Any],
    execution: dict[str, Any],
    output_dir: pathlib.Path,
) -> dict[str, Any]:
    evidence: list[dict[str, Any]] = []
    passed = bool(execution.get("ok"))
    for pattern in plan.get("expected_outputs") or []:
        raw = str(pattern)
        candidate = pathlib.Path(raw)
        if candidate.is_absolute():
            matches = [candidate] if candidate.exists() else []
        else:
            matches = list(output_dir.glob(raw))
        item_passed = bool(matches)
        passed = passed and item_passed
        evidence.append(
            {
                "kind": "output",
                "expected": raw,
                "passed": item_passed,
                "matches": [str(item.resolve()) for item in matches[:100]],
            }
        )
    artifacts = []
    for artifact in execution.get("artifacts") or []:
        target = pathlib.Path(str(artifact))
        exists = target.exists()
        passed = passed and exists
        artifacts.append(
            {
                "path": str(target),
                "exists": exists,
                "size": target.stat().st_size if exists and target.is_file() else None,
            }
        )
    return {"passed": passed, "evidence": evidence, "artifacts": artifacts}

class AutomationSupervisor:
    def __init__(self) -> None:
        self.processes: dict[str, asyncio.subprocess.Process] = {}

    async def cancel(self, request_id: str) -> bool:
        process = self.processes.get(request_id)
        if not process:
            return False
        await _terminate_process_tree(process)
        return True

    async def execute(
        self,
        request_id: str,
        plan: dict[str, Any],
        parameters: dict[str, Any],
        progress: ProgressHandler,
    ) -> dict[str, Any]:
        output_dir = pathlib.Path(parameters["output_dir"]).resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        internal_dir = output_dir / ".omniagent"
        internal_dir.mkdir(parents=True, exist_ok=True)
        provider = dict(parameters.get("provider") or {})
        public_provider = {
            key: value
            for key, value in provider.items()
            if key not in {"api_key", "secret", "token", "access_token"}
        }
        maximum_attempts = max(1, min(3, int(plan.get("max_attempts") or 1)))
        current_plan = dict(plan)
        attempt_results: list[dict[str, Any]] = []
        for attempt in range(1, maximum_attempts + 1):
            await progress(
                {
                    "type": "progress",
                    "message": "Preparing the Python automation." if attempt == 1 else "Repairing and retrying the automation.",
                    "percent": 3 if attempt == 1 else min(75, 35 + attempt * 15),
                    "attempt": attempt,
                }
            )
            token = f"{attempt}-{uuid.uuid4().hex[:10]}"
            program_path = internal_dir / f"program-{token}.py"
            context_path = internal_dir / f"context-{token}.json"
            result_path = internal_dir / f"result-{token}.json"
            program_path.write_text(str(current_plan["code"]), encoding="utf-8")
            context_path.write_text(
                json.dumps(
                    {
                        "instruction": current_plan.get("instruction") or "",
                        "output_dir": str(output_dir),
                        "workspace": parameters.get("workspace") or str(output_dir),
                        "inputs": parameters.get("inputs") or {},
                        "data": parameters.get("data") or {},
                        "provider": public_provider,
                    },
                    ensure_ascii=False,
                    default=str,
                ),
                encoding="utf-8",
            )
            started = time.monotonic()
            worker_environment = os.environ.copy()
            if getattr(sys, "frozen", False):
                for environment_key in list(worker_environment):
                    if environment_key.startswith("_PYI_") or environment_key.startswith("PYINSTALLER_"):
                        worker_environment.pop(environment_key, None)
            if provider:
                worker_environment["OMNIAGENT_PROVIDER_JSON"] = json.dumps(
                    provider, ensure_ascii=False, default=str
                )
            bundle_directory = _clear_inherited_windows_dll_directory()
            try:
                process = await asyncio.create_subprocess_exec(
                    *_worker_command(str(program_path), str(context_path), str(result_path)),
                    cwd=str(output_dir),
                    env=worker_environment,
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    start_new_session=os.name != "nt",
                )
            finally:
                _restore_windows_dll_directory(bundle_directory)
            self.processes[request_id] = process
            stdout_lines: list[str] = []
            stderr_lines: list[str] = []

            async def consume_stdout() -> None:
                assert process.stdout is not None
                while line := await process.stdout.readline():
                    text = line.decode("utf-8", errors="replace").rstrip()
                    if text.startswith(EVENT_PREFIX):
                        try:
                            event = json.loads(text[len(EVENT_PREFIX) :])
                            await progress(event)
                        except json.JSONDecodeError:
                            stdout_lines.append(text)
                    else:
                        stdout_lines.append(text)

            async def consume_stderr() -> None:
                assert process.stderr is not None
                while line := await process.stderr.readline():
                    stderr_lines.append(line.decode("utf-8", errors="replace").rstrip())

            consumers = [asyncio.create_task(consume_stdout()), asyncio.create_task(consume_stderr())]
            try:
                await asyncio.wait_for(
                    process.wait(),
                    timeout=max(5, min(3_600, int(current_plan.get("timeout_seconds") or 300))),
                )
            except asyncio.CancelledError:
                await _terminate_process_tree(process)
                raise
            except asyncio.TimeoutError:
                await _terminate_process_tree(process)
                stderr_lines.append("The generated Python automation exceeded its timeout.")
            finally:
                await asyncio.gather(*consumers, return_exceptions=True)
                if self.processes.get(request_id) is process:
                    self.processes.pop(request_id, None)

            if result_path.exists():
                try:
                    execution = json.loads(result_path.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    execution = {"ok": False, "error": {"message": "The worker produced an unreadable result."}}
            else:
                execution = {
                    "ok": False,
                    "error": {
                        "message": "The Python worker exited without a result.",
                        "returncode": process.returncode,
                    },
                }
            execution["stdout"] = "\n".join(stdout_lines)[-200_000:]
            execution["stderr"] = "\n".join(stderr_lines)[-200_000:]
            execution["duration_ms"] = int((time.monotonic() - started) * 1_000)
            verification = _verification(current_plan, execution, output_dir)
            attempt_result = {
                "attempt": attempt,
                "plan_id": current_plan.get("plan_id"),
                "execution": execution,
                "verification": verification,
            }
            attempt_results.append(attempt_result)
            if execution.get("ok") and verification.get("passed"):
                result_value = execution.get("result")
                public_summary = ""
                if isinstance(result_value, dict):
                    public_summary = str(
                        result_value.get("public_message")
                        or result_value.get("summary")
                        or result_value.get("message")
                        or ""
                    )
                elif isinstance(result_value, str):
                    public_summary = result_value
                return {
                    "ok": True,
                    "plan": current_plan,
                    "result": result_value,
                    "public_summary": public_summary[:2_000],
                    "artifacts": verification["artifacts"],
                    "verification": verification,
                    "attempts": attempt_results,
                    "data": execution.get("data") or {},
                    "duration_ms": sum(item["execution"]["duration_ms"] for item in attempt_results),
                }
            if attempt >= maximum_attempts or not provider:
                break
            await progress(
                {
                    "type": "progress",
                    "message": "That approach didn’t work, so I’m trying another.",
                    "percent": min(80, 30 + attempt * 20),
                    "attempt": attempt,
                }
            )
            current_plan = await asyncio.to_thread(
                repair_plan,
                current_plan,
                attempt_result,
                provider=provider,
                context={
                    "output_dir": str(output_dir),
                    "workspace": parameters.get("workspace"),
                    "inputs": parameters.get("inputs") or {},
                },
            )
        latest = attempt_results[-1] if attempt_results else {}
        return {
            "ok": False,
            "plan": current_plan,
            "error": latest.get("execution", {}).get("error")
            or {"message": "The Python automation did not complete successfully."},
            "verification": latest.get("verification") or {"passed": False, "evidence": []},
            "attempts": attempt_results,
            "artifacts": latest.get("verification", {}).get("artifacts") or [],
            "duration_ms": sum(
                int(item.get("execution", {}).get("duration_ms") or 0) for item in attempt_results
            ),
        }
