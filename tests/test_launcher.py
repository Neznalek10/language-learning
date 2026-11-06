"""Tests for launcher.py: server detection and start, opening the app, and the desktop shortcut.

Servers run on free ports (port 0) in threads, and every file the launcher writes goes to temporary
XDG folders, so the tests never touch a real server, app menu or Desktop.
"""

from __future__ import annotations

import os
import socket
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import launcher
from server.app import create_server

POLL_INTERVAL = 0.05


def free_port() -> int:
    """Return a TCP port that nothing listens on right now."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class ForeignHandler(BaseHTTPRequestHandler):
    """Answers like an unrelated web server on the same port."""

    server_version = "nginx"

    def do_GET(self) -> None:  # noqa: N802 (http.server naming)
        """Reply 200 with a small HTML page."""
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"<html></html>")

    def log_message(self, *args: object) -> None:
        """Keep test output quiet."""


class ServerCase(unittest.TestCase):
    """Starts a server in a thread and stops it after the test."""

    def serve(self, httpd: ThreadingHTTPServer) -> int:
        """Run `httpd` until the test ends and return its port."""
        thread = threading.Thread(target=httpd.serve_forever, args=(POLL_INTERVAL,), daemon=True)
        thread.start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        return httpd.server_address[1]

    def app_server(self) -> int:
        """Start a real language-learning server on a throw-away root and return its port."""
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        return self.serve(create_server(root, port=0, data_dir=root / "data", env_path=root / ".env"))


class ProbeTests(ServerCase):
    """probe tells our server, another program and a free port apart."""

    def test_our_server_is_recognised(self) -> None:
        self.assertEqual(launcher.probe(self.app_server()), "ours")

    def test_another_program_on_the_port_is_not_ours(self) -> None:
        port = self.serve(ThreadingHTTPServer(("127.0.0.1", 0), ForeignHandler))
        self.assertEqual(launcher.probe(port), "other")

    def test_nothing_listening_is_free(self) -> None:
        self.assertEqual(launcher.probe(free_port()), "free")


class EnsureServerTests(ServerCase):
    """ensure_server reuses, starts or refuses."""

    def test_running_server_is_reused_without_starting_another(self) -> None:
        starter = mock.Mock()
        self.assertFalse(launcher.ensure_server(self.app_server(), starter=starter))
        starter.assert_not_called()

    def test_port_held_by_another_program_is_refused_with_a_hint(self) -> None:
        port = self.serve(ThreadingHTTPServer(("127.0.0.1", 0), ForeignHandler))
        with self.assertRaises(launcher.LauncherError) as raised:
            launcher.ensure_server(port, starter=mock.Mock())
        self.assertIn(f"--port {port + 1}", str(raised.exception))

    def test_free_port_starts_the_server_and_waits_until_it_answers(self) -> None:
        """The starter's server comes up a moment later; ensure_server returns once it answers."""
        root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        port = free_port()

        def starter(chosen: int) -> mock.Mock:
            self.serve(create_server(root, port=chosen, data_dir=root / "data", env_path=root / ".env"))
            return mock.Mock(poll=mock.Mock(return_value=None))

        self.assertTrue(launcher.ensure_server(port, starter=starter, timeout_s=5))
        self.assertEqual(launcher.probe(port), "ours")

    def test_server_that_exits_at_once_is_reported(self) -> None:
        dead = mock.Mock(poll=mock.Mock(return_value=1))
        with self.assertRaises(launcher.LauncherError) as raised:
            launcher.ensure_server(free_port(), starter=lambda port: dead, timeout_s=2)
        self.assertIn("server.log", str(raised.exception))


class OpenAppTests(unittest.TestCase):
    """open_app picks an app window when it can and the default browser otherwise."""

    URL = "http://127.0.0.1:8768/"

    def test_chromium_family_browser_opens_an_app_window(self) -> None:
        which = {"chromium": "/usr/bin/chromium"}.get
        self.assertEqual(launcher.app_window_command(self.URL, which), ["/usr/bin/chromium", f"--app={self.URL}"])

    def test_without_one_the_default_browser_is_used(self) -> None:
        with mock.patch.dict(os.environ, {"LANGUAGE_APP_BROWSER": ""}), \
                mock.patch.object(launcher.webbrowser, "open") as browser_open:
            launcher.open_app(self.URL, which=lambda name: None)
        browser_open.assert_called_once_with(self.URL, new=1)

    def test_app_browser_overrides_the_choice(self) -> None:
        with mock.patch.dict(os.environ, {"LANGUAGE_APP_BROWSER": "firefox --new-window"}), \
                mock.patch.object(launcher.subprocess, "Popen") as popen:
            launcher.open_app(self.URL, which=lambda name: "/usr/bin/chromium")
        self.assertEqual(popen.call_args.args[0], ["firefox", "--new-window", self.URL])


