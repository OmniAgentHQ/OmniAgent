#!/usr/bin/env python3
from __future__ import annotations

import ctypes
import ctypes.util
import json
import os
import shutil
import subprocess
import sys
import time
import uuid

def emit(message: dict) -> None:
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()

def emit_ok(identifier: str, result) -> None:
    emit({"id": identifier or "", "ok": True, "result": result})

def emit_error(identifier: str, code: str, message: str) -> None:
    emit({"id": identifier or "", "ok": False,
          "error": {"code": code or "HelperError", "message": message or "Unknown failure."}})

class Session:
    def __init__(self) -> None:
        self.type = (os.environ.get("XDG_SESSION_TYPE") or "").strip().lower()
        self.wayland_display = os.environ.get("WAYLAND_DISPLAY") or ""
        self.x_display = os.environ.get("DISPLAY") or ""
        self.desktop = (os.environ.get("XDG_CURRENT_DESKTOP") or "").strip()

        if not self.type:
            self.type = "wayland" if self.wayland_display else ("x11" if self.x_display else "unknown")

    @property
    def is_x11(self) -> bool:
        return self.type == "x11"

    @property
    def is_wayland(self) -> bool:
        return self.type == "wayland"

    @property
    def is_gnome(self) -> bool:
        return "gnome" in self.desktop.lower()

SESSION = Session()

class X11:
    def __init__(self) -> None:
        self.display = None
        self.lib = None
        self.xtst = None
        if not SESSION.is_x11:
            return
        try:
            libx11 = ctypes.util.find_library("X11")
            libxtst = ctypes.util.find_library("Xtst")
            if not libx11 or not libxtst:
                return
            self.lib = ctypes.cdll.LoadLibrary(libx11)
            self.xtst = ctypes.cdll.LoadLibrary(libxtst)
            self.lib.XOpenDisplay.restype = ctypes.c_void_p
            self.lib.XOpenDisplay.argtypes = [ctypes.c_char_p]
            handle = self.lib.XOpenDisplay(None)
            self.display = ctypes.c_void_p(handle) if handle else None
        except OSError:
            self.display = None

    @property
    def available(self) -> bool:
        return self.display is not None

    def install_error_handler(self) -> None:
        if getattr(self, "_handler", None) is not None or not self.available:
            return
        prototype = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)

        def handler(_display, _event):
            self.last_error = True
            return 0

        self._handler = prototype(handler)
        self.lib.XSetErrorHandler.restype = ctypes.c_void_p
        self.lib.XSetErrorHandler.argtypes = [prototype]
        self.lib.XSetErrorHandler(self._handler)

X = X11()
X.last_error = False
X.install_error_handler()

def x_setup():
    if getattr(x_setup, "_done", False) or not X.available:
        return
    lib, xtst = X.lib, X.xtst
    lib.XInternAtom.restype = ctypes.c_ulong
    lib.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    lib.XDefaultRootWindow.restype = ctypes.c_ulong
    lib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    lib.XGetWindowProperty.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long,
        ctypes.c_int, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong),
        ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
        ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte))]
    lib.XFree.argtypes = [ctypes.c_void_p]
    lib.XKeysymToKeycode.restype = ctypes.c_ubyte
    lib.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    lib.XKeycodeToKeysym.restype = ctypes.c_ulong
    lib.XKeycodeToKeysym.argtypes = [ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_int]
    lib.XFlush.argtypes = [ctypes.c_void_p]
    lib.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    lib.XRaiseWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    lib.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    lib.XGetGeometry.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong),
        ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
        ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint),
        ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
    lib.XTranslateCoordinates.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
        ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
        ctypes.POINTER(ctypes.c_ulong)]
    xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                          ctypes.c_int, ctypes.c_ulong]
    xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int,
                                          ctypes.c_ulong]
    xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int,
                                       ctypes.c_ulong]
    x_setup._done = True

def x_atom(name: str) -> int:
    return X.lib.XInternAtom(X.display, name.encode(), False)

def x_property(window: int, name: str, expected_type: str):
    actual_type = ctypes.c_ulong()
    actual_format = ctypes.c_int()
    items = ctypes.c_ulong()
    remaining = ctypes.c_ulong()
    data = ctypes.POINTER(ctypes.c_ubyte)()
    status = X.lib.XGetWindowProperty(
        X.display, ctypes.c_ulong(window), ctypes.c_ulong(x_atom(name)), 0, 65536, False,
        ctypes.c_ulong(x_atom(expected_type) if expected_type else 0),
        ctypes.byref(actual_type), ctypes.byref(actual_format), ctypes.byref(items),
        ctypes.byref(remaining), ctypes.byref(data))
    if status != 0 or not data:
        return None, 0
    if actual_format.value == 32:
        stride = ctypes.sizeof(ctypes.c_long)
    else:
        stride = actual_format.value // 8 or 1
    length = items.value * stride
    raw = ctypes.string_at(data, length)
    X.lib.XFree(data)
    return raw, items.value

def x_window_title(window: int) -> str:
    raw, count = x_property(window, "_NET_WM_NAME", "UTF8_STRING")
    if raw and count:
        return raw.split(b"\x00")[0].decode("utf-8", "replace")
    raw, count = x_property(window, "WM_NAME", "")
    if raw and count:
        return raw.split(b"\x00")[0].decode("latin-1", "replace")
    return ""

def x_window_pid(window: int) -> int:
    raw, count = x_property(window, "_NET_WM_PID", "CARDINAL")
    if raw and count:
        return int.from_bytes(raw[:8] if len(raw) >= 8 else raw[:4], sys.byteorder)
    return 0

def x_window_class(window: int) -> str:
    raw, count = x_property(window, "WM_CLASS", "")
    if raw and count:
        parts = [p for p in raw.split(b"\x00") if p]
        if parts:
            return parts[-1].decode("latin-1", "replace")
    return ""

def x_window_bounds(window: int) -> dict:
    root = ctypes.c_ulong()
    x = ctypes.c_int()
    y = ctypes.c_int()
    width = ctypes.c_uint()
    height = ctypes.c_uint()
    border = ctypes.c_uint()
    depth = ctypes.c_uint()
    if not X.lib.XGetGeometry(X.display, ctypes.c_ulong(window), ctypes.byref(root),
                              ctypes.byref(x), ctypes.byref(y), ctypes.byref(width),
                              ctypes.byref(height), ctypes.byref(border), ctypes.byref(depth)):
        return {"x": 0, "y": 0, "width": 0, "height": 0}
    absolute_x = ctypes.c_int()
    absolute_y = ctypes.c_int()
    child = ctypes.c_ulong()
    X.lib.XTranslateCoordinates(X.display, ctypes.c_ulong(window), root, 0, 0,
                                ctypes.byref(absolute_x), ctypes.byref(absolute_y),
                                ctypes.byref(child))
    return {"x": absolute_x.value, "y": absolute_y.value,
            "width": width.value, "height": height.value}

def x_client_list():
    x_setup()
    root = X.lib.XDefaultRootWindow(X.display)
    for name in ("_NET_CLIENT_LIST_STACKING", "_NET_CLIENT_LIST"):
        raw, count = x_property(root, name, "WINDOW")
        if raw and count:
            width = len(raw) // count
            return [int.from_bytes(raw[i * width:(i + 1) * width], sys.byteorder)
                    for i in range(count)]
    return []

