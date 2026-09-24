#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import ctypes
import json
import os
import shutil
import subprocess
import sys
import time
import winreg
from ctypes import wintypes
from io import BytesIO
from pathlib import Path
from typing import Any

# Per-monitor DPI awareness v2 (Win10 1703+) — MUST run before importing
# pyautogui/pyscreeze: pyautogui calls SetProcessDPIAware() at import time,
# and the first awareness call wins. PMv2 unifies GetWindowRect,
# SetCursorPos, WindowFromPoint and GetMonitorInfo rects into the same true
# per-monitor coordinate space; PMv1 (shcore level 2) virtualizes coordinates
# on monitors whose DPI differs from the system DPI, which breaks mixed-DPI
# setups: screenshot rects and click targets stop agreeing.
user32_early = ctypes.windll.user32
user32_early.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
user32_early.SetProcessDpiAwarenessContext.restype = ctypes.c_bool
if not user32_early.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
    # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 unavailable (pre-1703)
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

import mss

import mss
import psutil
import pythoncom
import pyautogui
import win32api
import win32com.client
import win32con
import win32gui
import win32process
from PIL import Image

os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
os.environ.setdefault("PYAUTOGUI_HIDE_SUPPORT_PROMPT", "1")

pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0

KEY_MAP = {
    **{chr(i): chr(i) for i in range(ord("a"), ord("z") + 1)},
    **{str(i): str(i) for i in range(10)},
    "cmd": "winleft",
    "command": "winleft",
    "meta": "winleft",
    "super": "winleft",
    "win": "winleft",
    "windows": "winleft",
    "ctrl": "ctrl",
    "control": "ctrl",
    "shift": "shift",
    "alt": "alt",
    "option": "alt",
    "opt": "alt",
    "escape": "esc",
    "esc": "esc",
    "enter": "enter",
    "return": "enter",
    "tab": "tab",
    "space": "space",
    "backspace": "backspace",
    "delete": "delete",
    "del": "delete",
    "insert": "insert",
    "up": "up",
    "down": "down",
    "left": "left",
    "right": "right",
    "home": "home",
    "end": "end",
    "pageup": "pageup",
    "pagedown": "pagedown",
    "capslock": "capslock",
    "printscreen": "printscreen",
    "prtsc": "printscreen",
    "apps": "apps",
    "menu": "apps",
    "f1": "f1",
    "f2": "f2",
    "f3": "f3",
    "f4": "f4",
    "f5": "f5",
    "f6": "f6",
    "f7": "f7",
    "f8": "f8",
    "f9": "f9",
    "f10": "f10",
    "f11": "f11",
    "f12": "f12",
    "-": "minus",
    "=": "equals",
    "[": "[",
    "]": "]",
    "\\": "\\",
    ";": ";",
    "'": "'",
    ",": ",",
    ".": ".",
    "/": "/",
    "`": "`",
}

MONITOR_DEFAULTTONEAREST = 2
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SW_RESTORE = 9
CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002
TOKEN_QUERY = 0x0008
TOKEN_ELEVATION = 20

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
advapi32 = ctypes.windll.advapi32


def process_is_elevated(pid: int) -> bool:
    """Whether the process token is elevated (Run as administrator). Best-effort:
    returns False when the token cannot be queried."""

    class _TOKEN_ELEVATION_STRUCT(ctypes.Structure):
        _fields_ = (("TokenIsElevated", ctypes.c_ulong),)

    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return False
    try:
        token = wintypes.HANDLE()
        if not advapi32.OpenProcessToken(handle, TOKEN_QUERY, ctypes.byref(token)):
            return False
        try:
            elevation = _TOKEN_ELEVATION_STRUCT()
            returned = ctypes.c_ulong()
            ok = advapi32.GetTokenInformation(
                token,
                TOKEN_ELEVATION,
                ctypes.byref(elevation),
                ctypes.sizeof(elevation),
                ctypes.byref(returned),
            )
            return bool(ok and elevation.TokenIsElevated)
        finally:
            kernel32.CloseHandle(token)
    finally:
        kernel32.CloseHandle(handle)


_SELF_PID = kernel32.GetCurrentProcessId()
_SELF_ELEVATED = process_is_elevated(_SELF_PID)


