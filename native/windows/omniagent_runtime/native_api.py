from __future__ import annotations

import ctypes
import fnmatch
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import time
from typing import Any

def _pattern_value(read: Any, default: Any) -> Any:
    try:
        return read()
    except Exception:
        return default

def _element_record(control: Any, parent_index: int = -1) -> dict[str, Any]:
    info = control.element_info
    rectangle = info.rectangle
    patterns: list[str] = []
    for name in ("invoke", "value", "selection_item", "toggle", "expand_collapse", "scroll_item"):
        try:
            if control.iface_pattern(name):
                patterns.append(name)
        except Exception:
            continue
    value = ""
    try:
        value = str(control.get_value())
    except Exception:
        try:
            value = str(control.window_text())
        except Exception:
            pass
    return {
        "parentIndex": parent_index,
        "name": str(control.window_text() or ""),
        "automationId": str(info.automation_id or ""),
        "className": str(info.class_name or ""),
        "controlType": str(info.control_type or ""),
        "processId": int(info.process_id or 0),
        "enabled": bool(control.is_enabled()),
        "offscreen": not bool(control.is_visible()),
        "focusable": bool(getattr(info, "focusable", False)),
        "focused": bool(control.has_keyboard_focus()),
        "password": bool(getattr(info, "is_password", False)),
        "helpText": str(getattr(info, "help_text", "") or ""),
        "accessKey": str(getattr(info, "access_key", "") or ""),
        "value": value,
        "selected": bool(_pattern_value(lambda: getattr(control, "is_selected", lambda: False)(), False)),
        "checked": bool(_pattern_value(lambda: getattr(control, "get_toggle_state", lambda: 0)(), 0)),
        "expanded": str(_pattern_value(lambda: getattr(control, "get_expand_state", lambda: "")(), "")).lower().endswith("expanded"),
        "bounds": {
            "x": int(rectangle.left),
            "y": int(rectangle.top),
            "width": int(rectangle.width()),
            "height": int(rectangle.height()),
        },
        "patterns": patterns,
    }

def _desktop() -> Any:
    from pywinauto import Desktop

    return Desktop(backend="uia")

def _window(scope: dict[str, Any] | None) -> Any:
    scope = scope or {}
    desktop = _desktop()
    handle = scope.get("handle")
    if handle:
        return desktop.window(handle=int(str(handle), 0))
    process_id = scope.get("processId")
    if process_id:
        return desktop.window(process=int(process_id))
    title = str(scope.get("title") or "")
    if title:
        pattern = ".*".join(re.escape(part) for part in title.split("*"))
        return desktop.window(title_re=f".*{pattern}.*")
    return desktop.top_window()

def _matches(record: dict[str, Any], selector: dict[str, Any]) -> bool:
    mappings = {
        "name": "name",
        "automationId": "automationId",
        "className": "className",
        "controlType": "controlType",
    }
    for source, target in mappings.items():
        expected = selector.get(source)
        if expected is not None and str(record.get(target) or "").lower() != str(expected).lower():
            return False
    contains = selector.get("nameContains")
    if contains is not None and str(contains).lower() not in str(record.get("name") or "").lower():
        return False
    text = selector.get("text")
    if text is not None and str(text).lower() not in (
        f"{record.get('name', '')} {record.get('value', '')}".lower()
    ):
        return False
    return True

def _query(params: dict[str, Any]) -> list[Any]:
    window = _window(params.get("window") or (params.get("target") or {}).get("scope"))
    selector = dict(params.get("selector") or (params.get("target") or {}).get("match") or {})
    descendants = [window, *window.descendants()]
    matches = []
    for control in descendants:
        try:
            if _matches(_element_record(control), selector):
                matches.append(control)
        except Exception:
            continue
    selection = str(params.get("selection") or (params.get("target") or {}).get("selection") or "first")
    index = int(params.get("index") or 0)
    if selection in {"all", "many"}:
        return matches
    if selection == "last":
        return matches[-1:] if matches else []
    return matches[index : index + 1]