def x_active_window() -> int:
    x_setup()
    root = X.lib.XDefaultRootWindow(X.display)
    raw, count = x_property(root, "_NET_ACTIVE_WINDOW", "WINDOW")
    if raw and count:
        return int.from_bytes(raw[:len(raw) // count], sys.byteorder)
    return 0

def x_windows_list(arguments: dict):
    x_setup()
    active = x_active_window()
    windows = []
    for handle in x_client_list():
        title = x_window_title(handle)
        process_name = x_window_class(handle)
        if not title and not process_name:
            continue
        bounds = x_window_bounds(handle)
        if arguments.get("visibleOnly", True) and not (bounds["width"] and bounds["height"]):
            continue
        windows.append({
            "handle": str(handle), "title": title or process_name,
            "processName": process_name, "processId": x_window_pid(handle),
            "bounds": bounds, "minimized": False, "focused": handle == active,
        })
    return {"windows": windows}, None

def x_windows_foreground():
    x_setup()
    handle = x_active_window()
    if not handle:
        return None, "No application is in front."
    return {"title": x_window_title(handle), "processId": x_window_pid(handle)}, None

def x_window_accepts_focus(window: int) -> bool:
    raw, count = x_property(window, "WM_PROTOCOLS", "ATOM")
    if raw and count:
        stride = len(raw) // count
        take_focus = x_atom("WM_TAKE_FOCUS")
        for index in range(count):
            value = int.from_bytes(raw[index * stride:(index + 1) * stride], sys.byteorder)
            if value == take_focus:
                return True
    raw, count = x_property(window, "WM_HINTS", "")
    if not raw or count < 2:
        return True
    stride = len(raw) // count
    flags = int.from_bytes(raw[0:stride], sys.byteorder)
    accepts = int.from_bytes(raw[stride:stride * 2], sys.byteorder)
    if not flags & 1:
        return True
    return bool(accepts)

def x_focus_settled(target: int, timeout: float = 1.5) -> bool:
    root = X.lib.XDefaultRootWindow(X.display)
    raw, count = x_property(root, "_NET_ACTIVE_WINDOW", "WINDOW")
    if not raw or not count:
        return True
    deadline = time.time() + timeout
    while True:
        if x_active_window() == target:
            return True
        if time.time() >= deadline:
            return False
        time.sleep(0.05)

def x_windows_focus(arguments: dict):
    x_setup()
    listed, _ = x_windows_list({"visibleOnly": True})
    windows = listed["windows"]
    handle = str(arguments.get("handle") or "").strip()
    process_id = arguments.get("processId")
    title = str(arguments.get("title") or "").strip()

    if handle:
        matches = [w for w in windows if w["handle"] == handle]
    elif process_id:
        matches = [w for w in windows if int(w["processId"] or 0) == int(process_id)]
    elif title:
        matches = match_windows_by_name(windows, title)
    else:
        return None, "A window handle, process id or title is required."

    if not matches:
        return None, ("No open window matches that. Call list_windows to see what is actually "
                      "open, or open_app to start the program.")
    if len(matches) > 1:
        listed_names = ", ".join(
            f"{w.get('title') or w.get('processName') or 'untitled'} (handle {w.get('handle')})"
            for w in matches[:6])
        return None, (f"More than one window matches. Call focus_window again with the handle of "
                      f"the one you want: {listed_names}.")

    target = int(matches[0]["handle"])
    title = matches[0]["title"]
    if not x_window_accepts_focus(target):
        return None, (f"{title!r} does not accept keyboard focus \u2014 it is a display-only "
                      f"window. Focus a window that takes input instead.")
    X.lib.XRaiseWindow(X.display, ctypes.c_ulong(target))
    X.lib.XSetInputFocus(X.display, ctypes.c_ulong(target), 2, 0)
    X.lib.XSync(X.display, False)
    if not x_focus_settled(target):
        return None, (f"{title!r} did not take focus. It may be minimised, on another "
                      f"workspace, or refusing input.")
    return {"focused": title, "handle": matches[0]["handle"],
            "processId": matches[0]["processId"]}, None

class XTestDriver:
    failure = None

    def move_to(self, x: float, y: float) -> bool:
        x_setup()
        X.xtst.XTestFakeMotionEvent(X.display, -1, int(x), int(y), 0)
        X.lib.XFlush(X.display)
        return True

    def button(self, code: int, pressed: bool) -> bool:
        x_setup()
        mapping = {BTN_LEFT: 1, BTN_MIDDLE: 2, BTN_RIGHT: 3}
        X.xtst.XTestFakeButtonEvent(X.display, mapping.get(code, 1), bool(pressed), 0)
        X.lib.XFlush(X.display)
        return True

    SHIFT_KEYSYM = 0xFFE1

    def _needs_shift(self, keycode: int, value: int) -> bool:
        try:
            unshifted = X.lib.XKeycodeToKeysym(X.display, keycode, 0)
            shifted = X.lib.XKeycodeToKeysym(X.display, keycode, 1)
        except Exception:
            return False
        return unshifted != value and shifted == value

    def keysym(self, value: int, pressed: bool) -> bool:
        x_setup()
        keycode = X.lib.XKeysymToKeycode(X.display, ctypes.c_ulong(value))
        if not keycode:
            self.failure = f"This keyboard layout has no key for {hex(value)}."
            return False
        shift_needed = self._needs_shift(keycode, value)
        shift_code = X.lib.XKeysymToKeycode(X.display, ctypes.c_ulong(self.SHIFT_KEYSYM))
        if shift_needed and pressed and shift_code:
            X.xtst.XTestFakeKeyEvent(X.display, shift_code, True, 0)
        X.xtst.XTestFakeKeyEvent(X.display, keycode, bool(pressed), 0)
        if shift_needed and not pressed and shift_code:
            X.xtst.XTestFakeKeyEvent(X.display, shift_code, False, 0)
        X.lib.XFlush(X.display)
        return True

    def scroll(self, steps: float) -> bool:
        x_setup()
        button = 5 if steps > 0 else 4
        for _ in range(max(1, int(abs(steps)))):
            X.xtst.XTestFakeButtonEvent(X.display, button, True, 0)
            X.xtst.XTestFakeButtonEvent(X.display, button, False, 0)
        X.lib.XFlush(X.display)
        return True

XTEST = XTestDriver()

class Portals:
    def __init__(self) -> None:
        self.bus = None
        self.available_devices = 0
        self.has_screenshot = False
        self.has_remote_desktop = False
        if not SESSION.is_wayland:
            return
        try:
            import gi
            gi.require_version("Gio", "2.0")
            from gi.repository import Gio
            self.gi = gi
            self.Gio = Gio
            self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        except Exception:
            self.bus = None
            return
        self.has_screenshot = self._interface_present("org.freedesktop.portal.Screenshot")
        self.has_remote_desktop = self._interface_present("org.freedesktop.portal.RemoteDesktop")
        if self.has_remote_desktop:
            self.available_devices = self._remote_desktop_devices()

    def _interface_present(self, interface: str) -> bool:
        try:
            reply = self.bus.call_sync(
                "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
                "org.freedesktop.DBus.Introspectable", "Introspect", None, None,
                self.Gio.DBusCallFlags.NONE, 4000, None)
            return interface in reply.unpack()[0]
        except Exception:
            return False

    def _remote_desktop_devices(self) -> int:
        try:
            reply = self.bus.call_sync(
                "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
                "org.freedesktop.DBus.Properties", "Get",
                self.gi.repository.GLib.Variant("(ss)",
                                                ("org.freedesktop.portal.RemoteDesktop",
                                                 "AvailableDeviceTypes")),
                None, self.Gio.DBusCallFlags.NONE, 4000, None)
            return int(reply.unpack()[0])
        except Exception:
            return 0

    @property
    def available(self) -> bool:
        return self.bus is not None

PORTALS = Portals()

OMNIAGENT_SHELL_BUS = "org.omniagent.WindowBridge"
OMNIAGENT_SHELL_PATH = "/org/omniagent/WindowBridge"

def shell_bridge_present() -> bool:
    if not PORTALS.available:
        return False
    try:
        reply = PORTALS.bus.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
            "NameHasOwner", PORTALS.gi.repository.GLib.Variant("(s)", (OMNIAGENT_SHELL_BUS,)),
            None, PORTALS.Gio.DBusCallFlags.NONE, 3000, None)
        return bool(reply.unpack()[0])
    except Exception:
        return False

def portal_request(interface: str, method: str, arguments, options: dict, timeout_ms: int = 120_000):
    from gi.repository import GLib

    token = "omniagent_" + uuid.uuid4().hex[:16]
    sender = PORTALS.bus.get_unique_name()[1:].replace(".", "_")
    request_path = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"

    options = dict(options or {})
    options["handle_token"] = GLib.Variant("s", token)
    packed_options = GLib.Variant("a{sv}", options)

    loop = GLib.MainLoop()
    outcome: dict = {}

    def on_response(_conn, _sender, _path, _iface, _signal, parameters):
        code, results = parameters.unpack()
        outcome["code"] = code
        outcome["results"] = results
        loop.quit()

    subscription = PORTALS.bus.signal_subscribe(
        "org.freedesktop.portal.Desktop", "org.freedesktop.portal.Request", "Response",
        request_path, None, PORTALS.Gio.DBusSignalFlags.NONE, on_response)

    def give_up():
        outcome.setdefault("code", 2)
        loop.quit()
        return False

    timer = GLib.timeout_add(timeout_ms, give_up)
    try:
        body = GLib.Variant.new_tuple(*(list(arguments) + [packed_options]))
        PORTALS.bus.call_sync(
            "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
            interface, method, body, None, PORTALS.Gio.DBusCallFlags.NONE, timeout_ms, None)
        loop.run()
    except Exception as error:
        outcome["code"] = 2
        outcome["error"] = str(error)
    finally:
        GLib.source_remove(timer)
        PORTALS.bus.signal_unsubscribe(subscription)

    if outcome.get("code") == 0:
        return outcome.get("results") or {}
    return None

TOKEN_PATH = os.path.join(
    os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"),
    "omniagent", "remote-desktop-token")

class RemoteDesktop:
    def __init__(self) -> None:
        self.session = None
        self.stream = None
        self.failure = None
        self.has_sources = False

    def has_grant(self) -> bool:
        return bool(self.session) or bool(self._restore_token())

    def _restore_token(self):
        try:
            with open(TOKEN_PATH, "r", encoding="utf-8") as handle:
                return handle.read().strip()
        except OSError:
            return ""

    def _clear_token(self) -> None:
        try:
            os.remove(TOKEN_PATH)
        except OSError:
            pass

    def _store_token(self, token: str) -> None:
        if not token:
            return
        try:
            os.makedirs(os.path.dirname(TOKEN_PATH), exist_ok=True)
            with open(TOKEN_PATH, "w", encoding="utf-8") as handle:
                handle.write(token)
        except OSError:
            pass

    def close(self) -> None:
        if not self.session:
            return
        try:
            PORTALS.bus.call_sync(
                "org.freedesktop.portal.Desktop", self.session,
                "org.freedesktop.portal.Session", "Close", None, None,
                PORTALS.Gio.DBusCallFlags.NONE, 5000, None)
        except Exception:
            pass
        self.session = None
        self.stream = None
        self.has_sources = False

    def ensure(self, with_pointer: bool = False) -> bool:
        if self.session and (self.has_sources or not with_pointer):
            return True
        if self.session:
            self.close()
        if not PORTALS.has_remote_desktop:
            self.failure = unavailable_message("input")
            return False
        from gi.repository import GLib

        created = portal_request(
            "org.freedesktop.portal.RemoteDesktop", "CreateSession", [],
            {"session_handle_token": GLib.Variant("s", "omniagent_" + uuid.uuid4().hex[:12])})
        if not created or "session_handle" not in created:
            self.failure = unavailable_message("input")
            return False
        handle = created["session_handle"]

        selected = portal_request(
            "org.freedesktop.portal.RemoteDesktop", "SelectDevices",
            [GLib.Variant("o", handle)],
            {"types": GLib.Variant("u", 3), "persist_mode": GLib.Variant("u", 2),
             **({"restore_token": GLib.Variant("s", self._restore_token())}
                if self._restore_token() else {})})
        if selected is None:
            self.failure = unavailable_message("input")
            return False

        if with_pointer:
            sources = portal_request(
                "org.freedesktop.portal.ScreenCast", "SelectSources",
                [GLib.Variant("o", handle)],
                {"types": GLib.Variant("u", 1), "multiple": GLib.Variant("b", False),
                 "cursor_mode": GLib.Variant("u", 1)})
            if sources is None:
                self.failure = ("OmniAgent could not attach to a screen, so it cannot aim the "
                                "pointer. Allow the screen sharing request and try again.")
                return False

        started = portal_request(
            "org.freedesktop.portal.RemoteDesktop", "Start",
            [GLib.Variant("o", handle), GLib.Variant("s", "")], {})
        if started is None:
            self._clear_token()
            self.failure = ("OmniAgent was not given permission to control the keyboard and "
                            "pointer. Allow the Remote Desktop request and try again.")
            return False
        self._store_token(started.get("restore_token", ""))
        streams = started.get("streams") or []
        self.stream = streams[0][0] if streams else None
        self.session = handle
        self.has_sources = with_pointer
        return True

    def _call(self, method: str, arguments) -> bool:
        from gi.repository import GLib
        try:
            body = GLib.Variant.new_tuple(
                GLib.Variant("o", self.session), GLib.Variant("a{sv}", {}), *arguments)
            PORTALS.bus.call_sync(
                "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
                "org.freedesktop.portal.RemoteDesktop", method, body, None,
                PORTALS.Gio.DBusCallFlags.NONE, 5000, None)
            return True
        except Exception as error:
            self.failure = str(error)
            return False

    def move_to(self, x: float, y: float) -> bool:
        from gi.repository import GLib
        if self.stream is None:
            self.failure = ("OmniAgent cannot aim the pointer because no screen was shared with "
                            "it. Allow the screen sharing request and try again.")
            return False
        return self._call("NotifyPointerMotionAbsolute",
                          [GLib.Variant("u", self.stream), GLib.Variant("d", x),
                           GLib.Variant("d", y)])

    def button(self, code: int, pressed: bool) -> bool:
        from gi.repository import GLib
        return self._call("NotifyPointerButton",
                          [GLib.Variant("i", code), GLib.Variant("u", 1 if pressed else 0)])

    def keysym(self, value: int, pressed: bool) -> bool:
        from gi.repository import GLib
        return self._call("NotifyKeyboardKeysym",
                          [GLib.Variant("i", value), GLib.Variant("u", 1 if pressed else 0)])

    def scroll(self, steps: float) -> bool:
        from gi.repository import GLib
        return self._call("NotifyPointerAxisDiscrete",
                          [GLib.Variant("u", 0), GLib.Variant("i", int(steps))])

REMOTE = RemoteDesktop()

BTN_LEFT, BTN_RIGHT, BTN_MIDDLE = 0x110, 0x111, 0x112

NAMED_KEYSYMS = {
    "enter": 0xFF0D, "return": 0xFF0D, "tab": 0xFF09, "escape": 0xFF1B, "esc": 0xFF1B,
    "backspace": 0xFF08, "delete": 0xFFFF, "space": 0x0020, "up": 0xFF52, "down": 0xFF54,
    "left": 0xFF51, "right": 0xFF53, "home": 0xFF50, "end": 0xFF57, "pageup": 0xFF55,
    "pagedown": 0xFF56, "insert": 0xFF63,
    "ctrl": 0xFFE3, "control": 0xFFE3, "alt": 0xFFE9, "shift": 0xFFE1, "super": 0xFFEB,
    "meta": 0xFFEB, "cmd": 0xFFEB,
    **{f"f{n}": 0xFFBD + n for n in range(1, 13)},
}

def char_to_keysym(character: str) -> int:
    code = ord(character)
    if 0x20 <= code <= 0xFF:
        return code
    return 0x01000000 + code

def capture_via_portal(destination: str):
    from gi.repository import GLib

    results = portal_request(
        "org.freedesktop.portal.Screenshot", "Screenshot", [GLib.Variant("s", "")],
        {"interactive": GLib.Variant("b", False)})
    if not results or "uri" not in results:
        if wayland_window_route() in ("sway", "hyprland") and not shutil.which("grim"):
            return None, ("The screen could not be captured because grim is not installed. The "
                          "wlroots screenshot portal shells out to grim and does not pull it in "
                          "as a dependency. Install grim and try again.")
        return None, ("The screen could not be captured. Allow the screenshot request when your "
                      "desktop asks for it, then try again.")

    source = results["uri"]
    if source.startswith("file://"):
        source = GLib.filename_from_uri(source)[0]
    try:
        shutil.copyfile(source, destination)
        os.unlink(source)
    except OSError as error:
        return None, f"The screenshot could not be written: {error}"
    return destination, None

def capture_via_x11(destination: str):
    try:
        import gi
        gi.require_version("GdkPixbuf", "2.0")
        from gi.repository import GdkPixbuf
    except Exception:
        return None, "The screen could not be captured: GdkPixbuf is not available."

    lib = X.lib
    lib.XDefaultRootWindow.restype = ctypes.c_ulong
    lib.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    root = lib.XDefaultRootWindow(X.display)

    class XWindowAttributes(ctypes.Structure):
        _fields_ = [("x", ctypes.c_int), ("y", ctypes.c_int),
                    ("width", ctypes.c_int), ("height", ctypes.c_int),
                    ("border_width", ctypes.c_int), ("depth", ctypes.c_int),
                    ("visual", ctypes.c_void_p), ("root", ctypes.c_ulong),
                    ("class", ctypes.c_int), ("bit_gravity", ctypes.c_int),
                    ("win_gravity", ctypes.c_int), ("backing_store", ctypes.c_int),
                    ("backing_planes", ctypes.c_ulong), ("backing_pixel", ctypes.c_ulong),
                    ("save_under", ctypes.c_int), ("colormap", ctypes.c_ulong),
                    ("map_installed", ctypes.c_int), ("map_state", ctypes.c_int),
                    ("all_event_masks", ctypes.c_long), ("your_event_mask", ctypes.c_long),
                    ("do_not_propagate_mask", ctypes.c_long), ("override_redirect", ctypes.c_int),
                    ("screen", ctypes.c_void_p)]

    attributes = XWindowAttributes()
    lib.XGetWindowAttributes.argtypes = [ctypes.c_void_p, ctypes.c_ulong,
                                         ctypes.POINTER(XWindowAttributes)]
    if not lib.XGetWindowAttributes(X.display, root, ctypes.byref(attributes)):
        return None, "The screen could not be measured."

    width, height = attributes.width, attributes.height
    lib.XGetImage.restype = ctypes.c_void_p
    lib.XGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
                              ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int]
    X.last_error = False
    image = lib.XGetImage(X.display, root, 0, 0, width, height, 0xFFFFFFFF, 2)
    lib.XSync(X.display, False)
    if not image or X.last_error:
        return None, ("The screen could not be captured. The X server refused to read the root "
                      "window — which is what happens under Xwayland, where the desktop is not "
                      "drawn by X at all. On a real X11 session this works; on Wayland OmniAgent "
                      "captures through the desktop portal instead.")

    class XImage(ctypes.Structure):
        _fields_ = [("width", ctypes.c_int), ("height", ctypes.c_int), ("xoffset", ctypes.c_int),
                    ("format", ctypes.c_int), ("data", ctypes.c_void_p),
                    ("byte_order", ctypes.c_int), ("bitmap_unit", ctypes.c_int),
                    ("bitmap_bit_order", ctypes.c_int), ("bitmap_pad", ctypes.c_int),
                    ("depth", ctypes.c_int), ("bytes_per_line", ctypes.c_int),
                    ("bits_per_pixel", ctypes.c_int)]

    header = ctypes.cast(ctypes.c_void_p(image), ctypes.POINTER(XImage)).contents
    raw = ctypes.string_at(header.data, header.bytes_per_line * header.height)
    pixels = bytearray(raw)
    pixels[0::4], pixels[2::4] = pixels[2::4], pixels[0::4]
    try:
        pixbuf = GdkPixbuf.Pixbuf.new_from_data(
            bytes(pixels), GdkPixbuf.Colorspace.RGB, True, 8,
            header.width, header.height, header.bytes_per_line, None, None)
        pixbuf.savev(destination, "png", [], [])
    except Exception as error:
        return None, f"The screenshot could not be written: {error}"
    finally:
        lib.XDestroyImage.argtypes = [ctypes.c_void_p]
        lib.XDestroyImage(ctypes.c_void_p(image))
    return destination, None