def _ensure_input_can_reach_foreground() -> None:
    """UIPI guard: Windows silently discards synthetic input injected from a
    non-elevated process while an elevated (administrator) window has focus.
    Fail loudly instead of letting the action vanish without a trace."""
    hwnd = win32gui.GetForegroundWindow()
    if not hwnd:
        return
    _, pid = win32process.GetWindowThreadProcessId(hwnd)
    if not _SELF_ELEVATED and process_is_elevated(pid):
        raise RuntimeError(
            "The foreground application is running elevated (as administrator). "
            "Windows UIPI silently discards mouse/keyboard input injected from a "
            "non-elevated process, so this action would have no effect. "
            "To control elevated applications, run the computer-use runtime as administrator."
        )


def normalize_key(name: str) -> str:
    key = name.strip().lower()
    if key not in KEY_MAP:
        raise ValueError(f"Unsupported key: {name}")
    return KEY_MAP[key]


def json_output(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def error_output(message: str, code: str = "runtime_error") -> None:
    json_output({"ok": False, "error": {"code": code, "message": message}})


def get_process_path(pid: int) -> str | None:
    if pid <= 0:
        return None
    try:
        return psutil.Process(pid).exe()
    except Exception:
        pass
    try:
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return None
        try:
            size = wintypes.DWORD(32768)
            buf = ctypes.create_unicode_buffer(size.value)
            if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                return buf.value
        finally:
            kernel32.CloseHandle(handle)
    except Exception:
        pass
    return None


def display_name_from_path(path: str | None, fallback: str) -> str:
    if path:
        stem = Path(path).stem
        if stem:
            return stem
    return fallback


MDT_EFFECTIVE_DPI = 0


def _monitor_scale_factor(left: int, top: int, width: int, height: int) -> float:
    """Effective DPI scale of the monitor containing this rect (per-monitor DPI
    aware process). Falls back to 1.0 when the API is unavailable."""

    class _RECT(ctypes.Structure):
        _fields_ = (
            ("left", ctypes.c_long),
            ("top", ctypes.c_long),
            ("right", ctypes.c_long),
            ("bottom", ctypes.c_long),
        )

    try:
        rect = _RECT(left, top, left + width, top + height)
        hmonitor = user32.MonitorFromRect(ctypes.byref(rect), MONITOR_DEFAULTTONEAREST)
        if not hmonitor:
            return 1.0
        dpi_x = ctypes.c_uint()
        dpi_y = ctypes.c_uint()
        if (
            ctypes.windll.shcore.GetDpiForMonitor(
                hmonitor, MDT_EFFECTIVE_DPI, ctypes.byref(dpi_x), ctypes.byref(dpi_y)
            )
            == 0
            and dpi_x.value
        ):
            return round(dpi_x.value / 96, 2)
    except Exception:
        pass
    return 1.0


DISPLAY_DEVICE_ACTIVE = 0x1


def _monitor_edid_name(device: str) -> str | None:
    """Monitor model string from EDID (e.g. "ROG STRIX XG27AQM")."""
    try:
        mon = win32api.EnumDisplayDevices(device, 0)
        s = (mon.DeviceString or "").strip()
        return s or None
    except Exception:
        return None


def _relative_position(origin_x: int, origin_y: int, primary: dict[str, Any] | None) -> str:
    """Human-identifiable spatial position relative to the primary display."""
    if not primary:
        return "primary"
    dx = origin_x - primary["originX"]
    dy = origin_y - primary["originY"]
    if abs(dx) <= 100 and abs(dy) <= 100:
        return "primary"
    parts = []
    if dy < 0:
        parts.append("above")
    elif dy > 0:
        parts.append("below")
    if dx > 0:
        parts.append("right of")
    elif dx < 0:
        parts.append("left of")
    return " ".join(parts) + " the primary display" if parts else "primary"


def _monitor_metadata() -> list[dict[str, Any]]:
    """Per-monitor metadata keyed for lookup by rect: GDI device name and the
    number Windows Settings shows for the display. Settings numbers come from
    EnumDisplayDevices' active-display index + 1, which is exactly the big
    number rendered in Settings > System > Display (and on the identity view
    when you click Identify). mss' enumeration order does NOT match it."""
    monitors: list[dict[str, Any]] = []
    try:
        for hmon, _hdc, rect in win32api.EnumDisplayMonitors(None, None):
            info = win32api.GetMonitorInfo(hmon)
            monitors.append(
                {
                    "device": info["Device"],
                    "left": rect[0],
                    "top": rect[1],
                    "width": rect[2] - rect[0],
                    "height": rect[3] - rect[1],
                }
            )
    except Exception:
        return monitors
    numbers: dict[str, int] = {}
    try:
        i = 0
        while True:
            try:
                dev = win32api.EnumDisplayDevices(None, i)
            except Exception:
                break
            if dev is None:
                break
            if dev.StateFlags & DISPLAY_DEVICE_ACTIVE:
                numbers[dev.DeviceName] = i + 1
            i += 1
    except Exception:
        pass
    for m in monitors:
        m["settingsNumber"] = numbers.get(m["device"])
    return monitors


def get_displays() -> list[dict[str, Any]]:
    displays: list[dict[str, Any]] = []
    meta = _monitor_metadata()
    with mss.MSS() as sct:
        for idx, monitor in enumerate(sct.monitors[1:], start=1):
            origin_x = int(monitor["left"])
            origin_y = int(monitor["top"])
            width = int(monitor["width"])
            height = int(monitor["height"])
            # Match the mss monitor to its GDI device so the reported number
            # is the one the user sees in Windows Settings.
            entry = next(
                (
                    m
                    for m in meta
                    if m["left"] == origin_x
                    and m["top"] == origin_y
                    and m["width"] == width
                    and m["height"] == height
                ),
                None,
            )
            number = (entry or {}).get("settingsNumber") or idx
            device = (entry or {}).get("device")
            is_primary = origin_x == 0 and origin_y == 0
            scale = _monitor_scale_factor(origin_x, origin_y, width, height)
            displays.append(
                {
                    "id": number,
                    "displayId": number,
                    "width": width,
                    "height": height,
                    "scaleFactor": scale,
                    "originX": origin_x,
                    "originY": origin_y,
                    "isPrimary": is_primary,
                    "name": f"Display {number}",
                    "label": f"Display {number}",
                }
            )
    if displays and not any(display["isPrimary"] for display in displays):
        displays[0]["isPrimary"] = True
    displays.sort(key=lambda display: display["displayId"])
    # Enrich labels with EDID model, scale and spatial position so the agent
    # can match a user's description ("the 125% screen", "the right monitor")
    # even though Windows Settings numbering may differ from our ids.
    primary = next((d for d in displays if d["isPrimary"]), None)
    for display in displays:
        device = next(
            (
                m["device"]
                for m in meta
                if m["left"] == display["originX"]
                and m["top"] == display["originY"]
                and m["width"] == display["width"]
                and m["height"] == display["height"]
            ),
            None,
        )
        model = _monitor_edid_name(device) if device else None
        scale_pct = f"{round(display['scaleFactor'] * 100)}%"
        position = (
            "primary"
            if display["isPrimary"]
            else _relative_position(display["originX"], display["originY"], primary)
        )
        bits = [f"Display {display['displayId']}"]
        if model:
            bits.append(model)
        bits.append(f"{display['width']}x{display['height']} @{scale_pct}")
        bits.append(position)
        display["label"] = display["name"] = " · ".join(bits)
    return displays


def choose_display(display_id: int | None) -> dict[str, Any]:
    displays = get_displays()
    if not displays:
        raise RuntimeError("No active displays found")
    if display_id is None:
        for display in displays:
            if display["isPrimary"]:
                return display
        return displays[0]
    for display in displays:
        if display["displayId"] == display_id or display["id"] == display_id:
            return display
    raise RuntimeError(f"Unknown display: {display_id}")


def capture_monitor(monitor: dict[str, int], resize: tuple[int, int] | None = None) -> dict[str, Any]:
    with mss.MSS() as sct:
        raw = sct.grab(monitor)
        image = Image.frombytes("RGB", raw.size, raw.rgb)
    if resize:
        image = image.resize(resize, Image.Resampling.LANCZOS)
    buffer = BytesIO()
    image.save(buffer, format="JPEG", quality=75, optimize=True)
    base64_data = base64.b64encode(buffer.getvalue()).decode("ascii")
    return {"base64": base64_data, "width": image.width, "height": image.height}


def capture_display(display_id: int | None, resize: tuple[int, int] | None = None) -> dict[str, Any]:
    display = choose_display(display_id)
    monitor = {
        "left": display["originX"],
        "top": display["originY"],
        "width": display["width"],
        "height": display["height"],
    }
    result = capture_monitor(monitor, resize)
    result.update(
        {
            "displayWidth": display["width"],
            "displayHeight": display["height"],
            "displayId": display["displayId"],
            "originX": display["originX"],
            "originY": display["originY"],
            "display": display,
        }
    )
    return result


def intersect(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> bool:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    return max(ax1, bx1) < min(ax2, bx2) and max(ay1, by1) < min(ay2, by2)


def enum_windows() -> list[dict[str, Any]]:
    windows: list[dict[str, Any]] = []

    def callback(hwnd: int, _lparam: int) -> bool:
        if not win32gui.IsWindowVisible(hwnd):
            return True
        if win32gui.IsIconic(hwnd):
            return True
        title = win32gui.GetWindowText(hwnd) or ""
        if not title.strip():
            return True
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        width = right - left
        height = bottom - top
        if width <= 1 or height <= 1:
            return True
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        process_path = get_process_path(pid)
        windows.append(
            {
                "hwnd": hwnd,
                "title": title,
                "pid": pid,
                "processPath": process_path or "",
                "ownerName": display_name_from_path(process_path, f"pid-{pid}"),
                "bounds": {"x": left, "y": top, "width": width, "height": height},
            }
        )
        return True

    win32gui.EnumWindows(callback, 0)
    return windows


def process_identity(path: str | None, pid: int) -> str:
    if path:
        return os.path.normcase(path)
    return f"pid:{pid}"


def frontmost_app() -> dict[str, Any] | None:
    hwnd = win32gui.GetForegroundWindow()
    if not hwnd:
        return None
    _, pid = win32process.GetWindowThreadProcessId(hwnd)
    path = get_process_path(pid)
    if not path:
        return None
    return {
        "bundleId": os.path.normcase(path),
        "displayName": display_name_from_path(path, f"pid-{pid}"),
        "elevated": process_is_elevated(pid),
        "selfElevated": _SELF_ELEVATED,
    }


def app_under_point(x: int, y: int) -> dict[str, Any] | None:
    hwnd = user32.WindowFromPoint(wintypes.POINT(x, y))
    if hwnd:
        hwnd = win32gui.GetAncestor(hwnd, win32con.GA_ROOT)
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        path = get_process_path(pid)
        if path:
            return {
                "bundleId": os.path.normcase(path),
                "displayName": display_name_from_path(path, f"pid-{pid}"),
                "elevated": process_is_elevated(pid),
                "selfElevated": _SELF_ELEVATED,
            }
    return frontmost_app()


def find_window_displays(bundle_ids: list[str]) -> list[dict[str, Any]]:
    windows = enum_windows()
    displays = get_displays()
    result: list[dict[str, Any]] = []
    normalized_targets = [os.path.normcase(item) for item in bundle_ids]
    for bundle_id in normalized_targets:
        display_ids: set[int] = set()
        for window in windows:
            process_path = os.path.normcase(window["processPath"] or "")
            if not process_path:
                continue
            if process_path != bundle_id:
                continue
            bounds = window["bounds"]
            rect = (bounds["x"], bounds["y"], bounds["x"] + bounds["width"], bounds["y"] + bounds["height"])
            for display in displays:
                display_rect = (
                    display["originX"],
                    display["originY"],
                    display["originX"] + display["width"],
                    display["originY"] + display["height"],
                )
                if intersect(rect, display_rect):
                    display_ids.add(int(display["displayId"]))
        result.append({"bundleId": bundle_id, "displayIds": sorted(display_ids)})
    return result


def read_reg_value(root, subkey: str, value_name: str) -> str | None:
    try:
        with winreg.OpenKey(root, subkey) as key:
            value, _ = winreg.QueryValueEx(key, value_name)
            if isinstance(value, str) and value.strip():
                return value.strip()
    except OSError:
        return None
    return None


def _strip_icon_index(path: str) -> str:
    """DisplayIcon-style values may carry a trailing icon index, e.g.
    "C:\\app\\icon.exe,0". Strip the ",<digits>" suffix when present."""
    idx = path.rfind(",")
    if idx != -1 and path[idx + 1:].isdigit():
        return path[:idx]
    return path


def extract_exe_from_command(command: str | None) -> str | None:
    if not command:
        return None
    command = command.strip()
    if not command:
        return None
    if command.startswith('"'):
        end = command.find('"', 1)
        if end > 1:
            return _strip_icon_index(command[1:end])
    parts = command.split()
    return _strip_icon_index(parts[0]) if parts else None


def collect_registry_apps(root, subkey: str, out: dict[str, dict[str, Any]]) -> None:
    try:
        with winreg.OpenKey(root, subkey) as key:
            count, _, _ = winreg.QueryInfoKey(key)
            for i in range(count):
                child_name = winreg.EnumKey(key, i)
                child = f"{subkey}\\{child_name}"
                display_name = read_reg_value(root, child, "DisplayName")
                if not display_name:
                    continue
                install_location = read_reg_value(root, child, "InstallLocation")
                display_icon = read_reg_value(root, child, "DisplayIcon")
                app_path = extract_exe_from_command(display_icon)
                if not app_path and install_location:
                    candidate_dir = Path(install_location)
                    if candidate_dir.exists():
                        exe_candidates = sorted(candidate_dir.glob("*.exe"))
                        if exe_candidates:
                            app_path = str(exe_candidates[0])
                if not app_path:
                    continue
                identifier = os.path.normcase(app_path)
                out.setdefault(identifier, {"bundleId": identifier, "displayName": display_name, "path": app_path})
    except OSError:
        return


def collect_app_paths(root, subkey: str, out: dict[str, dict[str, Any]]) -> None:
    try:
        with winreg.OpenKey(root, subkey) as key:
            count, _, _ = winreg.QueryInfoKey(key)
            for i in range(count):
                child_name = winreg.EnumKey(key, i)
                child = f"{subkey}\\{child_name}"
                app_path = read_reg_value(root, child, "")
                if not app_path:
                    continue
                identifier = os.path.normcase(app_path)
                out.setdefault(identifier, {"bundleId": identifier, "displayName": Path(app_path).stem, "path": app_path})
    except OSError:
        return


def installed_apps() -> list[dict[str, Any]]:
    results: dict[str, dict[str, Any]] = {}
    uninstall_keys = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ]
    app_paths = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths"),
    ]
    for root, key in uninstall_keys:
        collect_registry_apps(root, key, results)
    for root, key in app_paths:
        collect_app_paths(root, key, results)
    return sorted(results.values(), key=lambda item: item["displayName"].lower())


