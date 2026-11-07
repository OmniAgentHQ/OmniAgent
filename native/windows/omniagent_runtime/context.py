from __future__ import annotations

import base64
import json
import os
import pathlib
import subprocess
import sys
import urllib.request
from typing import Any

from .capabilities import execute_action
from .provider import generate_image, generate_text

EVENT_PREFIX = "OMNIAGENT_EVENT="

class AutomationContext:
    def __init__(self, payload: dict[str, Any]):
        self.instruction = str(payload.get("instruction") or "")
        self.output_dir = str(pathlib.Path(payload["output_dir"]).resolve())
        self.workspace = str(pathlib.Path(payload.get("workspace") or self.output_dir).resolve())
        self.inputs = dict(payload.get("inputs") or {})
        self.data = dict(payload.get("data") or {})
        self.provider = dict(payload.get("provider") or {})
        self._artifacts: list[str] = []
        pathlib.Path(self.output_dir).mkdir(parents=True, exist_ok=True)

    @property
    def artifacts(self) -> list[str]:
        return list(self._artifacts)

    def progress(self, message: str, percent: int | float | None = None, **details: Any) -> None:
        event = {
            "type": "progress",
            "message": str(message)[:1_000],
            "percent": None if percent is None else max(0, min(100, int(percent))),
            "details": details,
        }
        print(f"{EVENT_PREFIX}{json.dumps(event, ensure_ascii=False)}", flush=True)

    def artifact(self, target: str | os.PathLike[str]) -> str:
        resolved = str(pathlib.Path(target).resolve())
        if resolved not in self._artifacts:
            self._artifacts.append(resolved)
        return resolved

    def output_path(self, relative_path: str) -> str:
        candidate = (pathlib.Path(self.output_dir) / relative_path).resolve()
        output_root = pathlib.Path(self.output_dir).resolve()
        if candidate != output_root and output_root not in candidate.parents:
            raise ValueError("Output path escaped the run output directory.")
        return str(candidate)

    def call(self, operation: str, **arguments: Any) -> Any:
        return execute_action(operation, self, arguments)

    def ai_text(self, prompt: str, timeout: int = 180) -> str:
        return generate_text(self.provider, prompt, timeout=timeout)

    def ai_image(self, prompt: str, relative_path: str = "generated-image.png", timeout: int = 180) -> str:
        target = pathlib.Path(self.output_path(relative_path))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(generate_image(self.provider, prompt, timeout=timeout))
        return self.artifact(target)

    def write_text(self, relative_path: str, content: str, encoding: str = "utf-8") -> str:
        target = pathlib.Path(self.output_path(relative_path))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding=encoding)
        return self.artifact(target)

    def write_bytes(self, relative_path: str, content: bytes) -> str:
        target = pathlib.Path(self.output_path(relative_path))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        return self.artifact(target)

    def write_base64(self, relative_path: str, content: str) -> str:
        return self.write_bytes(relative_path, base64.b64decode(content))

    def read_text(self, target: str, encoding: str = "utf-8") -> str:
        return pathlib.Path(os.path.expandvars(os.path.expanduser(target))).read_text(
            encoding=encoding, errors="replace"
        )

    def open_path(self, target: str) -> str:
        resolved = str(pathlib.Path(os.path.expandvars(os.path.expanduser(target))).resolve())
        os.startfile(resolved)
        return resolved

    def open_url(self, url: str) -> str:
        return str(self.call("browser.open", url=url))

    def browser(self, operation: str, **arguments: Any) -> Any:
        name = operation if operation.startswith("browser.") else f"browser.{operation}"
        return self.call(name, **arguments)

    def run(
        self,
        command: str | list[str],
        *,
        cwd: str | None = None,
        timeout: int = 300,
        check: bool = True,
        shell: bool | None = None,
    ) -> dict[str, Any]:
        result = self.call(
            "process.run",
            command=command,
            cwd=cwd,
            timeout=timeout,
            shell=isinstance(command, str) if shell is None else shell,
        )
        if check and int(result["returncode"]) != 0:
            raise RuntimeError(
                f"Command failed with exit code {result['returncode']}: {result['stderr'][-4_000:]}"
            )
        return result

    def powershell(self, script: str, *, timeout: int = 300, check: bool = True) -> dict[str, Any]:
        return self.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ],
            timeout=timeout,
            check=check,
            shell=False,
        )

    def windows(self) -> list[dict[str, Any]]:
        try:
            from pywinauto import Desktop
        except ImportError as error:
            raise RuntimeError("Windows UI Automation support is not installed in this runtime.") from error
        result: list[dict[str, Any]] = []
        for window in Desktop(backend="uia").windows():
            try:
                result.append(
                    {
                        "title": window.window_text(),
                        "class_name": window.class_name(),
                        "handle": int(window.handle),
                        "visible": window.is_visible(),
                        "enabled": window.is_enabled(),
                    }
                )
            except Exception:
                continue
        return result

    def window_controls(
        self,
        title_re: str,
        *,
        control_type: str | None = None,
        maximum: int = 2_000,
    ) -> list[dict[str, Any]]:
        try:
            from pywinauto import Desktop
        except ImportError as error:
            raise RuntimeError("Windows UI Automation support is not installed in this runtime.") from error
        window = Desktop(backend="uia").window(title_re=title_re)
        controls: list[dict[str, Any]] = []
        for control in window.descendants(control_type=control_type):
            try:
                info = control.element_info
                controls.append(
                    {
                        "name": control.window_text(),
                        "automation_id": info.automation_id,
                        "control_type": info.control_type,
                        "class_name": info.class_name,
                        "rectangle": [
                            info.rectangle.left,
                            info.rectangle.top,
                            info.rectangle.right,
                            info.rectangle.bottom,
                        ],
                        "enabled": control.is_enabled(),
                        "visible": control.is_visible(),
                    }
                )
            except Exception:
                continue
            if len(controls) >= maximum:
                break
        return controls

    def window_invoke(
        self,
        title_re: str,
        *,
        title: str | None = None,
        auto_id: str | None = None,
        control_type: str | None = None,
    ) -> bool:
        try:
            from pywinauto import Desktop
        except ImportError as error:
            raise RuntimeError("Windows UI Automation support is not installed in this runtime.") from error
        window = Desktop(backend="uia").window(title_re=title_re)
        control = window.child_window(title=title, auto_id=auto_id, control_type=control_type)
        wrapper = control.wrapper_object()
        if hasattr(wrapper, "invoke"):
            wrapper.invoke()
        else:
            wrapper.click_input()
        return True

    def download(self, url: str, relative_path: str, timeout: int = 90) -> str:
        target = pathlib.Path(self.output_path(relative_path))
        target.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 OmniAgent/0.3"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            target.write_bytes(response.read())
        return self.artifact(target)

