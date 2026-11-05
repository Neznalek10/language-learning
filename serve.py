#!/usr/bin/env python3
"""Command-line entry point of the language app: starts the local server.

Responsibility:
    Parse the command-line options, configure logging, refuse unsafe bind addresses,
    start server/app.py, print where the app and its data file are, optionally open the
    browser, and stop cleanly on Ctrl+C.

Where it fits:
    Run it from the project folder with `venv/bin/python serve.py`. It uses
    `server.app.create_server`; everything about requests lives there.

Invariants:
    * The server only binds loopback addresses: the Host check accepts loopback names only, so a
      non-loopback bind could never serve another machine and is refused with a clear message.
    * Expected problems (busy port, refused host) print one line to stderr and exit non-zero,
      without a stack trace. Request bodies and keys are never logged.
"""

from __future__ import annotations

import argparse
import errno
import logging
import sys
import webbrowser
from pathlib import Path

from server.app import DEFAULT_HOST, DEFAULT_PORT, create_server
from server.datastore import DATA_FILE_NAME

PROJECT_ROOT = Path(__file__).resolve().parent
# The only bind addresses whose Host header server/guard.py accepts.
LOOPBACK_BIND_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})
MAX_PORT = 65535
LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"
EXIT_OK = 0
EXIT_FAILURE = 1

logger = logging.getLogger("language_app.serve")


def is_loopback_host(host: str) -> bool:
    """Tell whether a bind address is one the server can answer on.

    Only 127.0.0.1, ::1 and localhost pass. Other loopback addresses such as 127.0.0.2 are refused too:
    server/guard.py rejects their Host header, so every request would fail with 403.

    Args:
        host: Host name or IP address, for example "127.0.0.1", "::1" or "localhost".

    Returns:
        True for the three addresses above (case-insensitive); False for anything else,
        including "0.0.0.0", "127.0.0.2", "" and other names.

    Example:
        >>> is_loopback_host("127.0.0.1")
        True
        >>> is_loopback_host("0.0.0.0")
        False
    """
    return host.lower() in LOOPBACK_BIND_HOSTS


def _port_number(text: str) -> int:
    """argparse type for --port: an integer from 0 (pick a free port) to 65535."""
    try:
        port = int(text)
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"{text!r} is not a number.") from error
    if not 0 <= port <= MAX_PORT:
        raise argparse.ArgumentTypeError(f"port must be between 0 and {MAX_PORT}.")
    return port


def build_parser() -> argparse.ArgumentParser:
    """Create the command-line parser.

    Returns:
        The parser for `serve.py`, with usage examples in its help text.
    """
    parser = argparse.ArgumentParser(
        prog="serve.py",
        description="Run the language app locally and keep its data in data/language-data.json.",
        epilog="examples:\n  python serve.py\n  python serve.py --port 9000 --open\n  python serve.py --verbose",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--port", type=_port_number, default=DEFAULT_PORT, help=f"port to listen on (default {DEFAULT_PORT})"
    )
    parser.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help=f"loopback address to bind (default {DEFAULT_HOST}, this computer only)",
    )
    parser.add_argument("--open", action="store_true", help="open the app in the default browser")
    parser.add_argument("--verbose", action="store_true", help="log every request and internal detail to stderr")
    return parser


def _url_for(host: str, port: int) -> str:
    """Build the address to show for a bind host (IPv6 literals need brackets)."""
    shown_host = f"[{host}]" if ":" in host else host
    return f"http://{shown_host}:{port}/"


def _start_failure_message(host: str, port: int, error: OSError) -> str:
    """Build the one-line message for a server that could not start, with the next step.

    Args:
        host: The address that was requested.
        port: The port that was requested.
        error: The OSError raised while binding.

    Returns:
        A single line; for a busy port it names the alternative port to try.
    """
    if error.errno == errno.EADDRINUSE and 0 < port < MAX_PORT:
        return f"Port {port} is in use. Stop the other server or start with --port {port + 1}."
    return f"Could not start the server on {host}:{port}: {error.strerror or error}"


def main(argv: list[str] | None = None) -> int:
    """Run the server until Ctrl+C.

    Args:
        argv: Command-line arguments without the program name; None means sys.argv.

    Returns:
        The process exit code: 0 after a clean stop, 1 when the server could not start.
        Invalid options exit with code 2 through argparse.
    """
    parser = build_parser()
    options = parser.parse_args(argv)
    # The server rejects any Host header other than these three names, so any other bind can never work.
    if not is_loopback_host(options.host):
        parser.error(
            f"--host {options.host} is not allowed; the language app is local-only. "
            "Use 127.0.0.1, ::1 or localhost."
        )
    logging.basicConfig(
        stream=sys.stderr, level=logging.DEBUG if options.verbose else logging.INFO, format=LOG_FORMAT
    )
    try:
        server = create_server(PROJECT_ROOT, port=options.port, host=options.host)
    except OSError as error:
        print(_start_failure_message(options.host, options.port, error), file=sys.stderr)
        return EXIT_FAILURE
    url = _url_for(options.host, server.server_address[1])
    print(f"Language learning: {url}")
    print(f"Data file: {PROJECT_ROOT / 'data' / DATA_FILE_NAME}")
    if options.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        # Ctrl+C is the normal way to stop: no traceback, a short note instead.
        logger.info("Stopping the server.")
    finally:
        server.server_close()
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
