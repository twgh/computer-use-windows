"""Desktop-free unit tests for the Windows Python helper.

Run with the runtime venv (the helper imports pywin32 / pyautogui / mss at
module load):

    project/.runtime/venv/Scripts/python.exe scripts/tests/test_windows_helper.py

Nothing here moves the cursor or injects input: `move_pointer` is stubbed and
`win32api.mouse_event` is captured, so the suite is safe to run while the user
is working and needs no desktop lock.
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "project" / "runtime" / "windows_helper.py"


def load_helper():
    spec = importlib.util.spec_from_file_location("windows_helper_under_test", HELPER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


wh = load_helper()

MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_HWHEEL = 0x1000


class TestRegistryPathExpansion(unittest.TestCase):
    """A grant is matched against the live process image path, which is always
    fully expanded — an unexpanded registry value can never equal it."""

    def test_expands_systemroot(self):
        out = wh.expand_registry_path(
            r"%systemroot%\system32\WindowsPowerShell\v1.0\powershell.exe"
        )
        self.assertFalse(out.lower().startswith("%"), out)
        self.assertTrue(out.lower().endswith(r"\powershell.exe"), out)
        self.assertIn("windowspowershell", out.lower())

    def test_unknown_variable_left_intact(self):
        raw = r"%not_a_real_var_xyz%\app.exe"
        self.assertEqual(wh.expand_registry_path(raw), raw)

    def test_extract_from_quoted_display_icon(self):
        got = wh.extract_exe_from_command(r'"%systemroot%\system32\cmd.exe,0"')
        self.assertTrue(got.lower().endswith(r"\cmd.exe"), got)

    def test_extract_strips_icon_index_unquoted(self):
        got = wh.extract_exe_from_command(r"C:\app\icon.exe,-123")
        self.assertEqual(got, r"C:\app\icon.exe")

    def test_extract_strips_positive_icon_index(self):
        got = wh.extract_exe_from_command(r"C:\app\icon.exe,0")
        self.assertEqual(got, r"C:\app\icon.exe")

    def test_quoted_path_with_negative_index(self):
        # The usual real-world shape: "C:\app\app.exe",-101
        got = wh.extract_exe_from_command(r'"C:\app\app.exe",-101')
        self.assertEqual(got, r"C:\app\app.exe")

    def test_comma_inside_a_real_path_is_not_stripped(self):
        # Guard against over-stripping: a comma followed by non-digits is part of
        # the path, not an icon index.
        raw = r"C:\Program Files\My App, Inc\app.exe"
        self.assertEqual(wh.extract_exe_from_command(raw), raw)

    def test_trailing_arguments_are_dropped(self):
        got = wh.extract_exe_from_command(r"C:\app\app.exe /silent --foo")
        self.assertEqual(got, r"C:\app\app.exe")

    def test_spaced_path_with_arguments(self):
        got = wh.extract_exe_from_command(r"C:\Program Files\App\app.exe -run")
        self.assertEqual(got, r"C:\Program Files\App\app.exe")


class TestScrollDelta(unittest.TestCase):
    """The regression that made `scroll` a silent no-op on self-drawn toolkits.

    pyautogui's win32 `_scroll` forwards its "clicks" argument into
    mouse_event's dwData unscaled, so 3 notches arrived as a wheel delta of 3 —
    1/40 of a notch, which apps floor to zero lines. The helper must scale by
    WHEEL_DELTA itself, and the sign must follow the executor's screen-coordinate
    dy (positive dy = scroll down = negative wheel delta).
    """

    def setUp(self):
        self.calls = []
        self._real = wh.win32api.mouse_event
        self._move = wh.move_pointer
        wh.win32api.mouse_event = lambda flags, dx, dy, data, extra: self.calls.append(
            (flags, dx, dy, data)
        )
        wh.move_pointer = lambda *a, **k: None  # never touch the real cursor

    def tearDown(self):
        wh.win32api.mouse_event = self._real
        wh.move_pointer = self._move

    def test_down_scales_by_wheel_delta_and_is_negative(self):
        wh.scroll(10, 10, 0, 3)
        self.assertEqual(self.calls, [(MOUSEEVENTF_WHEEL, 0, 0, -360)])

    def test_up_is_positive(self):
        wh.scroll(10, 10, 0, -3)
        self.assertEqual(self.calls, [(MOUSEEVENTF_WHEEL, 0, 0, 360)])

    def test_one_notch_is_exactly_120(self):
        wh.scroll(10, 10, 0, 1)
        self.assertEqual(self.calls[0][3], -wh.WHEEL_DELTA)
        self.assertEqual(abs(self.calls[0][3]), 120)

    def test_horizontal_scales_and_is_positive_right(self):
        wh.scroll(10, 10, 2, 0)
        self.assertEqual(self.calls, [(MOUSEEVENTF_HWHEEL, 0, 0, 240)])

    def test_zero_axes_inject_nothing(self):
        wh.scroll(10, 10, 0, 0)
        self.assertEqual(self.calls, [])

    def test_both_axes_emit_two_events(self):
        wh.scroll(10, 10, 1, 1)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual({c[0] for c in self.calls}, {MOUSEEVENTF_WHEEL, MOUSEEVENTF_HWHEEL})


class TestForegroundGuard(unittest.TestCase):
    """A focus-steal refusal is the normal outcome for a background process.
    Escaping it as a raw pywin32 tuple made every input action look like a
    broken tool."""

    def test_invalid_handle_returns_false_without_raising(self):
        for bogus in (0, 1, 999_999):
            with self.subTest(hwnd=bogus):
                self.assertIs(wh._force_foreground(bogus), False)


class TestFocusTriState(unittest.TestCase):
    def test_unknown_app_is_absent(self):
        got = wh.focus_existing_window(r"c:\definitely\not\here\nope.exe")
        self.assertEqual(got, "absent")

    def test_returns_only_documented_tokens(self):
        # Notepad++ / explorer are the realistic "a window exists" case on a
        # developer machine; whichever way it resolves it must be a token, not a
        # bool — the old bool is what let `present` fall through to launching.
        got = wh.focus_existing_window(r"c:\windows\explorer.exe")
        self.assertIn(got, {"focused", "present", "absent"})
        self.assertNotIn(got, (True, False))

    def test_console_host_detection_does_not_raise(self):
        # Returns None or an hwnd; must never throw when no terminal is open.
        self.assertTrue(wh._console_host_window() is None or isinstance(wh._console_host_window(), int))

    def test_process_running_false_for_nonexistent(self):
        self.assertFalse(wh._process_running(r"c:\nope\nope\x.exe"))


class TestWheelConstant(unittest.TestCase):
    def test_wheel_delta_is_120(self):
        self.assertEqual(wh.WHEEL_DELTA, 120)


if __name__ == "__main__":
    unittest.main(verbosity=2)
