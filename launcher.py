#!/usr/bin/env python3
"""Desktop launcher of the language app: one click starts the server if needed and opens the app.

Responsibility:
    Make the app feel like an installed application instead of a console command:
    * `launcher.py` starts `serve.py` in the background when nothing answers on the port yet,
      waits until it is ready and opens the app (an app window in Chromium-family browsers,
      otherwise a normal window of the default browser).
    * `launcher.py --stop` stops a server this launcher started.
    * `launcher.py --install` adds "Language learning" to the desktop's app menu and to the Desktop
      folder; `--uninstall` removes both again.

Where it fits:
    The shortcut that `--install` writes runs `venv/bin/python launcher.py`. The launcher only
    talks to serve.py over HTTP (`GET /api/status`) and through its process; everything about
    requests stays in server/app.py.

Invariants:
    * Shortcut files are generated on each machine from the folder's real location, so the
      repository never contains a machine-specific path.
    * A port held by another program is never taken over: the launcher only reuses a server
      whose /api/status names this app, and otherwise reports the problem.
    * Started without a terminal, it reports errors with a desktop notification as well as stderr.
"""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from collections.abc import Callable
from pathlib import Path

from server.app import DEFAULT_HOST, DEFAULT_PORT, SERVER_NAME

PROJECT_ROOT = Path(__file__).resolve().parent
APP_TITLE = "Language learning"
DESKTOP_FILE_NAME = "language-learning.desktop"
ICON_PATH = PROJECT_ROOT / "icons" / "icon-512.png"
STATUS_TIMEOUT_S = 1.0
STARTUP_TIMEOUT_S = 15.0
POLL_INTERVAL_S = 0.2
STOP_TIMEOUT_S = 5.0
EXIT_OK = 0
EXIT_FAILURE = 1
# Browsers that can show a page as its own app window (no tabs or address bar), most common first.
APP_WINDOW_BROWSERS = (
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "brave-browser",
    "microsoft-edge",
)
# Characters the Desktop Entry spec requires to be escaped inside a quoted Exec argument.
EXEC_SPECIAL_CHARACTERS = ('\\', '"', "`", "$")


class LauncherError(Exception):
    """An expected problem with a message written for the user (shown without a traceback)."""


def app_url(port: int) -> str:
    """Return the address of the app on this computer.

    Args:
        port: The server's TCP port.

    Returns:
        For example "http://127.0.0.1:8768/".
    """
    return f"http://{DEFAULT_HOST}:{port}/"


def state_dir() -> Path:
    """Return the folder for the launcher's log and pid files (XDG state folder).

    Returns:
        `$XDG_STATE_HOME/language-learning`, or `~/.local/state/language-learning` when the variable is unset.
    """
    base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(base) / "language-learning"


def pid_file(port: int) -> Path:
    """Return the pid file of the server the launcher started on `port` (one per port)."""
    return state_dir() / f"server-{port}.pid"


def probe(port: int) -> str:
    """Ask what answers on the port.

    Args:
        port: The TCP port on 127.0.0.1.

    Returns:
        "ours" when the language app's server answers, "other" when something else answers, and
        "free" when nothing is listening.
    """
    try:
        with urllib.request.urlopen(f"{app_url(port)}api/status", timeout=STATUS_TIMEOUT_S) as reply:
            server = reply.headers.get("Server", "")
    except urllib.error.HTTPError as error:
        # An error reply (for example 500 for a damaged data file) still comes from our server; the app
        # then shows the problem in Account, which helps more than "port in use".
        server = error.headers.get("Server", "")
    except (urllib.error.URLError, TimeoutError, ConnectionError):
        return "free"
    # server/app.py names itself in the Server header of every reply.
    return "ours" if server.split("/")[0].strip() == SERVER_NAME else "other"