def screen_capture(params: dict):
    destination = params.get("path") or ""
    if not destination:
        return None, "A destination path is required."
    route = capabilities()["capture"]
    if route == "portal":
        return capture_via_portal(destination)
    if route == "xgetimage":
        return capture_via_x11(destination)
    return None, unavailable_message("capture")

def bridge_call(method: str, arguments=None):
    from gi.repository import GLib
    try:
        body = GLib.Variant("(s)", (arguments,)) if arguments is not None else None
        reply = PORTALS.bus.call_sync(
            OMNIAGENT_SHELL_BUS, OMNIAGENT_SHELL_PATH, OMNIAGENT_SHELL_BUS, method,
            body, None, PORTALS.Gio.DBusCallFlags.NONE, 5000, None)
        value = reply.unpack()[0]
        return json.loads(value) if isinstance(value, str) else value
    except Exception:
        return None

def windows_list(arguments: dict):
    route = capabilities()["windows"]
    if route == "ewmh":
        return x_windows_list(arguments)
    if route == "sway":
        return sway_windows(arguments)
    if route == "hyprland":
        return hyprland_windows(arguments)
    if route == "kwin":
        return kwin_windows(arguments)
    payload = bridge_call("ListWindows")
    if payload is None:
        return None, unavailable_message("windows")
    windows = payload.get("windows", [])
    if arguments.get("visibleOnly", True):
        windows = [window for window in windows if not window.get("minimized")]
    return {"windows": windows}, None