def _uia_call(method: str, params: dict[str, Any]) -> Any:
    if method == "uia.snapshot":
        window = _window(params.get("window"))
        maximum = max(1, min(10_000, int(params.get("maxElements") or 1_000)))
        descendants = window.descendants()
        elements = []
        for control in descendants[:maximum]:
            try:
                elements.append(_element_record(control))
            except Exception:
                continue
        return {
            "root": _element_record(window),
            "elements": elements,
            "truncated": len(descendants) > maximum,
        }
    controls = _query(params)
    if method == "uia.query":
        return {"count": len(controls), "elements": [_element_record(item) for item in controls]}
    if method in {"uia.invoke", "uia.setValue", "uia.select"}:
        operation = {"uia.invoke": "invoke", "uia.setValue": "fill", "uia.select": "select"}[method]
    else:
        operation = str(params.get("operation") or "")
    if method == "uia.assert":
        assertion = str(params.get("assertion") or "exists")
        expected = params.get("expected")
        actual: Any = len(controls)
        if controls and assertion in {"textEquals", "valueEquals", "contains"}:
            record = _element_record(controls[0])
            actual = record["value"] or record["name"]
        passed = (
            bool(controls) if assertion in {"exists", "visible", "enabled"}
            else not controls if assertion in {"notExists", "hidden"}
            else str(actual) == str(expected) if assertion in {"textEquals", "valueEquals", "equals"}
            else str(expected).lower() in str(actual).lower() if assertion == "contains"
            else bool(actual)
        )
        return {"passed": passed, "actual": actual, "count": len(controls)}
    results = []
    value = params.get("value")
    for control in controls:
        if operation in {"invoke", "click"}:
            try:
                control.invoke()
            except Exception:
                control.click_input()
            results.append({"invoked": True})
        elif operation in {"fill", "setValue", "type"}:
            try:
                control.set_edit_text(str(value or params.get("value") or ""))
            except Exception:
                control.set_focus()
                control.type_keys(str(value or ""), with_spaces=True, set_foreground=False)
            results.append({"set": True, "value": str(value or "")})
        elif operation == "select":
            control.select()
            results.append({"selected": True})
        elif operation == "toggle":
            control.toggle()
            results.append({"toggled": True})
        elif operation == "expand":
            control.expand()
            results.append({"expanded": True})
        elif operation == "collapse":
            control.collapse()
            results.append({"collapsed": True})
        elif operation == "focus":
            control.set_focus()
            results.append({"focused": True})
        elif operation == "read":
            results.append(_element_record(control))
        else:
            raise ValueError(f"Unsupported Python UI Automation operation: {operation}")
    if method == "uia.setValue":
        return results[0] if results else {"set": False, "value": ""}
    if method in {"uia.invoke", "uia.select"}:
        return results[0] if results else {"count": 0}
    return {"count": len(controls), "results": results}

def _filesystem(method: str, params: dict[str, Any]) -> Any:
    operation = method.split(".", 1)[1]
    if operation == "authorizeRoot":
        return {"authorized": str(params.get("path") or "")}
    target_value = params.get("path")
    target = pathlib.Path(str(target_value)).resolve() if target_value else None
    if operation == "exists":
        return {"exists": bool(target and target.exists()), "path": str(target) if target else ""}
    if operation == "stat" and target:
        stat = target.stat()
        return {
            "path": str(target), "size": stat.st_size, "isFile": target.is_file(),
            "isDirectory": target.is_dir(), "modifiedAt": stat.st_mtime,
        }
    if operation == "list" and target:
        return {
            "entries": [
                {"name": item.name, "path": str(item), "isFile": item.is_file(), "isDirectory": item.is_dir()}
                for item in target.iterdir()
            ]
        }
    if operation == "search":
        root = pathlib.Path(str(params.get("root") or params.get("path"))).resolve()
        pattern = str(params.get("pattern") or params.get("name") or "*")
        return {"matches": [str(item) for item in root.rglob("*") if fnmatch.fnmatch(item.name, pattern)][:20_000]}
    if operation == "readText" and target:
        content = target.read_text(encoding=str(params.get("encoding") or "utf-8"), errors="replace")
        return {"content": content, "bytes": target.stat().st_size, "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}
    if operation == "writeText" and target:
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and params.get("overwrite") is False:
            raise FileExistsError(str(target))
        target.write_text(str(params.get("content") or ""), encoding=str(params.get("encoding") or "utf-8"))
        return {"path": str(target), "bytes": target.stat().st_size, "sha256": hashlib.sha256(target.read_bytes()).hexdigest()}
    if operation == "createDirectory" and target:
        target.mkdir(parents=True, exist_ok=True)
        return {"path": str(target), "created": True}
    if operation == "open" and target:
        os.startfile(str(target))
        return {"openedPath": str(target)}
    if operation in {"copy", "move", "rename"}:
        source = pathlib.Path(str(params["source"])).resolve()
        destination = pathlib.Path(str(params["destination"])).resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        if operation == "copy":
            if source.is_dir():
                shutil.copytree(source, destination, dirs_exist_ok=True)
            else:
                shutil.copy2(source, destination)
        else:
            shutil.move(str(source), str(destination))
        return {"source": str(source), "destination": str(destination)}
    if operation == "delete" and target:
        if target.parent == target:
            raise ValueError("Refusing to delete a filesystem root.")
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()
        return {"path": str(target), "deleted": not target.exists()}
    raise ValueError(f"Unsupported Python filesystem operation: {operation}")

def _input(method: str, params: dict[str, Any]) -> Any:
    from pywinauto import keyboard, mouse

    if method == "input.sendText":
        keyboard.send_keys(str(params.get("text") or ""), with_spaces=True, pause=0.01)
        return {"sent": True}
    if method == "input.sendKey":
        keys = {
            "ENTER": "{ENTER}", "TAB": "{TAB}", "ESCAPE": "{ESC}", "BACKSPACE": "{BACKSPACE}",
            "DELETE": "{DELETE}", "UP": "{UP}", "DOWN": "{DOWN}", "LEFT": "{LEFT}", "RIGHT": "{RIGHT}",
            "CTRL_A": "^a", "CTRL_C": "^c", "CTRL_V": "^v", "CTRL_L": "^l", "CTRL_S": "^s",
            "F5": "{F5}", "ALT_LEFT": "%{LEFT}", "ALT_TAB": "%{TAB}",
        }
        keyboard.send_keys(keys.get(str(params.get("key") or "").upper(), str(params.get("key") or "")))
        return {"sent": True}
    if method == "input.click":
        click_args = {
            "button": str(params.get("button") or "left"),
            "coords": (int(params["x"]), int(params["y"])),
        }
        if bool(params.get("double")):
            mouse.double_click(**click_args)
        else:
            mouse.click(**click_args)
        return {"clicked": True}
    if method == "input.scroll":
        mouse.scroll(coords=None, wheel_dist=int(params.get("delta") or 0))
        return {"scrolled": True}
    if method == "input.lastActivity":
        class LastInputInfo(ctypes.Structure):
            _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]

        info = LastInputInfo()
        info.cbSize = ctypes.sizeof(info)
        ctypes.windll.user32.GetLastInputInfo(ctypes.byref(info))
        now_tick = ctypes.windll.kernel32.GetTickCount()
        return {
            "lastInputTick": int(info.dwTime),
            "millisecondsAgo": int((now_tick - info.dwTime) & 0xFFFFFFFF),
            "source": "physical",
        }
    raise ValueError(f"Unsupported Python input operation: {method}")