def running_apps() -> list[dict[str, Any]]:
    results: dict[str, dict[str, Any]] = {}
    for proc in psutil.process_iter(["pid", "name", "exe"]):
        path = proc.info.get("exe")
        if not path:
            continue
        identifier = os.path.normcase(path)
        results.setdefault(
            identifier,
            {
                "bundleId": identifier,
                "displayName": display_name_from_path(path, proc.info.get("name") or f"pid-{proc.info['pid']}"),
            },
        )
    return sorted(results.values(), key=lambda item: item["displayName"].lower())


def open_app(bundle_id: str) -> None:
    target = bundle_id.strip()
    if not target:
        raise RuntimeError("Missing app identifier")
    if os.path.exists(target):
        os.startfile(target)
        return
    resolved = shutil.which(target)
    if resolved:
        subprocess.Popen([resolved])
        return
    subprocess.Popen(["cmd", "/c", "start", "", target], shell=False)


def read_clipboard() -> str:
    if not user32.OpenClipboard(None):
        return ""
    try:
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return ""
        locked = kernel32.GlobalLock(handle)
        if not locked:
            return ""
        try:
            return ctypes.wstring_at(locked)
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def write_clipboard(text: str) -> None:
    data = str(text)
    if not user32.OpenClipboard(None):
        raise RuntimeError("OpenClipboard failed")
    try:
        user32.EmptyClipboard()
        size = (len(data) + 1) * ctypes.sizeof(ctypes.c_wchar)
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, size)
        if not handle:
            raise RuntimeError("GlobalAlloc failed")
        locked = kernel32.GlobalLock(handle)
        if not locked:
            kernel32.GlobalFree(handle)
            raise RuntimeError("GlobalLock failed")
        try:
            ctypes.memmove(locked, ctypes.create_unicode_buffer(data), size)
        finally:
            kernel32.GlobalUnlock(handle)
        if not user32.SetClipboardData(CF_UNICODETEXT, handle):
            kernel32.GlobalFree(handle)
            raise RuntimeError("SetClipboardData failed")
    finally:
        user32.CloseClipboard()


