from __future__ import annotations

import base64
import csv
import fnmatch
import json
import os
import pathlib
import shutil
import subprocess
import urllib.request
import webbrowser
import zipfile
from collections.abc import Callable
from typing import Any

ActionHandler = Callable[[Any, dict[str, Any]], Any]
_ACTIONS: dict[str, ActionHandler] = {}

def action(name: str) -> Callable[[ActionHandler], ActionHandler]:
    def register(handler: ActionHandler) -> ActionHandler:
        _ACTIONS[name] = handler
        return handler

    return register

def action_names() -> list[str]:
    return sorted(_ACTIONS)

def execute_action(name: str, ctx: Any, arguments: dict[str, Any] | None = None) -> Any:
    handler = _ACTIONS.get(name)
    if not handler and name.startswith("browser."):
        return _browser_request(ctx, name, arguments or {})
    if not handler:
        raise ValueError(f"Unknown Python automation action: {name}")
    return handler(ctx, arguments or {})

def _path(value: Any) -> pathlib.Path:
    return pathlib.Path(os.path.expandvars(os.path.expanduser(str(value)))).resolve()

@action("filesystem.exists")
def filesystem_exists(_ctx: Any, arguments: dict[str, Any]) -> bool:
    return _path(arguments["path"]).exists()

@action("filesystem.mkdir")
def filesystem_mkdir(_ctx: Any, arguments: dict[str, Any]) -> str:
    target = _path(arguments["path"])
    target.mkdir(parents=True, exist_ok=True)
    return str(target)

@action("filesystem.list")
def filesystem_list(_ctx: Any, arguments: dict[str, Any]) -> list[dict[str, Any]]:
    root = _path(arguments["path"])
    recursive = bool(arguments.get("recursive"))
    maximum = max(1, min(100_000, int(arguments.get("maximum") or 10_000)))
    iterator = root.rglob("*") if recursive else root.iterdir()
    result: list[dict[str, Any]] = []
    for item in iterator:
        result.append(
            {
                "path": str(item),
                "name": item.name,
                "is_file": item.is_file(),
                "is_dir": item.is_dir(),
                "suffix": item.suffix,
            }
        )
        if len(result) >= maximum:
            break
    return result

@action("filesystem.find")
def filesystem_find(_ctx: Any, arguments: dict[str, Any]) -> list[str]:
    root = _path(arguments["root"])
    patterns = [str(item).lower() for item in arguments.get("patterns") or ["*"]]
    recursive = arguments.get("recursive", True) is not False
    maximum = max(1, min(100_000, int(arguments.get("maximum") or 20_000)))
    iterator = root.rglob("*") if recursive else root.iterdir()
    matches: list[str] = []
    for item in iterator:
        if any(fnmatch.fnmatch(item.name.lower(), pattern) for pattern in patterns):
            matches.append(str(item))
            if len(matches) >= maximum:
                break
    return matches

@action("filesystem.read_text")
def filesystem_read_text(_ctx: Any, arguments: dict[str, Any]) -> str:
    return _path(arguments["path"]).read_text(
        encoding=str(arguments.get("encoding") or "utf-8"), errors="replace"
    )

@action("filesystem.write_text")
def filesystem_write_text(ctx: Any, arguments: dict[str, Any]) -> str:
    target = _path(arguments["path"])
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        str(arguments.get("content") or ""),
        encoding=str(arguments.get("encoding") or "utf-8"),
    )
    ctx.artifact(target)
    return str(target)

@action("filesystem.write_base64")
def filesystem_write_base64(ctx: Any, arguments: dict[str, Any]) -> str:
    target = _path(arguments["path"])
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(base64.b64decode(str(arguments.get("content") or "")))
    ctx.artifact(target)
    return str(target)

@action("filesystem.copy")
def filesystem_copy(_ctx: Any, arguments: dict[str, Any]) -> str:
    source = _path(arguments["source"])
    destination = _path(arguments["destination"])
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, destination, dirs_exist_ok=bool(arguments.get("merge", True)))
    else:
        shutil.copy2(source, destination)
    return str(destination)

@action("filesystem.move")
def filesystem_move(_ctx: Any, arguments: dict[str, Any]) -> str:
    destination = _path(arguments["destination"])
    destination.parent.mkdir(parents=True, exist_ok=True)
    return str(shutil.move(str(_path(arguments["source"])), str(destination)))

@action("filesystem.open")
def filesystem_open(_ctx: Any, arguments: dict[str, Any]) -> str:
    target = _path(arguments["path"])
    os.startfile(str(target))
    return str(target)

@action("filesystem.delete")
def filesystem_delete(_ctx: Any, arguments: dict[str, Any]) -> bool:
    target = _path(arguments["path"])
    if target.parent == target:
        raise ValueError("Refusing to remove a filesystem root.")
    if target.is_dir():
        shutil.rmtree(target)
    elif target.exists():
        target.unlink()
    return not target.exists()

@action("process.run")
def process_run(_ctx: Any, arguments: dict[str, Any]) -> dict[str, Any]:
    command = arguments["command"]
    shell = bool(arguments.get("shell", isinstance(command, str)))
    result = subprocess.run(
        command,
        cwd=arguments.get("cwd"),
        env={**os.environ, **{str(k): str(v) for k, v in (arguments.get("env") or {}).items()}},
        shell=shell,
        capture_output=True,
        text=True,
        timeout=max(1, min(3_600, int(arguments.get("timeout") or 300))),
        check=False,
    )
    return {
        "returncode": result.returncode,
        "stdout": result.stdout[-200_000:],
        "stderr": result.stderr[-200_000:],
    }