def start_server(port: int, python: str = sys.executable) -> subprocess.Popen:
    """Start serve.py in the background, detached from the launcher, logging to the state folder.

    Args:
        port: The TCP port to serve on.
        python: The interpreter to run serve.py with (the venv's, when run from the shortcut).

    Returns:
        The started process. Its pid is also written to `pid_file(port)` for `--stop`.
    """
    folder = state_dir()
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / "server.log").open("a", encoding="utf-8") as log:
        # A new session keeps the server running after the launcher (and any terminal) exits.
        process = subprocess.Popen(
            [python, str(PROJECT_ROOT / "serve.py"), "--port", str(port)],
            cwd=PROJECT_ROOT,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    pid_file(port).write_text(f"{process.pid}\n", encoding="utf-8")
    return process


def ensure_server(
    port: int,
    starter: Callable[[int], subprocess.Popen] = start_server,
    timeout_s: float = STARTUP_TIMEOUT_S,
) -> bool:
    """Make sure the language app's server answers on the port, starting it when the port is free.

    Args:
        port: The TCP port.
        starter: Starts the server (tests pass a fake).
        timeout_s: How long to wait for a started server to answer.

    Returns:
        True when this call started the server, False when one was already running.

    Raises:
        LauncherError: Another program holds the port, or the started server exits or does not
            answer in time.
    """
    state = probe(port)
    if state == "ours":
        return False
    if state == "other":
        raise LauncherError(f"Port {port} is used by another program. Stop it, or start the app with --port {port + 1}.")
    process = starter(port)
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if probe(port) == "ours":
            return True
        if process.poll() is not None:
            raise LauncherError(f"The server stopped right after starting. See {state_dir() / 'server.log'}.")
        time.sleep(POLL_INTERVAL_S)
    raise LauncherError(f"The server did not answer within {timeout_s:.0f} s. See {state_dir() / 'server.log'}.")


def app_window_command(url: str, which: Callable[[str], str | None] = shutil.which) -> list[str] | None:
    """Build the command that opens the app in its own window, when such a browser is installed.

    Args:
        url: The app address.
        which: Looks a program up on PATH (tests pass a fake).

    Returns:
        For example ["chromium", "--app=http://127.0.0.1:8768/"], or None when no
        Chromium-family browser is installed (Firefox has no app-window mode).
    """
    for name in APP_WINDOW_BROWSERS:
        path = which(name)
        if path:
            return [path, f"--app={url}"]
    return None


def open_app(url: str, which: Callable[[str], str | None] = shutil.which) -> None:
    """Open the app: LANGUAGE_APP_BROWSER if set, else an app window, else the default browser.

    Args:
        url: The app address.
        which: Looks a program up on PATH (tests pass a fake).
    """
    # The variable takes a command (for example "firefox --new-window"); the URL is added as the last argument.
    override = os.environ.get("LANGUAGE_APP_BROWSER", "").split()
    command = override + [url] if override else app_window_command(url, which)
    if command is None:
        webbrowser.open(url, new=1)
        return
    subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.DEVNULL, start_new_session=True)


def is_server_process(pid: int) -> bool:
    """Tell whether a pid still belongs to a running serve.py (a stale pid may have been reused).

    Args:
        pid: Process id from the pid file.

    Returns:
        True when /proc shows a process whose command line runs serve.py.
    """
    try:
        command = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
    except OSError:
        return False
    return any(part.endswith(b"serve.py") for part in command)