def check_permissions() -> dict[str, bool]:
    return {"accessibility": True, "screenRecording": True}


def click(x: int, y: int, button: str, count: int, modifiers: list[str] | None) -> None:
    pyautogui.moveTo(x, y)
    if modifiers:
        normalized = [normalize_key(m) for m in modifiers]
        for key in normalized:
            pyautogui.keyDown(key)
        try:
            pyautogui.click(x=x, y=y, button=button, clicks=count, interval=0.08)
        finally:
            for key in reversed(normalized):
                pyautogui.keyUp(key)
    else:
        pyautogui.click(x=x, y=y, button=button, clicks=count, interval=0.08)


def scroll(x: int, y: int, delta_x: int, delta_y: int) -> None:
    pyautogui.moveTo(x, y)
    if delta_y:
        pyautogui.scroll(int(delta_y), x=x, y=y)
    if delta_x:
        win32api.mouse_event(win32con.MOUSEEVENTF_HWHEEL, 0, 0, int(delta_x), 0)


def key_action(sequence: str, repeat: int = 1) -> None:
    parts = [normalize_key(part) for part in sequence.split("+") if part.strip()]
    for _ in range(max(1, repeat)):
        if len(parts) == 1:
            pyautogui.press(parts[0])
        else:
            pyautogui.hotkey(*parts, interval=0.02)
        time.sleep(0.01)