def windows_foreground():
    route = capabilities()["windows"]
    if route == "ewmh":
        return x_windows_foreground()
    if route in ("sway", "hyprland", "kwin"):
        listed, failure = windows_list({"visibleOnly": True})
        if failure:
            return None, failure
        focused = next((w for w in listed["windows"] if w.get("focused")), None)
        if not focused:
            return None, "No application is in front."
        return {"title": focused.get("title", ""), "processId": focused.get("processId", 0)}, None
    payload = bridge_call("GetForeground")
    if payload is None:
        return None, unavailable_message("windows")
    window = payload.get("window")
    if not window:
        return None, "No application is in front."
    return {"title": window.get("title", ""), "processId": window.get("processId", 0)}, None

def match_windows_by_name(windows: list, wanted: str) -> list:
    lowered = wanted.lower().strip()
    if not lowered:
        return []

    def field(window, key):
        return str(window.get(key) or "").lower().strip()

    def short_class(window):
        name = field(window, "processName")
        return name.rsplit(".", 1)[-1] if "." in name else name

    tiers = [
        lambda w: field(w, "title") == lowered,
        lambda w: field(w, "processName") == lowered or short_class(w) == lowered,
        lambda w: lowered in field(w, "title"),
        lambda w: lowered in field(w, "processName"),
        lambda w: field(w, "title").startswith(lowered) or short_class(w).startswith(lowered),
    ]
    for test in tiers:
        matches = [w for w in windows if test(w)]
        if matches:
            return matches
    return []

def choose_window(windows: list, arguments: dict):
    handle = str(arguments.get("handle") or "").strip()
    process_id = arguments.get("processId")
    title = str(arguments.get("title") or "").strip()

    if handle:
        matches = [w for w in windows if str(w.get("handle")) == handle]
    elif process_id:
        matches = [w for w in windows if int(w.get("processId") or 0) == int(process_id)]
    elif title:
        matches = match_windows_by_name(windows, title)
    else:
        return None, "A window handle, process id or title is required."

    if not matches:
        return None, ("No open window matches that. Call list_windows to see what is actually "
                      "open, or open_app to start the program.")
    if len(matches) > 1:
        listed = ", ".join(
            f"{w.get('title') or w.get('processName') or 'untitled'} (handle {w.get('handle')})"
            for w in matches[:6])
        return None, (f"More than one window matches. Call focus_window again with the handle of "
                      f"the one you want: {listed}.")
    return matches[0], None

def windows_focus(arguments: dict):
    route = capabilities()["windows"]
    if route == "ewmh":
        return x_windows_focus(arguments)
    if route in ("sway", "hyprland", "kwin"):
        listed, failure = windows_list({"visibleOnly": True})
        if failure:
            return None, failure
        target, failure = choose_window(listed["windows"], arguments)
        if failure:
            return None, failure
        focus = {"sway": sway_focus, "hyprland": hyprland_focus,
                 "kwin": kwin_focus}[route]
        if not focus(str(target["handle"])):
            return None, f"{target.get('title') or 'That window'} could not be brought to the front."
        return {"focused": target.get("title", ""), "handle": target.get("handle"),
                "processId": target.get("processId")}, None
    payload = bridge_call("ListWindows")
    if payload is None:
        return None, unavailable_message("windows")
    windows = payload.get("windows", [])

    handle = str(arguments.get("handle") or "").strip()
    process_id = arguments.get("processId")
    title = str(arguments.get("title") or "").strip()

    if handle:
        matches = [w for w in windows if str(w.get("handle")) == handle]
    elif process_id:
        matches = [w for w in windows if int(w.get("processId") or 0) == int(process_id)]
    elif title:
        matches = match_windows_by_name(windows, title)
    else:
        return None, "A window handle, process id or title is required."

    if not matches:
        return None, ("No open window matches that. Call list_windows to see what is actually "
                      "open, or open_app to start the program.")
    if len(matches) > 1:
        return None, (f"More than one window matches. Call list_windows and use the handle of the "
                      f"one you want ({len(matches)} matched).")

    target = matches[0]
    focused = bridge_call("FocusWindow", str(target["handle"]))
    if not focused:
        return None, f"{target.get('title') or 'That window'} could not be brought to the front."
    return {"focused": target.get("title", ""), "handle": target.get("handle"),
            "processId": target.get("processId")}, None

def run_json(command: list, timeout: float = 5.0):
    try:
        finished = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    if finished.returncode != 0:
        return None
    try:
        return json.loads(finished.stdout)
    except json.JSONDecodeError:
        return None

def sway_windows(arguments: dict):
    tree = run_json(["swaymsg", "-t", "get_tree", "-r"])
    if tree is None:
        return None, unavailable_message("windows")

    windows = []

    def walk(node):
        app_id = node.get("app_id")
        properties = node.get("window_properties") or {}
        if app_id or properties.get("class"):
            rect = node.get("rect") or {}
            windows.append({
                "handle": str(node.get("id")),
                "title": node.get("name") or "",
                "processName": app_id or properties.get("class") or "",
                "processId": int(node.get("pid") or 0),
                "bounds": {"x": rect.get("x", 0), "y": rect.get("y", 0),
                           "width": rect.get("width", 0), "height": rect.get("height", 0)},
                "minimized": not node.get("visible", True),
                "focused": bool(node.get("focused")),
            })
        for child in (node.get("nodes") or []) + (node.get("floating_nodes") or []):
            walk(child)

    walk(tree)
    if arguments.get("visibleOnly", True):
        windows = [window for window in windows if not window["minimized"]]
    return {"windows": windows}, None

def sway_focus(handle: str) -> bool:
    try:
        finished = subprocess.run(["swaymsg", f"[con_id={handle}] focus"],
                                  capture_output=True, text=True, timeout=5)
        return finished.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False

def hyprland_windows(arguments: dict):
    clients = run_json(["hyprctl", "-j", "clients"])
    if clients is None:
        return None, unavailable_message("windows")
    active = run_json(["hyprctl", "-j", "activewindow"]) or {}
    active_address = active.get("address")

    windows = []
    for client in clients:
        position = client.get("at") or [0, 0]
        size = client.get("size") or [0, 0]
        windows.append({
            "handle": str(client.get("address") or ""),
            "title": client.get("title") or "",
            "processName": client.get("class") or "",
            "processId": int(client.get("pid") or 0),
            "bounds": {"x": position[0], "y": position[1],
                       "width": size[0], "height": size[1]},
            "minimized": not client.get("mapped", True),
            "focused": client.get("address") == active_address,
        })
    if arguments.get("visibleOnly", True):
        windows = [window for window in windows if not window["minimized"]]
    return {"windows": windows}, None

def hyprland_dispatch(lua_dispatcher: str, legacy_arguments=None):
    commands = [["hyprctl", "dispatch", lua_dispatcher]]
    if legacy_arguments:
        commands.append(["hyprctl", "dispatch", *legacy_arguments])
    failure = ""
    for command in commands:
        try:
            finished = subprocess.run(command, capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.SubprocessError) as error:
            failure = str(error)
            continue
        if finished.returncode == 0 and "ok" in finished.stdout.lower():
            return True, None
        failure = ((finished.stderr or finished.stdout or "").strip()
                   or f"hyprctl exited {finished.returncode}.")
    return False, failure or "Hyprland refused the desktop action."

def hyprland_focus(handle: str) -> bool:
    selector = f"address:{handle}"
    succeeded, _ = hyprland_dispatch(
        f"hl.dsp.focus({{ window = {json.dumps(selector)} }})",
        ["focuswindow", selector])
    return succeeded

KWIN_SINK_IFACE = "org.omniagent.KwinSink"
KWIN_SINK_BUS = f"org.omniagent.KwinSink.p{os.getpid()}"
KWIN_SINK_PATH = "/org/omniagent/KwinSink"