def execute_program(program_path: str, context_path: str, result_path: str) -> int:
    payload = json.loads(pathlib.Path(context_path).read_text(encoding="utf-8"))
    provider_json = os.environ.pop("OMNIAGENT_PROVIDER_JSON", "")
    if provider_json:
        payload["provider"] = json.loads(provider_json)
    ctx = AutomationContext(payload)
    namespace: dict[str, Any] = {
        "__name__": "__omniagent_automation__",
        "__file__": program_path,
        "ctx": ctx,
    }
    try:
        code = pathlib.Path(program_path).read_text(encoding="utf-8")
        exec(compile(code, program_path, "exec"), namespace, namespace)
        main = namespace.get("main")
        if not callable(main):
            raise RuntimeError("The generated program does not define main(ctx).")
        result = main(ctx)
        if hasattr(result, "__await__"):
            import asyncio

            result = asyncio.run(result)
        response = {
            "ok": True,
            "result": result,
            "artifacts": ctx.artifacts,
            "data": ctx.data,
        }
        pathlib.Path(result_path).write_text(
            json.dumps(response, ensure_ascii=False, default=str), encoding="utf-8"
        )
        return 0
    except BaseException as error:
        import traceback

        response = {
            "ok": False,
            "error": {
                "type": type(error).__name__,
                "message": str(error),
                "traceback": traceback.format_exc(limit=30),
            },
            "artifacts": ctx.artifacts,
            "data": ctx.data,
        }
        pathlib.Path(result_path).write_text(
            json.dumps(response, ensure_ascii=False, default=str), encoding="utf-8"
        )
        return 1
    finally:
        pass