def hold_keys(keys: list[str], duration_ms: int) -> None:
    normalized = [normalize_key(k) for k in keys]
    for key in normalized:
        pyautogui.keyDown(key)
    try:
        time.sleep(max(duration_ms, 0) / 1000)
    finally:
        for key in reversed(normalized):
            pyautogui.keyUp(key)


def type_text(text: str) -> None:
    # SendInput with KEYEVENTF_UNICODE: bypasses the IME (a Chinese IME eats
    # the space key as its commit key and swallows non-ASCII entirely with
    # pyautogui.write), and types any Unicode character layout-independently.
    for ch in text:
        if ch == "\n":
            pyautogui.press("enter")
            time.sleep(0.008)
        elif ch == "\t":
            pyautogui.press("tab")
            time.sleep(0.008)
        elif ch == "\r":
            continue
        else:
            _send_unicode_char(ch)
            time.sleep(0.008)


_INPUT_KEYBOARD = 1
_KEYEVENTF_UNICODE = 0x0004
_KEYEVENTF_KEYUP = 0x0002


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = (
        ("wVk", ctypes.c_ushort),
        ("wScan", ctypes.c_ushort),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    )


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = (
        ("dx", ctypes.c_long),
        ("dy", ctypes.c_long),
        ("mouseData", ctypes.c_ulong),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    )