KWIN_SCRIPT = """
function omniagentWindows() {
    var list = (typeof workspace.windowList === 'function')
        ? workspace.windowList()
        : workspace.clientList();
    var active = workspace.activeWindow || workspace.activeClient;
    var out = [];
    for (var i = 0; i < list.length; i++) {
        var w = list[i];
        if (!w || !w.normalWindow) continue;
        var g = w.frameGeometry || w.geometry || {};
        out.push({
            handle: String(w.internalId || w.windowId || i),
            title: String(w.caption || ''),
            processName: String(w.resourceClass || w.resourceName || ''),
            processId: w.pid || 0,
            bounds: { x: g.x || 0, y: g.y || 0, width: g.width || 0, height: g.height || 0 },
            minimized: !!w.minimized,
            focused: !!(active && String(active.internalId || active.windowId) ===
                        String(w.internalId || w.windowId))
        });
    }
    return out;
}

function omniagentFocus(handle) {
    var list = (typeof workspace.windowList === 'function')
        ? workspace.windowList()
        : workspace.clientList();
    for (var i = 0; i < list.length; i++) {
        var w = list[i];
        if (String(w.internalId || w.windowId) !== String(handle)) continue;
        if (w.minimized) w.minimized = false;
        // Plasma 6 renamed activeClient to activeWindow; assigning either is what raises and
        // focuses, there is no separate activate() call.
        if ('activeWindow' in workspace) workspace.activeWindow = w;
        else workspace.activeClient = w;
        return true;
    }
    return false;
}

var REQUEST = __OMNIAGENT_REQUEST__;
var result = REQUEST.action === 'focus'
    ? { focused: omniagentFocus(REQUEST.handle) }
    : { windows: omniagentWindows() };
callDBus('__SINK_BUS__', '__SINK_PATH__', '__SINK_IFACE__', 'Deliver',
         '__TOKEN__', JSON.stringify(result));
"""

class KwinBridge:
    def __init__(self) -> None:
        self.registration = None
        self.pending = {}

    def _ensure_sink(self) -> bool:
        if self.registration is not None:
            return True
        if not PORTALS.available and not getattr(self, "_bus", None):
            return False
        from gi.repository import Gio, GLib
        self.Gio, self.GLib = Gio, GLib
        self.bus = PORTALS.bus if PORTALS.available else Gio.bus_get_sync(Gio.BusType.SESSION, None)
        if self.bus is None:
            return False
        node = Gio.DBusNodeInfo.new_for_xml(
            "<node><interface name='" + KWIN_SINK_IFACE + "'>"
            "<method name='Deliver'>"
            "<arg type='s' direction='in' name='token'/>"
            "<arg type='s' direction='in' name='payload'/>"
            "</method></interface></node>")

        def handle_call(_conn, _sender, _path, _iface, method, parameters, invocation):
            if method == "Deliver":
                token, payload = parameters.unpack()
                self.pending[token] = payload
                invocation.return_value(None)
                return
            invocation.return_value(None)

        try:
            self.registration = self.bus.register_object(
                KWIN_SINK_PATH, node.interfaces[0], handle_call, None, None)
            reply = self.bus.call_sync(
                "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                "RequestName", GLib.Variant("(su)", (KWIN_SINK_BUS, 4)),
                GLib.VariantType("(u)"), Gio.DBusCallFlags.NONE, 5000, None)
            owned = reply.unpack()[0]
            if owned not in (1, 4):
                self.bus.unregister_object(self.registration)
                self.registration = None
                return False
        except Exception:
            self.registration = None
            return False
        return True

    def call(self, request: dict, timeout_ms: int = 6000):
        if not self._ensure_sink():
            return None
        token = uuid.uuid4().hex
        source = (KWIN_SCRIPT
                  .replace("__OMNIAGENT_REQUEST__", json.dumps(request))
                  .replace("__SINK_BUS__", KWIN_SINK_BUS)
                  .replace("__SINK_IFACE__", KWIN_SINK_IFACE)
                  .replace("__SINK_PATH__", KWIN_SINK_PATH)
                  .replace("__TOKEN__", token))

        directory = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or "/tmp", "omniagent")
        os.makedirs(directory, exist_ok=True)
        script_path = os.path.join(directory, f"kwin-{token}.js")
        try:
            with open(script_path, "w", encoding="utf-8") as handle:
                handle.write(source)
        except OSError:
            return None

        script_id = None
        try:
            reply = self.bus.call_sync(
                "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting", "loadScript",
                self.GLib.Variant("(ss)", (script_path, f"omniagent-{token}")), None,
                self.Gio.DBusCallFlags.NONE, 5000, None)
            script_id = reply.unpack()[0]
            self.bus.call_sync(
                "org.kde.KWin", f"/Scripting/Script{script_id}", "org.kde.kwin.Script", "run",
                None, None, self.Gio.DBusCallFlags.NONE, 5000, None)

            loop = self.GLib.MainLoop()

            def give_up():
                loop.quit()
                return False

            timer = self.GLib.timeout_add(timeout_ms, give_up)
            def poll():
                if token in self.pending:
                    loop.quit()
                    return False
                return True
            poller = self.GLib.timeout_add(50, poll)
            loop.run()
            self.GLib.source_remove(timer)
            self.GLib.source_remove(poller)
        except Exception:
            return None
        finally:
            if script_id is not None:
                try:
                    self.bus.call_sync(
                        "org.kde.KWin", f"/Scripting/Script{script_id}", "org.kde.kwin.Script",
                        "stop", None, None, self.Gio.DBusCallFlags.NONE, 3000, None)
                except Exception:
                    pass
            try:
                os.unlink(script_path)
            except OSError:
                pass

        payload = self.pending.pop(token, None)
        if payload is None:
            return None
        try:
            return json.loads(payload)
        except json.JSONDecodeError:
            return None

KWIN = KwinBridge()

def kwin_available() -> bool:
    if not PORTALS.available:
        return False
    try:
        reply = PORTALS.bus.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
            "NameHasOwner", PORTALS.gi.repository.GLib.Variant("(s)", ("org.kde.KWin",)),
            None, PORTALS.Gio.DBusCallFlags.NONE, 3000, None)
        return bool(reply.unpack()[0])
    except Exception:
        return False

def kwin_windows(arguments: dict):
    payload = KWIN.call({"action": "list"})
    if payload is None:
        return None, ("KWin did not answer. OmniAgent asks KWin to run a small script that "
                      "reports the window list, and that script returned nothing within the "
                      "timeout. Windows cannot be listed or focused until it does; input and "
                      "screen capture are unaffected.")
    windows = payload.get("windows", [])
    if arguments.get("visibleOnly", True):
        windows = [window for window in windows if not window.get("minimized")]
    return {"windows": windows}, None

def kwin_focus(handle: str) -> bool:
    payload = KWIN.call({"action": "focus", "handle": str(handle)})
    return bool(payload and payload.get("focused"))

def sway_socket_live() -> bool:
    path = os.environ.get("SWAYSOCK")
    return bool(path and os.path.exists(path) and shutil.which("swaymsg"))

def hyprland_socket_live() -> bool:
    signature = os.environ.get("HYPRLAND_INSTANCE_SIGNATURE")
    if not signature or not shutil.which("hyprctl"):
        return False
    runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return any(os.path.exists(os.path.join(base, "hypr", signature, ".socket.sock"))
               for base in (runtime, "/tmp"))

def wayland_window_route():
    if sway_socket_live():
        return "sway"
    if hyprland_socket_live():
        return "hyprland"
    if shell_bridge_present():
        return "gnome-extension"
    if kwin_available():
        return "kwin"
    return None

def capabilities() -> dict:
    windows_route = None
    if SESSION.is_x11 and X.available:
        windows_route = "ewmh"
    elif SESSION.is_wayland:
        windows_route = wayland_window_route()

    input_route = None
    if SESSION.is_x11 and X.available:
        input_route = "xtest"
    elif SESSION.is_wayland and PORTALS.has_remote_desktop:
        input_route = "portal"
    elif SESSION.is_wayland and wlroots_input_available():
        input_route = "wlroots"

    capture_route = None
    if SESSION.is_x11 and X.available:
        capture_route = "xgetimage"
    elif SESSION.is_wayland and PORTALS.has_screenshot:
        capture_route = "portal"

    return {
        "session": SESSION.type,
        "desktop": SESSION.desktop,
        "input": input_route,
        "capture": capture_route,
        "windows": windows_route,
        "accessibility": accessibility_available(),
    }

def accessibility_available() -> bool:
    if getattr(accessibility_available, "_answer", None) is not None:
        return accessibility_available._answer
    module = atspi()
    answer = False
    if module:
        try:
            answer = module.get_desktop(0).get_child_count() > 0
        except Exception:
            answer = False
    accessibility_available._answer = answer
    return answer