def stop_server(port: int) -> str:
    """Stop the server the launcher started on the port.

    Sends Ctrl+C (SIGINT), which serve.py handles as a clean stop, and SIGTERM if it is still
    running after STOP_TIMEOUT_S. Data is safe either way: the data file is only ever replaced
    by an atomic rename.

    Args:
        port: The TCP port.

    Returns:
        A one-line message for the user.
    """
    path = pid_file(port)
    try:
        pid = int(path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        pid = 0
    if not pid or not is_server_process(pid):
        path.unlink(missing_ok=True)
        if probe(port) == "ours":
            return "The server was started from a terminal. Stop it there with Ctrl+C."
        return "The server is not running."
    os.kill(pid, signal.SIGINT)
    deadline = time.monotonic() + STOP_TIMEOUT_S
    while time.monotonic() < deadline and is_server_process(pid):
        time.sleep(POLL_INTERVAL_S)
    if is_server_process(pid):
        os.kill(pid, signal.SIGTERM)
    path.unlink(missing_ok=True)
    return "The server is stopped."


def quote_exec_argument(argument: str) -> str:
    """Quote one argument for the Exec key of a .desktop file (Desktop Entry spec).

    Args:
        argument: A path or flag.

    Returns:
        The argument in double quotes, with ", `, $ and backslash escaped, and every % doubled
        (a single % would start a field code such as %u).
    """
    escaped = argument
    for character in EXEC_SPECIAL_CHARACTERS:
        escaped = escaped.replace(character, f"\\{character}")
    return '"' + escaped.replace("%", "%%") + '"'


def desktop_entry(root: Path, python: Path) -> str:
    """Build the .desktop file that starts the app, with a "Stop the server" action.

    Args:
        root: The project folder.
        python: The interpreter the shortcut runs (the folder's venv).

    Returns:
        The file's text.
    """
    run = " ".join(quote_exec_argument(str(part)) for part in (python, root / "launcher.py"))
    return (
        "[Desktop Entry]\n"
        "Type=Application\n"
        f"Name={APP_TITLE}\n"
        "Comment=Subjects, notes and practice, saved in data/language-data.json\n"
        f"Exec={run}\n"
        f"Icon={root / 'icons' / 'icon-512.png'}\n"
        "Terminal=false\n"
        "Categories=Education;\n"
        "StartupNotify=false\n"
        "Actions=stop;\n"
        "\n"
        "[Desktop Action stop]\n"
        "Name=Stop the server\n"
        f"Exec={run} --stop\n"
    )


def applications_dir() -> Path:
    """Return the per-user folder the desktop's app menu reads (XDG data folder)."""
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "applications"


def desktop_dir() -> Path:
    """Return the user's Desktop folder (as `xdg-user-dir DESKTOP` reports it, else ~/Desktop)."""
    try:
        found = subprocess.run(["xdg-user-dir", "DESKTOP"], capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        found = ""
    return Path(found) if found else Path.home() / "Desktop"


def install(root: Path = PROJECT_ROOT, on_desktop: bool = True) -> list[Path]:
    """Add the app to the app menu and, if wanted, to the Desktop.

    Args:
        root: The project folder.
        on_desktop: Also put the shortcut on the Desktop (see mark_trusted for GNOME's launch permission).

    Returns:
        The shortcut files written.

    Raises:
        LauncherError: The folder's venv is missing (the shortcut needs its Python).
    """
    python = root / "venv" / "bin" / "python"
    if not python.exists():
        raise LauncherError("venv/ is missing. Run: python3 -m venv venv && venv/bin/pip install -r requirements.txt")
    text = desktop_entry(root, python)
    targets = [applications_dir() / DESKTOP_FILE_NAME]
    if on_desktop and desktop_dir().is_dir():
        targets.append(desktop_dir() / DESKTOP_FILE_NAME)
    for target in targets:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        target.chmod(0o755)
    return targets


def mark_trusted(path: Path) -> bool:
    """Mark a Desktop shortcut as trusted so GNOME's desktop icons launch it on a double click.

    Args:
        path: The .desktop file on the Desktop.

    Returns:
        True when gio set the mark; False when it could not (no gio or no metadata service), and the
        user then allows it once by hand (right-click, "Allow Launching").
    """
    try:
        done = subprocess.run(["gio", "set", str(path), "metadata::trusted", "true"],
                              capture_output=True, timeout=5, check=False)
    except (OSError, subprocess.SubprocessError):
        return False
    return done.returncode == 0


def uninstall() -> list[Path]:
    """Remove the shortcuts that `install` wrote.

    Returns:
        The files that were removed.
    """
    removed = []
    for target in (applications_dir() / DESKTOP_FILE_NAME, desktop_dir() / DESKTOP_FILE_NAME):
        if target.exists():
            target.unlink()
            removed.append(target)
    return removed


def notify(message: str) -> None:
    """Show a desktop notification (best effort: a launch from the menu has no terminal for stderr)."""
    try:
        subprocess.run(["notify-send", APP_TITLE, message], capture_output=True, timeout=5, check=False)
    except (OSError, subprocess.SubprocessError):
        pass


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser (start and open is the default action)."""
    parser = argparse.ArgumentParser(
        description="Start the language app if needed and open it. The installed shortcut runs this.",
        epilog="examples:\n  venv/bin/python launcher.py --install\n  venv/bin/python launcher.py --stop",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--install", action="store_true", help="add Language learning to the app menu and the Desktop")
    action.add_argument("--uninstall", action="store_true", help="remove the shortcuts again")
    action.add_argument("--stop", action="store_true", help="stop the server the launcher started")
    parser.add_argument("--no-desktop", action="store_true", help="with --install: app menu only")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"server port (default {DEFAULT_PORT})")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run the launcher.

    Args:
        argv: Arguments without the program name; None reads sys.argv.

    Returns:
        The exit code: 0 on success, 1 for an expected problem (also shown as a notification).
    """
    options = build_parser().parse_args(argv)
    try:
        if options.install:
            written = install(on_desktop=not options.no_desktop)
            for path in written:
                print(f"Shortcut: {path}")
            # The menu entry needs no mark; only the Desktop copy (the second file) does.
            if len(written) > 1 and not mark_trusted(written[1]):
                print('On the Desktop, right-click "Language learning" once and choose "Allow Launching".')
            print('Open "Language learning" from the app menu or the Desktop.')
        elif options.uninstall:
            removed = uninstall()
            print("\n".join(f"Removed: {path}" for path in removed) or "No shortcuts were installed.")
        elif options.stop:
            message = stop_server(options.port)
            print(message)
            notify(message)
        else:
            ensure_server(options.port)
            open_app(app_url(options.port))
    except LauncherError as error:
        print(f"{APP_TITLE}: {error}", file=sys.stderr)
        notify(str(error))
        return EXIT_FAILURE
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