class _INPUTUNION(ctypes.Union):
    # Must include MOUSEINPUT so the union (and thus INPUT) is 32/40 bytes on
    # x64 — SendInput rejects a smaller cbSize silently.
    _fields_ = (("ki", _KEYBDINPUT), ("mi", _MOUSEINPUT))


class _INPUT(ctypes.Structure):
    _fields_ = (("type", ctypes.c_ulong), ("union", _INPUTUNION))


def _send_unicode_char(ch: str) -> None:
    code = ord(ch)
    if code > 0xFFFF:
        # Surrogate pair for characters outside the BMP.
        code_high = 0xD800 + ((code - 0x10000) >> 10)
        code_low = 0xDC00 + ((code - 0x10000) & 0x3FF)
        _send_unicode_code_unit(code_high)
        _send_unicode_code_unit(code_low)
    else:
        _send_unicode_code_unit(code)


def _send_unicode_code_unit(code: int) -> None:
    inputs = (_INPUT * 2)()
    inputs[0].type = _INPUT_KEYBOARD
    inputs[0].union.ki = _KEYBDINPUT(0, code, _KEYEVENTF_UNICODE, 0, None)
    inputs[1].type = _INPUT_KEYBOARD
    inputs[1].union.ki = _KEYBDINPUT(0, code, _KEYEVENTF_UNICODE | _KEYEVENTF_KEYUP, 0, None)
    sent = ctypes.windll.user32.SendInput(2, inputs, ctypes.sizeof(_INPUT))
    if sent != 2:
        raise OSError(f"SendInput failed for U+{code:04X} (sent={sent}, size={ctypes.sizeof(_INPUT)})")