def unavailable_message(feature: str) -> str:
    if feature == "windows":
        if SESSION.is_wayland and SESSION.is_gnome:
            return ("Wayland does not let applications list or focus other windows, so OmniAgent "
                    "needs its GNOME extension for this. Enable the OmniAgent Window Bridge "
                    "extension, or log in with an X11 session, and try again.")
        if SESSION.is_wayland:
            return (f"Wayland does not let applications list or focus other windows, and "
                    f"{SESSION.desktop or 'this desktop'} offers no route OmniAgent recognises. "
                    f"GNOME, KDE Plasma, sway and Hyprland are supported; on anything else, log in "
                    f"with an X11 session to use this tool.")
        return "No window list is available on this session."
    if feature == "input":
        if virtual_keyboard_desktop() and not shutil.which("wtype"):
            return ("This compositor has no permission prompt for input — there is no Remote "
                    "Desktop portal for wlroots. OmniAgent types through wtype instead, which "
                    "is not installed. Install wtype, then try again. Pointer control uses the "
                    "compositor's own command-line interface.")
        if SESSION.is_wayland:
            return ("OmniAgent needs permission to control the keyboard and pointer. Allow the "
                    "Remote Desktop request when your desktop asks for it, then try again.")
        return "No way to send input is available on this session."
    if feature == "capture":
        if virtual_keyboard_desktop() and not PORTALS.has_screenshot:
            return ("No screenshot portal is running. wlroots compositors need the "
                    "xdg-desktop-portal-wlr package, which is not installed alongside sway or "
                    "Hyprland by default. Install it, log in again, and try again.")
        if SESSION.is_wayland:
            return ("OmniAgent needs permission to capture the screen. Allow the screenshot "
                    "request when your desktop asks for it, then try again.")
        return "No way to capture the screen is available on this session."
    return f"{feature} is not available on this session."

ATSPI_CONTROL_TYPES = {
    "button": "Button", "push button": "Button", "toggle button": "Button",
    "check box": "CheckBox", "check menu item": "MenuItem",
    "radio button": "RadioButton", "radio menu item": "MenuItem",
    "combo box": "ComboBox", "text": "Edit", "entry": "Edit", "password text": "Edit",
    "paragraph": "Text", "label": "Text", "static": "Text", "heading": "Text",
    "menu item": "MenuItem", "menu": "Menu", "menu bar": "MenuBar",
    "frame": "Window", "window": "Window", "dialog": "Window", "alert": "Window",
    "list": "List", "list item": "ListItem", "list box": "List",
    "table": "Table", "table cell": "DataItem", "table row": "ListItem",
    "tree": "Tree", "tree item": "TreeItem", "tree table": "Tree",
    "link": "Hyperlink", "image": "Image", "icon": "Image",
    "slider": "Slider", "spin button": "Spinner", "progress bar": "ProgressBar",
    "scroll bar": "ScrollBar", "scroll pane": "Pane", "separator": "Separator",
    "page tab": "TabItem", "page tab list": "Tab", "tool bar": "ToolBar",
    "status bar": "StatusBar", "panel": "Group", "filler": "Group", "grouping": "Group",
    "document frame": "Document", "document web": "Document", "section": "Group",
}

def atspi():
    if getattr(atspi, "_module", "unset") != "unset":
        return atspi._module
    try:
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        Atspi.init()
        atspi._module = Atspi
    except Exception:
        atspi._module = None
    return atspi._module

def atspi_application(process_id: int):
    module = atspi()
    if not module:
        return None
    try:
        desktop = module.get_desktop(0)
        for index in range(desktop.get_child_count()):
            application = desktop.get_child_at_index(index)
            if application is None:
                continue
            try:
                if int(application.get_process_id()) == int(process_id):
                    return application
            except Exception:
                continue
    except Exception:
        return None
    return None

def atspi_target(window: dict):
    window = window or {}
    process_id = window.get("processId")
    if not process_id:
        front, failure = windows_foreground()
        if failure:
            return None, None, failure
        process_id = front.get("processId")
    application = atspi_application(process_id)
    if not application:
        return None, None, ("No readable window is in front. Use open_app to start a program, then "
                            "try again.")
    origin = None
    listed, _ = windows_list({"visibleOnly": True})
    if listed:
        for window in listed["windows"]:
            if int(window.get("processId") or 0) == int(process_id):
                box = window.get("bounds") or {}
                origin = (box.get("x", 0), box.get("y", 0))
                break
    return application, origin, None

def describe_element(node, parent_index: int, process_id: int, origin=None) -> dict:
    module = atspi()
    role = ""
    name = ""
    try:
        role = node.get_role_name() or ""
        name = node.get_name() or ""
    except Exception:
        pass

    states = set()
    try:
        for state in node.get_state_set().get_states():
            states.add(state.value_nick)
    except Exception:
        pass

    bounds = {"x": 0, "y": 0, "width": 0, "height": 0}
    on_screen = False
    try:
        component = node.get_component_iface()
        if component:
            extents = component.get_extents(module.CoordType.WINDOW)
            bounds = {"x": extents.x, "y": extents.y,
                      "width": extents.width, "height": extents.height}
            if origin is not None:
                bounds["x"] += origin[0]
                bounds["y"] += origin[1]
                on_screen = True
    except Exception:
        pass

    value = ""
    try:
        text = node.get_text_iface()
        if text:
            value = text.get_text(0, text.get_character_count()) or ""
    except Exception:
        pass
    if not value:
        try:
            numeric = node.get_value_iface()
            if numeric:
                value = str(numeric.get_current_value())
        except Exception:
            pass

    patterns = []
    action_names = []
    try:
        actions = node.get_action_iface()
        if actions:
            action_names = [actions.get_action_name(index)
                            for index in range(actions.get_n_actions())]
            patterns.append("Invoke")
    except Exception:
        pass
    if node.get_text_iface() if hasattr(node, "get_text_iface") else None:
        patterns.append("Value")
    if "checked" in states or role in ("check box", "toggle button", "radio button"):
        patterns.append("Toggle")
    if "expandable" in states:
        patterns.append("ExpandCollapse")
    if "selectable" in states:
        patterns.append("SelectionItem")

    description = ""
    try:
        description = node.get_description() or ""
    except Exception:
        pass

    return {
        "parentIndex": parent_index,
        "name": name,
        "automationId": "",
        "className": role,
        "controlType": ATSPI_CONTROL_TYPES.get(role, "Custom"),
        "processId": process_id,
        "enabled": "sensitive" in states or "enabled" in states,
        "offscreen": "showing" not in states,
        "focusable": "focusable" in states,
        "focused": "focused" in states,
        "password": role == "password text",
        "helpText": description,
        "accessKey": "",
        "value": value,
        "selected": "selected" in states,
        "checked": "checked" in states,
        "expanded": "expanded" in states,
        "bounds": bounds,
        "patterns": patterns,
        "_actions": action_names,
        "_onScreen": on_screen,
    }

def collect_tree(root, max_depth: int, max_elements: int, process_id: int, origin=None):
    elements = [describe_element(root, -1, process_id, origin)]
    nodes = [root]
    truncated = False

    def walk(node, node_index, depth):
        nonlocal truncated
        if depth >= max_depth:
            return
        try:
            count = node.get_child_count()
        except Exception:
            return
        for index in range(count):
            if len(elements) >= max_elements:
                truncated = True
                return
            try:
                child = node.get_child_at_index(index)
            except Exception:
                continue
            if child is None:
                continue
            elements.append(describe_element(child, node_index, process_id, origin))
            nodes.append(child)
            walk(child, len(elements) - 1, depth + 1)

    walk(root, 0, 0)
    return elements, nodes, truncated

def selector_matches(element: dict, selector: dict) -> bool:
    name = str(selector.get("name") or "")
    contains = str(selector.get("nameContains") or "")
    automation_id = str(selector.get("automationId") or "")
    class_name = str(selector.get("className") or "")
    control_type = str(selector.get("controlType") or "")
    actual = element.get("name") or ""

    if name and actual.lower() != name.lower():
        return False
    if contains and contains.lower() not in actual.lower():
        return False
    if automation_id and element.get("automationId") != automation_id:
        return False
    if class_name and (element.get("className") or "").lower() != class_name.lower():
        return False
    if control_type and (element.get("controlType") or "").lower() != control_type.lower():
        return False
    return True

def find_elements(arguments: dict):
    application, origin, failure = atspi_target(arguments.get("window"))
    if failure:
        return None, None, failure
    try:
        process_id = int(application.get_process_id())
    except Exception:
        process_id = 0
    elements, nodes, _ = collect_tree(
        application, int(arguments.get("maxDepth") or 24),
        int(arguments.get("maxElements") or 1500), process_id, origin)
    selector = arguments.get("selector") or {}
    matched = [(element, nodes[index]) for index, element in enumerate(elements)
               if selector_matches(element, selector)]
    return matched, elements, None

def do_action(node, wanted: list) -> bool:
    try:
        actions = node.get_action_iface()
        if not actions:
            return False
        available = {actions.get_action_name(index).lower(): index
                     for index in range(actions.get_n_actions())}
    except Exception:
        return False
    for name in wanted:
        index = available.get(name.lower())
        if index is not None:
            try:
                return bool(actions.do_action(index))
            except Exception:
                return False
    return False

LAST_SYNTHETIC_EVENT = 0.0

def input_last_activity() -> dict:
    now = time.time()
    since_ours_ms = (now - LAST_SYNTHETIC_EVENT) * 1000.0 if LAST_SYNTHETIC_EVENT else 1e9
    return {
        "lastInputTick": int(now * 1000),
        "millisecondsAgo": int(since_ours_ms),
        "source": "automation" if since_ours_ms < 250 else "physical",
    }