class DesktopEntryTests(unittest.TestCase):
    """The generated .desktop file follows the Desktop Entry spec."""

    def test_entry_runs_the_launcher_with_the_venv_python_and_has_a_stop_action(self) -> None:
        root = Path("/opt/language app")
        text = launcher.desktop_entry(root, root / "venv/bin/python")
        self.assertIn('Exec="/opt/language app/venv/bin/python" "/opt/language app/launcher.py"\n', text)
        self.assertIn('Exec="/opt/language app/venv/bin/python" "/opt/language app/launcher.py" --stop\n', text)
        self.assertIn("Icon=/opt/language app/icons/icon-512.png\n", text)
        self.assertIn("Terminal=false\n", text)
        self.assertIn("[Desktop Action stop]\n", text)

    def test_exec_arguments_escape_special_characters_and_percent(self) -> None:
        self.assertEqual(launcher.quote_exec_argument('/a"b$c`d\\e%f'), '"/a\\"b\\$c\\`d\\\\e%%f"')

    def test_unicode_paths_are_kept(self) -> None:
        self.assertIn("Příliš žluťoučký", launcher.quote_exec_argument("/home/Příliš žluťoučký"))


class InstallTests(unittest.TestCase):
    """install and uninstall write and remove the shortcuts in the XDG folders."""

    def setUp(self) -> None:
        self.home = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.root = self.home / "language-learning"
        (self.root / "venv" / "bin").mkdir(parents=True)
        (self.root / "venv" / "bin" / "python").touch()
        self.desktop = self.home / "Desktop"
        self.desktop.mkdir()
        self.enterContext(mock.patch.dict(os.environ, {"XDG_DATA_HOME": str(self.home / "share")}))
        self.enterContext(mock.patch.object(launcher, "desktop_dir", return_value=self.desktop))
        # gio and xdg-user-dir are replaced; mark_trusted's test sets the reply it needs.
        self.enterContext(mock.patch.object(launcher.subprocess, "run"))

    def test_install_writes_executable_shortcuts_to_the_menu_and_the_desktop(self) -> None:
        written = launcher.install(self.root)
        menu = self.home / "share" / "applications" / launcher.DESKTOP_FILE_NAME
        self.assertEqual(written, [menu, self.desktop / launcher.DESKTOP_FILE_NAME])
        for path in written:
            self.assertTrue(os.access(path, os.X_OK))
            self.assertIn(str(self.root / "launcher.py"), path.read_text(encoding="utf-8"))

    def test_no_desktop_writes_the_menu_entry_only(self) -> None:
        self.assertEqual(len(launcher.install(self.root, on_desktop=False)), 1)
        self.assertFalse((self.desktop / launcher.DESKTOP_FILE_NAME).exists())

    def test_missing_venv_is_refused_with_the_setup_command(self) -> None:
        with self.assertRaises(launcher.LauncherError) as raised:
            launcher.install(self.home / "elsewhere")
        self.assertIn("python3 -m venv venv", str(raised.exception))

    def test_mark_trusted_reports_whether_gio_succeeded(self) -> None:
        launcher.subprocess.run.return_value = mock.Mock(returncode=0)
        self.assertTrue(launcher.mark_trusted(self.desktop / "x.desktop"))
        launcher.subprocess.run.return_value = mock.Mock(returncode=1)
        self.assertFalse(launcher.mark_trusted(self.desktop / "x.desktop"))

    def test_uninstall_removes_what_install_wrote(self) -> None:
        written = launcher.install(self.root)
        self.assertEqual(sorted(launcher.uninstall()), sorted(written))
        self.assertEqual(launcher.uninstall(), [])


class StopTests(ServerCase):
    """stop_server only stops a server the launcher started."""

    def setUp(self) -> None:
        state = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(mock.patch.dict(os.environ, {"XDG_STATE_HOME": state}))

    def test_server_started_from_a_terminal_is_left_alone(self) -> None:
        self.assertIn("terminal", launcher.stop_server(self.app_server()))

    def test_stale_pid_file_is_removed_and_nothing_is_killed(self) -> None:
        port = free_port()
        path = launcher.pid_file(port)
        path.parent.mkdir(parents=True)
        path.write_text(f"{os.getpid()}\n", encoding="utf-8")
        with mock.patch.object(launcher.os, "kill") as kill:
            self.assertEqual(launcher.stop_server(port), "The server is not running.")
        kill.assert_not_called()
        self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