@action("process.start")
def process_start(_ctx: Any, arguments: dict[str, Any]) -> dict[str, Any]:
    command = arguments["command"]
    process = subprocess.Popen(
        command,
        cwd=arguments.get("cwd"),
        shell=bool(arguments.get("shell", isinstance(command, str))),
        creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )
    return {"pid": process.pid}

@action("network.request")
def network_request(_ctx: Any, arguments: dict[str, Any]) -> dict[str, Any]:
    body = arguments.get("body")
    data = None if body is None else (
        body.encode("utf-8") if isinstance(body, str) else json.dumps(body).encode("utf-8")
    )
    request = urllib.request.Request(
        str(arguments["url"]),
        data=data,
        headers={str(k): str(v) for k, v in (arguments.get("headers") or {}).items()},
        method=str(arguments.get("method") or ("POST" if data else "GET")).upper(),
    )
    with urllib.request.urlopen(request, timeout=int(arguments.get("timeout") or 60)) as response:
        payload = response.read(max(1, min(100_000_000, int(arguments.get("maximum_bytes") or 25_000_000))))
        return {
            "status": response.status,
            "headers": dict(response.headers),
            "text": payload.decode("utf-8", errors="replace"),
            "body_base64": base64.b64encode(payload).decode("ascii"),
        }

@action("network.download")
def network_download(ctx: Any, arguments: dict[str, Any]) -> str:
    target = _path(arguments["path"])
    target.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        str(arguments["url"]),
        headers={"User-Agent": "Mozilla/5.0 OmniAgent/0.3", **(arguments.get("headers") or {})},
    )
    with urllib.request.urlopen(request, timeout=int(arguments.get("timeout") or 90)) as response:
        with target.open("wb") as stream:
            shutil.copyfileobj(response, stream)
    ctx.artifact(target)
    return str(target)

@action("browser.open")
def browser_open(ctx: Any, arguments: dict[str, Any]) -> Any:
    url = str(arguments["url"])
    if not url.lower().startswith(("https://", "http://")):
        raise ValueError("Browser URLs must use HTTP or HTTPS.")
    if not webbrowser.open_new_tab(url):
        raise RuntimeError("Windows could not open the URL in the default browser.")
    return url

def _browser_request(ctx: Any, method: str, arguments: dict[str, Any]) -> Any:
    if method in {"browser.open", "browser.navigate"}:
        return browser_open(ctx, arguments)
    raise RuntimeError(
        "Direct browser-page commands are unavailable in the normal browser session. "
        "Use semantic Windows UI Automation on the visible default-browser window."
    )

@action("browser.navigate")
def browser_navigate(ctx: Any, arguments: dict[str, Any]) -> Any:
    return _browser_request(ctx, "browser.navigate", arguments)

@action("browser.snapshot")
def browser_snapshot(ctx: Any, arguments: dict[str, Any]) -> Any:
    return _browser_request(ctx, "browser.snapshot", arguments)

@action("browser.click")
def browser_click(ctx: Any, arguments: dict[str, Any]) -> Any:
    params = dict(arguments)
    params["operation"] = "click"
    if "target_id" in params:
        params["targetId"] = params.pop("target_id")
    return _browser_request(ctx, "browser.action", params)

@action("browser.fill")
def browser_fill(ctx: Any, arguments: dict[str, Any]) -> Any:
    params = dict(arguments)
    params["operation"] = "fill"
    if "target_id" in params:
        params["targetId"] = params.pop("target_id")
    return _browser_request(ctx, "browser.action", params)

@action("browser.press")
def browser_press(ctx: Any, arguments: dict[str, Any]) -> Any:
    params = dict(arguments)
    params["operation"] = "press"
    if "target_id" in params:
        params["targetId"] = params.pop("target_id")
    return _browser_request(ctx, "browser.action", params)

@action("browser.scroll")
def browser_scroll(ctx: Any, arguments: dict[str, Any]) -> Any:
    return _browser_request(ctx, "browser.scroll", arguments)

@action("browser.back")
def browser_back(ctx: Any, arguments: dict[str, Any]) -> Any:
    return _browser_request(ctx, "browser.back", arguments)

@action("browser.reload")
def browser_reload(ctx: Any, arguments: dict[str, Any]) -> Any:
    return _browser_request(ctx, "browser.reload", arguments)

@action("browser.query")
def browser_query(ctx: Any, arguments: dict[str, Any]) -> Any:
    return _browser_request(ctx, "browser.query", arguments)

@action("browser.extract")
def browser_extract(ctx: Any, arguments: dict[str, Any]) -> Any:
    return _browser_request(ctx, "browser.extract", arguments)

@action("browser.wait")
def browser_wait(ctx: Any, arguments: dict[str, Any]) -> Any:
    return _browser_request(ctx, "browser.wait", arguments)

@action("archive.extract")
def archive_extract(_ctx: Any, arguments: dict[str, Any]) -> str:
    archive = _path(arguments["path"])
    destination = _path(arguments["destination"])
    destination.mkdir(parents=True, exist_ok=True)
    if archive.suffix.lower() == ".zip":
        with zipfile.ZipFile(archive) as handle:
            for member in handle.infolist():
                candidate = (destination / member.filename).resolve()
                if destination not in candidate.parents and candidate != destination:
                    raise ValueError("Archive contains an unsafe path.")
            handle.extractall(destination)
    else:
        shutil.unpack_archive(str(archive), str(destination))
    return str(destination)

@action("data.write_csv")
def data_write_csv(ctx: Any, arguments: dict[str, Any]) -> str:
    target = _path(arguments["path"])
    rows = list(arguments.get("rows") or [])
    target.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = list(arguments.get("fieldnames") or (rows[0].keys() if rows and isinstance(rows[0], dict) else []))
    with target.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    ctx.artifact(target)
    return str(target)