class WlrootsDriver:
    failure = None

    WTYPE_MODIFIERS = {"ctrl": "ctrl", "control": "ctrl", "alt": "alt", "shift": "shift",
                       "super": "logo", "meta": "logo", "cmd": "logo", "altgr": "altgr"}
    WTYPE_KEYS = {"enter": "Return", "return": "Return", "tab": "Tab", "escape": "Escape",
                  "esc": "Escape", "backspace": "BackSpace", "delete": "Delete",
                  "space": "space", "up": "Up", "down": "Down", "left": "Left", "right": "Right",
                  "home": "Home", "end": "End", "pageup": "Prior", "pagedown": "Next",
                  "insert": "Insert",
                  **{f"f{number}": f"F{number}" for number in range(1, 13)}}

    def _run(self, argv) -> bool:
        try:
            finished = subprocess.run(argv, capture_output=True, text=True, timeout=5)
        except FileNotFoundError:
            self.failure = f"{argv[0]} is not installed, so this cannot be done on this desktop."
            return False
        except Exception as error:
            self.failure = f"{argv[0]} could not be run: {error}"
            return False
        if finished.returncode != 0:
            self.failure = ((finished.stderr or finished.stdout or "").strip()
                            or f"{argv[0]} exited {finished.returncode}.")
            return False
        return True

    def move_to(self, x: float, y: float) -> bool:
        route = wayland_window_route()
        if route == "sway":
            return self._run(["swaymsg", "seat", "-", "cursor", "set", str(int(x)), str(int(y))])
        if route == "hyprland":
            succeeded, failure = hyprland_dispatch(
                f"hl.dsp.cursor.move({{ x = {int(x)}, y = {int(y)} }})",
                ["movecursor", str(int(x)), str(int(y))])
            self.failure = failure
            return succeeded
        self.failure = "This compositor offers no way to place the pointer."
        return False

    def button(self, code: int, pressed: bool) -> bool:
        route = wayland_window_route()
        if route == "sway":
            names = {BTN_LEFT: "button1", BTN_MIDDLE: "button2", BTN_RIGHT: "button3"}
            return self._run(["swaymsg", "seat", "-", "cursor",
                              "press" if pressed else "release", names.get(code, "button1")])
        if route == "hyprland":
            if not pressed:
                return True
            mouse_code = {BTN_LEFT: 272, BTN_RIGHT: 273, BTN_MIDDLE: 274}.get(code, 272)
            key = f"mouse:{mouse_code}"
            succeeded, failure = hyprland_dispatch(
                f"hl.dsp.send_shortcut({{ mods = \"\", key = {json.dumps(key)}, "
                f"window = \"activewindow\" }})",
                ["sendshortcut", f",{key},activewindow"])
            self.failure = failure
            return succeeded
        self.failure = "This compositor offers no way to click."
        return False

    def scroll(self, steps: float) -> bool:
        if not steps:
            return True
        count = min(50, max(1, round(abs(float(steps)) / 120)))
        route = wayland_window_route()
        if route == "sway":
            button = "button5" if steps >= 0 else "button4"
            for _ in range(count):
                if not self._run(["swaymsg", "seat", "-", "cursor", "press", button]):
                    return False
            return True
        if route == "hyprland":
            key = "mouse_down" if steps >= 0 else "mouse_up"
            for _ in range(count):
                succeeded, failure = hyprland_dispatch(
                    f"hl.dsp.send_shortcut({{ mods = \"\", key = {json.dumps(key)}, "
                    f"window = \"activewindow\" }})",
                    ["sendshortcut", f",{key},activewindow"])
                if not succeeded:
                    self.failure = failure
                    return False
            self.failure = None
            return True
        self.failure = "This compositor offers no way to scroll."
        return False

    def keysym(self, value: int, pressed: bool) -> bool:
        self.failure = "This desktop types whole strings and whole combinations, not single keys."
        return False

    def send_text(self, text: str) -> bool:
        return self._run(["wtype", "--", text])

    def send_key(self, parts) -> bool:
        modifiers = [part for part in parts if part in self.WTYPE_MODIFIERS]
        keys = [part for part in parts if part not in self.WTYPE_MODIFIERS]
        argv = ["wtype"]
        for modifier in modifiers:
            argv += ["-M", self.WTYPE_MODIFIERS[modifier]]
        for key in keys:
            name = self.WTYPE_KEYS.get(key) or (key if len(key) == 1 else None)
            if name is None:
                self.failure = f"{key} is not a key this helper knows how to press."
                return False
            argv += ["-k", name]
        for modifier in reversed(modifiers):
            argv += ["-m", self.WTYPE_MODIFIERS[modifier]]
        return self._run(argv)

WLROOTS = WlrootsDriver()

def virtual_keyboard_desktop() -> bool:
    route = wayland_window_route()
    if route in ("sway", "hyprland"):
        return True
    if route in ("gnome-extension", "kwin"):
        return False
    desktop = SESSION.desktop.lower()
    known = ("sway", "hyprland")
    if any(name in desktop for name in known):
        return True
    return bool(os.environ.get("WAYFIRE_SOCKET"))

def wlroots_input_available() -> bool:
    if not virtual_keyboard_desktop():
        return False
    return bool(shutil.which("wtype"))

def perform_input(method: str, arguments: dict):
    global LAST_SYNTHETIC_EVENT

    route = capabilities()["input"]
    if route == "portal":
        if not REMOTE.ensure(method == "input.click"):
            return None, REMOTE.failure or unavailable_message("input")
        driver = REMOTE
    elif route == "xtest":
        driver = XTEST
    elif route == "wlroots":
        driver = WLROOTS
    else:
        return None, unavailable_message("input")

    def settle():
        time.sleep(0.012)

    if method == "input.click":
        x = float(arguments.get("x", 0))
        y = float(arguments.get("y", 0))
        button = str(arguments.get("button", "left")).lower()
        code = BTN_RIGHT if button == "right" else BTN_MIDDLE if button == "middle" else BTN_LEFT
        if not driver.move_to(x, y):
            return None, driver.failure
        settle()
        for _ in range(2 if arguments.get("double") else 1):
            if not driver.button(code, True):
                return None, driver.failure
            settle()
            if not driver.button(code, False):
                return None, driver.failure
            settle()
        LAST_SYNTHETIC_EVENT = time.time()
        return {"clicked": True, "x": x, "y": y, "button": button}, None

    if method == "input.sendText":
        text = str(arguments.get("text", ""))
        whole_string = getattr(driver, "send_text", None)
        if whole_string is not None:
            if text and not whole_string(text):
                return None, driver.failure
            LAST_SYNTHETIC_EVENT = time.time()
            return {"typed": len(text)}, None
        for character in text:
            value = char_to_keysym(character)
            if not driver.keysym(value, True):
                return None, driver.failure
            settle()
            driver.keysym(value, False)
            settle()
        LAST_SYNTHETIC_EVENT = time.time()
        return {"typed": len(text)}, None

    if method == "input.sendKey":
        key = str(arguments.get("key", "")).strip()
        if not key:
            return None, "A key is required."
        parts = [part.strip().lower() for part in key.replace("_", "+").split("+") if part.strip()]
        whole_combination = getattr(driver, "send_key", None)
        if whole_combination is not None:
            if not whole_combination(parts):
                return None, driver.failure
            LAST_SYNTHETIC_EVENT = time.time()
            return {"pressed": key}, None
        pressed = []
        for part in parts:
            value = NAMED_KEYSYMS.get(part) or (char_to_keysym(part) if len(part) == 1 else None)
            if value is None:
                return None, f"{key} is not a key this helper knows how to press."
            if not driver.keysym(value, True):
                return None, driver.failure
            pressed.append(value)
            settle()
        for value in reversed(pressed):
            driver.keysym(value, False)
            settle()
        LAST_SYNTHETIC_EVENT = time.time()
        return {"pressed": key}, None

    if method == "input.scroll":
        delta = float(arguments.get("delta", 0))
        if not driver.scroll(delta):
            return None, driver.failure
        LAST_SYNTHETIC_EVENT = time.time()
        return {"scrolled": delta}, None

    return None, f"{method} is not implemented by the Linux helper yet."

def strip_internal(element: dict) -> dict:
    return {key: value for key, value in element.items() if not key.startswith("_")}