def native_call(method: str, params: dict[str, Any]) -> Any:
    if method == "system.ping":
        return {"name": "OmniAgent Python Windows Automation", "protocolVersion": "2.0.0"}
    if method == "capabilities.list":
        return [
            "uia.snapshot", "uia.query", "uia.perform", "uia.assert", "filesystem.readText",
            "filesystem.writeText", "filesystem.list", "filesystem.search", "filesystem.open",
            "process.launch", "windows.list", "windows.focus", "input.sendText", "input.sendKey",
            "input.click", "input.scroll", "input.lastActivity",
        ]
    if method.startswith("uia."):
        return _uia_call(method, params)
    if method.startswith("filesystem."):
        return _filesystem(method, params)
    if method.startswith("input."):
        return _input(method, params)
    if method == "process.launch":
        executable = str(params.get("fileName") or params.get("path") or params.get("executable") or "")
        arguments = [str(item) for item in params.get("arguments") or []]
        process = subprocess.Popen(
            [executable, *arguments],
            cwd=params.get("workingDirectory"),
            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
        return {"processId": process.pid, "started": True}
    if method == "windows.list":
        windows = []
        for window in _desktop().windows():
            try:
                record = _element_record(window)
                windows.append(
                    {
                        "handle": str(window.handle),
                        "title": record["name"],
                        "processId": record["processId"],
                        "className": record["className"],
                        "visible": not record["offscreen"],
                        "bounds": record["bounds"],
                    }
                )
            except Exception:
                continue
        return {"windows": windows}
    if method == "windows.focus":
        window = _window(params)
        window.set_focus()
        return {"focused": True, "handle": str(window.handle), "title": window.window_text()}
    if method == "windows.showState":
        window = _window(params)
        state = str(params.get("state") or "")
        if state == "minimize":
            window.minimize()
        elif state == "maximize":
            window.maximize()
        else:
            window.restore()
        return {"state": state}
    if method == "windows.moveResize":
        window = _window(params)
        rectangle = window.rectangle()
        window.move_window(
            int(params.get("x") or rectangle.left),
            int(params.get("y") or rectangle.top),
            int(params.get("width") or rectangle.width()),
            int(params.get("height") or rectangle.height()),
            repaint=True,
        )
        return {"moved": True}
    raise ValueError(f"Unsupported Python native automation method: {method}")