def restore_window(hwnd: int) -> None:
    try:
        win32gui.ShowWindow(hwnd, SW_RESTORE)
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        pass


def _force_foreground(hwnd: int) -> None:
    try:
        win32gui.SetForegroundWindow(hwnd)
        return
    except Exception:
        pass
    # Background processes are not allowed to steal focus — attach to the
    # foreground thread's input queue to earn SetForegroundWindow permission.
    fg = win32gui.GetForegroundWindow()
    cur_tid = kernel32.GetCurrentThreadId()
    fg_tid = win32process.GetWindowThreadProcessId(fg)[0] if fg else cur_tid
    target_tid = win32process.GetWindowThreadProcessId(hwnd)[0]
    user32.AttachThreadInput(cur_tid, fg_tid, True)
    user32.AttachThreadInput(cur_tid, target_tid, True)
    try:
        win32gui.SetForegroundWindow(hwnd)
    finally:
        user32.AttachThreadInput(cur_tid, fg_tid, False)
        user32.AttachThreadInput(cur_tid, target_tid, False)


def prepare_for_action(allowlist: list[str]) -> list[str]:
    """Windows prepare-for-action. The macOS runtime hides non-allowlisted
    apps and defocuses the host; hiding windows on Windows would be far too
    intrusive, so the equivalent here makes sure a granted app's window is
    foreground: the frontmost gate then passes and input reaches the target
    instead of the chat box. Nothing gets hidden — returns []."""
    allow = {a.strip().lower() for a in allowlist if a and a.strip()}
    if not allow:
        return []
    hwnd = win32gui.GetForegroundWindow()
    if hwnd:
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        path = get_process_path(pid)
        if path and os.path.normcase(path) in allow:
            return []  # a granted app is already frontmost
    target: int | None = None
    minimized: int | None = None

    def callback(h: int, _lparam: int) -> bool:
        nonlocal target, minimized
        if target is not None:
            return True  # already hold the topmost visible allowlisted window
        if not win32gui.IsWindowVisible(h):
            return True
        _, pid = win32process.GetWindowThreadProcessId(h)
        path = get_process_path(pid)
        if not path or os.path.normcase(path) not in allow:
            return True
        if not (win32gui.GetWindowText(h) or "").strip():
            return True
        if win32gui.IsIconic(h):
            if minimized is None:
                minimized = h
            return True
        target = h  # topmost visible allowlisted window (z-order)
        return True  # never return False — pywin32 turns that into error(2)

    win32gui.EnumWindows(callback, None)
    chosen = target if target is not None else minimized
    if chosen is not None:
        if win32gui.IsIconic(chosen):
            win32gui.ShowWindow(chosen, SW_RESTORE)
            time.sleep(0.05)
        _force_foreground(chosen)
    return []


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command")
    parser.add_argument("--payload", default="{}")
    args = parser.parse_args()
    payload = json.loads(args.payload)

    try:
        command = args.command
        if command == "check_permissions":
            json_output({"ok": True, "result": check_permissions()})
            return 0
        if command == "list_displays":
            json_output({"ok": True, "result": get_displays()})
            return 0
        if command == "get_display_size":
            json_output({"ok": True, "result": choose_display(payload.get("displayId"))})
            return 0
        if command == "screenshot":
            resize = None
            if payload.get("targetWidth") and payload.get("targetHeight"):
                resize = (int(payload["targetWidth"]), int(payload["targetHeight"]))
            result = capture_display(payload.get("displayId"), resize)
            json_output({"ok": True, "result": result})
            return 0
        if command == "resolve_prepare_capture":
            resize = None
            if payload.get("targetWidth") and payload.get("targetHeight"):
                resize = (int(payload["targetWidth"]), int(payload["targetHeight"]))
            result = capture_display(payload.get("preferredDisplayId"), resize)
            result["hidden"] = []
            result["resolvedDisplayId"] = result["displayId"]
            json_output({"ok": True, "result": result})
            return 0
        if command == "zoom":
            resize = None
            if payload.get("targetWidth") and payload.get("targetHeight"):
                resize = (int(payload["targetWidth"]), int(payload["targetHeight"]))
            region = {
                "left": int(payload["x"]),
                "top": int(payload["y"]),
                "width": int(payload["width"]),
                "height": int(payload["height"]),
            }
            json_output({"ok": True, "result": capture_monitor(region, resize)})
            return 0
        if command == "prepare_for_action":
            json_output({"ok": True, "result": prepare_for_action(list(payload.get("allowlistBundleIds") or []))})
            return 0
        if command == "preview_hide_set":
            json_output({"ok": True, "result": []})
            return 0
        if command == "find_window_displays":
            json_output({"ok": True, "result": find_window_displays(list(payload.get("bundleIds") or []))})
            return 0
        if command == "key":
            _ensure_input_can_reach_foreground()
            key_action(str(payload["keySequence"]), int(payload.get("repeat") or 1))
            json_output({"ok": True, "result": True})
            return 0
        if command == "hold_key":
            _ensure_input_can_reach_foreground()
            hold_keys(list(payload.get("keyNames") or []), int(payload.get("durationMs") or 0))
            json_output({"ok": True, "result": True})
            return 0
        if command == "type":
            _ensure_input_can_reach_foreground()
            type_text(str(payload.get("text") or ""))
            json_output({"ok": True, "result": True})
            return 0
        if command == "click":
            _ensure_input_can_reach_foreground()
            click(int(payload["x"]), int(payload["y"]), str(payload.get("button") or "left"), int(payload.get("count") or 1), payload.get("modifiers"))
            json_output({"ok": True, "result": True})
            return 0
        if command == "drag":
            _ensure_input_can_reach_foreground()
            from_point = payload.get("from")
            if from_point:
                pyautogui.moveTo(int(from_point["x"]), int(from_point["y"]))
            pyautogui.dragTo(int(payload["to"]["x"]), int(payload["to"]["y"]), duration=0.2, button="left")
            json_output({"ok": True, "result": True})
            return 0
        if command == "move_mouse":
            _ensure_input_can_reach_foreground()
            pyautogui.moveTo(int(payload["x"]), int(payload["y"]))
            json_output({"ok": True, "result": True})
            return 0
        if command == "scroll":
            _ensure_input_can_reach_foreground()
            scroll(int(payload["x"]), int(payload["y"]), int(payload.get("deltaX") or 0), int(payload.get("deltaY") or 0))
            json_output({"ok": True, "result": True})
            return 0
        if command == "mouse_down":
            pyautogui.mouseDown(button="left")
            json_output({"ok": True, "result": True})
            return 0
        if command == "mouse_up":
            pyautogui.mouseUp(button="left")
            json_output({"ok": True, "result": True})
            return 0
        if command == "cursor_position":
            x, y = pyautogui.position()
            json_output({"ok": True, "result": {"x": int(x), "y": int(y)}})
            return 0
        if command == "frontmost_app":
            json_output({"ok": True, "result": frontmost_app()})
            return 0
        if command == "app_under_point":
            json_output({"ok": True, "result": app_under_point(int(payload["x"]), int(payload["y"]))})
            return 0
        if command == "list_installed_apps":
            json_output({"ok": True, "result": installed_apps()})
            return 0
        if command == "list_running_apps":
            json_output({"ok": True, "result": running_apps()})
            return 0
        if command == "open_app":
            open_app(str(payload["bundleId"]))
            json_output({"ok": True, "result": True})
            return 0
        if command == "read_clipboard":
            json_output({"ok": True, "result": read_clipboard()})
            return 0
        if command == "write_clipboard":
            write_clipboard(str(payload.get("text") or ""))
            json_output({"ok": True, "result": True})
            return 0
        error_output(f"Unknown command: {command}", code="bad_command")
        return 2
    except Exception as exc:
        error_output(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