def perform_uia(method: str, arguments: dict):
    if not atspi():
        return None, ("Reading this application is not possible: the accessibility service is not "
                      "running. Install at-spi2-core and try again.")

    if method == "uia.snapshot":
        application, origin, failure = atspi_target(arguments.get("window"))
        if failure:
            return None, failure
        try:
            process_id = int(application.get_process_id())
        except Exception:
            process_id = 0
        elements, _, truncated = collect_tree(
            application, int(arguments.get("maxDepth") or 24),
            int(arguments.get("maxElements") or 1500), process_id, origin)
        clean = [strip_internal(element) for element in elements]
        return {"root": clean[0], "elements": clean, "truncated": truncated}, None

    matched, _, failure = find_elements(arguments)
    if failure:
        return None, failure

    if method == "uia.query":
        selection = str(arguments.get("selection") or "")
        index = arguments.get("index")
        chosen = [element for element, _ in matched]
        if selection == "index" and index is not None:
            chosen = chosen[int(index):int(index) + 1]
        elif selection == "first":
            chosen = chosen[:1]
        elif selection == "last":
            chosen = chosen[-1:]
        return {"count": len(matched), "elements": [strip_internal(e) for e in chosen]}, None

    if not matched:
        return None, ("No element on screen matches that. Call read_screen to see what is actually "
                      "there.")

    element, node = matched[0]

    if method in ("uia.invoke", "uia.select"):
        if do_action(node, ["click", "press", "activate", "jump", "open"]):
            return {"invoked": element.get("name", "")}, None
        bounds = element.get("bounds") or {}
        if not element.get("_onScreen"):
            return None, (f"{element.get('name') or 'That element'} offers no action, and its "
                          f"position on screen could not be established, so OmniAgent will not "
                          f"click at a guessed coordinate.")
        if bounds.get("width") and bounds.get("height"):
            result, click_failure = perform_input("input.click", {
                "x": bounds["x"] + bounds["width"] / 2,
                "y": bounds["y"] + bounds["height"] / 2})
            if not click_failure:
                return {"invoked": element.get("name", ""), "via": "pointer"}, None
            return None, click_failure
        return None, f"{element.get('name') or 'That element'} cannot be activated."

    if method == "uia.setValue":
        value = str(arguments.get("value", ""))
        try:
            editable = node.get_editable_text_iface()
            if editable:
                editable.set_text_contents(value)
                return {"set": True, "value": value}, None
        except Exception:
            pass
        return None, f"{element.get('name') or 'That element'} cannot be typed into directly."

    if method == "uia.perform":
        operation = str(arguments.get("operation") or "")
        value = arguments.get("value")
        bounds = element.get("bounds") or {}
        centre = (bounds.get("x", 0) + bounds.get("width", 0) / 2,
                  bounds.get("y", 0) + bounds.get("height", 0) / 2)
        aimable = bool(element.get("_onScreen")) and bounds.get("width") and bounds.get("height")

        if operation in ("click", "select", "check", "uncheck", "toggle"):
            if operation == "check" and element.get("checked"):
                return {"count": len(matched), "results": [True]}, None
            if operation == "uncheck" and not element.get("checked"):
                return {"count": len(matched), "results": [True]}, None
            if do_action(node, ["click", "press", "activate"]):
                return {"count": len(matched), "results": [True]}, None
            if not aimable:
                return None, (f"{element.get('name') or 'That element'} offers no action and its "
                              f"screen position is unknown, so it cannot be clicked safely.")
            result, click_failure = perform_input(
                "input.click", {"x": centre[0], "y": centre[1]})
            return ({"count": len(matched), "results": [True]}, None) if not click_failure \
                else (None, click_failure)

        if operation in ("doubleClick", "contextClick", "hover"):
            if not aimable:
                return None, (f"{element.get('name') or 'That element'} has no known screen "
                              f"position, so it cannot be clicked safely.")
            button = "right" if operation == "contextClick" else "left"
            result, click_failure = perform_input("input.click", {
                "x": centre[0], "y": centre[1], "button": button,
                "double": operation == "doubleClick"})
            return ({"count": len(matched), "results": [True]}, None) if not click_failure \
                else (None, click_failure)

        if operation == "focus":
            try:
                component = node.get_component_iface()
                if component and component.grab_focus():
                    return {"count": len(matched), "results": [True]}, None
            except Exception:
                pass
            return None, f"{element.get('name') or 'That element'} cannot take focus."

        if operation in ("fill", "type", "clear"):
            text = "" if operation == "clear" else str(value if value is not None else "")
            try:
                editable = node.get_editable_text_iface()
                if editable:
                    editable.set_text_contents(text)
                    return {"count": len(matched), "results": [True]}, None
            except Exception:
                pass
            return None, f"{element.get('name') or 'That element'} cannot be typed into."

        if operation in ("expand", "collapse"):
            if do_action(node, ["expand or contract", "expand", "collapse", "click"]):
                return {"count": len(matched), "results": [True]}, None
            return None, f"{element.get('name') or 'That element'} cannot be expanded."

        if operation == "scrollIntoView":
            try:
                component = node.get_component_iface()
                if component:
                    component.scroll_to(atspi().ScrollType.ANYWHERE)
                    return {"count": len(matched), "results": [True]}, None
            except Exception:
                pass
            return None, f"{element.get('name') or 'That element'} cannot be scrolled into view."

        return None, f"{operation} is not an operation this helper knows."

    if method == "uia.assert":
        assertion = str(arguments.get("assertion") or "")
        expected = arguments.get("expected")
        expected_text = "" if expected is None else str(expected)
        count = len(matched)
        first = element
        actual = first.get("value") or first.get("name") or ""

        checks = {
            "exists": lambda: count > 0,
            "notExists": lambda: count == 0,
            "countEquals": lambda: count == int(expected or 0),
            "countAtLeast": lambda: count >= int(expected or 0),
            "equals": lambda: actual == expected_text,
            "notEquals": lambda: actual != expected_text,
            "contains": lambda: expected_text.lower() in actual.lower(),
            "nonEmpty": lambda: bool(actual),
            "visible": lambda: count > 0 and not first.get("offscreen"),
            "hidden": lambda: count == 0 or bool(first.get("offscreen")),
            "enabled": lambda: count > 0 and bool(first.get("enabled")),
            "disabled": lambda: count > 0 and not first.get("enabled"),
            "selected": lambda: count > 0 and bool(first.get("selected")),
            "checked": lambda: count > 0 and bool(first.get("checked")),
            "unchecked": lambda: count > 0 and not first.get("checked"),
        }
        if assertion == "matches":
            import re
            try:
                passed = bool(re.search(expected_text, actual))
            except re.error:
                return None, f"{expected_text} is not a valid pattern."
        elif assertion in checks:
            passed = bool(checks[assertion]())
        else:
            return None, f"{assertion} is not an assertion this helper knows."
        return {"passed": passed, "actual": actual, "count": count}, None

    return None, f"{method} is not implemented by the Linux helper yet."

def input_permission_status() -> dict:
    caps = capabilities()
    route = caps["input"] or ""
    if route != "portal":
        return {"route": route, "granted": bool(route), "needsGrant": False,
                "capture": caps["capture"] or ""}
    return {"route": route, "granted": REMOTE.has_grant(), "needsGrant": not REMOTE.has_grant(),
            "capture": caps["capture"] or ""}

def handle_native_call(identifier: str, params: dict) -> None:
    method = params.get("native_method") or ""
    arguments = params.get("native_params") or {}
    caps = capabilities()

    if method == "input.lastActivity":
        emit_ok(identifier, input_last_activity())
        return

    if method == "input.permissionStatus":
        emit_ok(identifier, input_permission_status())
        return

    if method == "input.requestPermission":
        if caps["input"] != "portal":
            emit_ok(identifier, input_permission_status())
            return
        if not REMOTE.ensure():
            emit_error(identifier, "PermissionDenied",
                       REMOTE.failure or unavailable_message("input"))
            return
        emit_ok(identifier, input_permission_status())
        return

    if method.startswith("input."):
        if not caps["input"]:
            emit_error(identifier, "InputUnavailable", unavailable_message("input"))
            return
        result, failure = perform_input(method, arguments)
        if failure:
            emit_error(identifier, "InputFailed", failure)
            return
        emit_ok(identifier, result)
        return

    if method.startswith("windows."):
        if not caps["windows"]:
            emit_error(identifier, "WindowsUnavailable", unavailable_message("windows"))
            return
        if method == "windows.list":
            result, failure = windows_list(arguments)
        elif method == "windows.foreground":
            result, failure = windows_foreground()
        elif method == "windows.focus":
            result, failure = windows_focus(arguments)
        else:
            result, failure = None, f"{method} is not implemented by the Linux helper yet."
        if failure:
            if method == "windows.foreground":
                code = "NoForegroundWindow"
            elif method == "windows.focus" and "does not accept keyboard focus" in failure:
                code = "WindowRefusesFocus"
            elif method == "windows.focus" and "did not take focus" in failure:
                code = "FocusNotApplied"
            else:
                code = "WindowNotFound"
            emit_error(identifier, code, failure)
            return
        emit_ok(identifier, result)
        return

    if method == "screen.capture":
        if not caps["capture"]:
            emit_error(identifier, "CaptureUnavailable", unavailable_message("capture"))
            return
        written, failure = screen_capture(arguments)
        if not written:
            emit_error(identifier, "CaptureFailed", failure)
            return
        try:
            import gi
            gi.require_version("GdkPixbuf", "2.0")
            from gi.repository import GdkPixbuf
            info = GdkPixbuf.Pixbuf.get_file_info(written)
            width, height = (info[1], info[2]) if info and info[0] else (0, 0)
        except Exception:
            width, height = 0, 0
        emit_ok(identifier, {"path": written, "bytes": os.path.getsize(written),
                             "width": width, "height": height})
        return

    if method.startswith("uia."):
        result, failure = perform_uia(method, arguments)
        if failure:
            codes = {"uia.snapshot": "NoWindow", "uia.setValue": "ElementNotFound",
                     "uia.perform": "PerformFailed", "uia.assert": "AssertFailed"}
            emit_error(identifier, codes.get(method, "ElementNotFound"), failure)
            return
        emit_ok(identifier, result)
        return

    emit_error(identifier, "UnsupportedMethod",
               f"{method} is not implemented by the Linux helper yet.")

def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--probe":
        emit(capabilities())
        return 0

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(message, dict):
            continue
        identifier = message.get("id") or ""
        method = message.get("method") or ""

        if method == "health":
            caps = capabilities()
            emit_ok(identifier, {
                "name": "OmniAgent Linux helper",
                "version": "1.0.0",
                "python": sys.version.split()[0],
                "capabilities": caps,
                "accessibility": caps["accessibility"],
            })
        elif method == "native.call":
            handle_native_call(identifier, message.get("params") or {})
        elif method == "cancel":
            emit_ok(identifier, {"cancelled": True})
        else:
            emit_error(identifier, "UnknownMethod", f"Unknown method {method}.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
