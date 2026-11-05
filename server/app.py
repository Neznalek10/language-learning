"""HTTP layer of the language-learning server: JSON API routes, static files and server creation.

Responsibility:
    Turn HTTP requests into calls on the data store, the .env file and the static
    allowlist, and turn the results back into responses. Every security decision
    (Host, Origin, content type, which file may be served) comes from server/guard.py
    and every data rule from server/datastore.py and server/envfile.py; this module
    only wires them together and adds the body-size and header rules.

Where it fits:
    serve.py calls `create_server` and runs it; tests/test_app.py and the integration
    tests start it on port 0 in a thread. The browser sync engine (js/sync) talks to
    the /api routes defined here.

Invariants:
    * The Host check runs first for every request; for PUT and POST the content type
      and Origin checks run before the route is looked up, so a cross-site form post
      never reaches any handler.
    * Request bodies are read only after a valid Content-Length of at most
      MAX_BODY_BYTES, and exactly that many bytes are read.
    * Request bodies and key values are never logged. Only the method and path are.
    * The protocol is HTTP/1.0 (one request per connection), so an unread body can
      never be mistaken for the next request.
    * Every JSON response carries `Cache-Control: no-store`; every static response
      carries the security headers in STATIC_HEADERS.
"""

from __future__ import annotations

import contextlib
import json
import logging
import mimetypes
import os
import re
import shutil
import socket
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from server.datastore import (
    CONFLICTS_DIR_NAME,
    DATA_FILE_NAME,
    DataError,
    DataStore,
    RevisionConflict,
    validate_entries,
)
from server.envfile import EnvError, EnvFile
from server.guard import is_allowed_host, is_allowed_origin, is_json_request, resolve_static

MAX_BODY_BYTES = 25 * 1024 * 1024
DEFAULT_PORT = 8768
DEFAULT_HOST = "127.0.0.1"
# Seconds a connection may stay silent; stops a stalled client from holding a thread forever.
REQUEST_TIMEOUT_SECONDS = 30
LOGGER_NAME = "language_app.server"
SERVER_NAME = "language-learning"

API_PREFIX = "/api"
DATA_DIR_NAME = "data"
ENV_FILE_NAME = ".env"
VERSION_FILE_NAME = "version.js"
FALLBACK_VERSION = "dev"
# Matches the version assignment in version.js, for example: self.APP_VERSION = '1.12.1';
VERSION_PATTERN = re.compile(r"""APP_VERSION\s*=\s*(['"])(?P<version>.+?)\1""")

AI_KEY_NAME = "AI_API_KEY"
STORAGE_MODE = "file"
READ_METHODS = frozenset({"GET", "HEAD"})
WRITE_METHODS = frozenset({"PUT", "POST"})

JSON_CONTENT_TYPE = "application/json; charset=utf-8"
DEFAULT_CONTENT_TYPE = "application/octet-stream"
JAVASCRIPT_CONTENT_TYPE = "text/javascript; charset=utf-8"
# Extensions whose type must not come from the system mime database (it differs between machines).
CONTENT_TYPE_OVERRIDES: dict[str, str] = {
    ".js": JAVASCRIPT_CONTENT_TYPE,
    ".mjs": JAVASCRIPT_CONTENT_TYPE,
    ".webmanifest": "application/manifest+json",
}

CONTENT_SECURITY_POLICY = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; media-src 'self' blob:; "
    "connect-src 'self' https: http://localhost:* http://127.0.0.1:*; "
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; worker-src 'self'"
)
NOSNIFF_HEADERS: dict[str, str] = {"X-Content-Type-Options": "nosniff"}
STATIC_HEADERS: dict[str, str] = {
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "Referrer-Policy": "no-referrer",
    **NOSNIFF_HEADERS,
}
API_HEADERS: dict[str, str] = {"Cache-Control": "no-store", **NOSNIFF_HEADERS}

# Next step appended to the 500 message for a damaged data file, so the user knows what to do.
DAMAGED_FILE_HINT = (
    "Fix or move data/language-data.json, for example after a git merge conflict, then restart."
)
INTERNAL_ERROR_MESSAGE = "The server could not read or write its files. See the server log."

logger = logging.getLogger(LOGGER_NAME)

# An API action takes the parsed JSON body (None for GET) and returns (status, JSON payload).
Reply = tuple[int, dict[str, Any]]
Action = Callable[[Any], Reply]


class ApiError(Exception):
    """A request that must be answered with an error status and a JSON message.

    Attributes:
        status: HTTP status code to send.
        message: Text for the `error` field of the response body.
        extra: Further fields to merge into the body (for example the current revision).
        headers: Further response headers (for example `Allow` on a 405).
    """

    def __init__(
        self,
        status: int,
        message: str,
        extra: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        """Store what is needed to build the error response.

        Args:
            status: HTTP status code, for example 400.
            message: Human-readable explanation; never contains request bodies or keys.
            extra: Optional additional body fields.
            headers: Optional additional response headers.
        """
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra or {}
        self.headers = headers or {}

    def payload(self) -> dict[str, Any]:
        """Return the JSON body: `{"error": message, **extra}`."""
        return {"error": self.message, **self.extra}


def read_version(root: Path) -> str:
    """Read the app version from `version.js` in the project root.

    Args:
        root: Project root folder.

    Returns:
        The APP_VERSION string, or "dev" when the file is missing or has no version.

    Example:
        >>> read_version(Path("."))  # doctest: +SKIP
        '2.0.0'
    """
    try:
        text = (root / VERSION_FILE_NAME).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return FALLBACK_VERSION
    match = VERSION_PATTERN.search(text)
    return match.group("version") if match else FALLBACK_VERSION


def _require_object(body: Any) -> dict[str, Any]:
    """Return `body` when it is a JSON object, otherwise raise a 400 ApiError."""
    if not isinstance(body, dict):
        raise ApiError(400, "The request body must be a JSON object.")
    return body


def _is_valid_revision(value: Any) -> bool:
    """Tell whether `value` is a non-negative integer (a bool is not a number here)."""
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


@contextlib.contextmanager
def _damaged_file_means_500() -> Iterator[None]:
    """Turn a DataError raised by reading the stored data file into a 500 ApiError.

    Payloads are validated before the store is called, so a DataError that still
    comes out of the store means the file on disk is corrupt, which is a server-side
    problem and not a bad request.

    Raises:
        ApiError: Status 500 with the store's message, which names the file and what is wrong,
            plus the next step for the user.
    """
    try:
        yield
    except DataError as error:
        raise ApiError(500, f"The stored data file is damaged: {error} {DAMAGED_FILE_HINT}") from error


class LanguageApi:
    """The JSON API: one method per route, free of any HTTP socket handling.

    Attributes:
        routes: Path -> {HTTP method -> action}. A path missing here is a 404, a method
            missing for a known path is a 405.
    """

    def __init__(self, store: DataStore, env: EnvFile, version: str) -> None:
        """Wire the API to its collaborators.

        Args:
            store: The data file store.
            env: The .env file holding the AI key.
            version: App version reported by /api/status.
        """
        self._store = store
        self._env = env
        self._version = version
        self.routes: dict[str, dict[str, Action]] = {
            f"{API_PREFIX}/status": {"GET": self.get_status},
            f"{API_PREFIX}/data": {"GET": self.get_data, "PUT": self.put_data},
            f"{API_PREFIX}/conflicts": {"POST": self.post_conflict},
            f"{API_PREFIX}/keys": {"GET": self.get_keys, "PUT": self.put_keys},
        }

    def get_status(self, _body: Any) -> Reply:
        """GET /api/status: app name, version, storage mode and the state of the data file.

        Raises:
            ApiError: 500 when the stored data file is damaged.
        """
        with _damaged_file_means_500():
            stored = self._store.status()
        return 200, {
            "app": SERVER_NAME,
            "version": self._version,
            "mode": STORAGE_MODE,
            "dataFile": f"{DATA_DIR_NAME}/{DATA_FILE_NAME}",
            "exists": stored["exists"],
            "revision": stored["revision"],
            "savedAt": stored["savedAt"],
            "hasAiKey": bool(self._env.read()[AI_KEY_NAME]),
        }

    def get_data(self, _body: Any) -> Reply:
        """GET /api/data: the whole data file object.

        Raises:
            ApiError: 404 when no data file exists yet, 500 when it is damaged.
        """
        with _damaged_file_means_500():
            stored = self._store.load()
        if stored is None:
            raise ApiError(404, "There is no data file yet.")
        return 200, stored.to_json()

    def put_data(self, body: Any) -> Reply:
        """PUT /api/data: save entries as the next revision if `baseRevision` is current.

        Raises:
            ApiError: 400 for a malformed payload, 409 when the revision is stale
                (the body carries the current revision), 500 when the stored file is damaged.
        """
        payload = _require_object(body)
        base_revision = payload.get("baseRevision")
        if not _is_valid_revision(base_revision):
            raise ApiError(400, "baseRevision must be an integer of 0 or more.")
        if "entries" not in payload:
            raise ApiError(400, "entries is required.")
        entries = self._validated_entries(payload["entries"])
        try:
            with _damaged_file_means_500():
                saved = self._store.save(base_revision, entries)
        except RevisionConflict as conflict:
            raise ApiError(409, str(conflict), {"revision": conflict.current}) from conflict
        return 200, {"revision": saved.revision, "savedAt": saved.saved_at}

    def post_conflict(self, body: Any) -> Reply:
        """POST /api/conflicts: keep local entries that lost a conflict under data/conflicts/.

        Raises:
            ApiError: 400 when entries or reason are invalid.
        """
        payload = _require_object(body)
        reason = payload.get("reason")
        if not isinstance(reason, str):
            raise ApiError(400, "reason must be a string.")
        entries = self._validated_entries(payload.get("entries"))
        try:
            written = self._store.save_conflict(entries, reason)
        except DataError as error:
            raise ApiError(400, str(error)) from error
        return 201, {"file": f"{DATA_DIR_NAME}/{CONFLICTS_DIR_NAME}/{written.name}"}

    def get_keys(self, _body: Any) -> Reply:
        """GET /api/keys: every allowlisted .env value ("" when unset)."""
        return 200, dict(self._env.read())

    def put_keys(self, body: Any) -> Reply:
        """PUT /api/keys: set or remove allowlisted .env values.

        Raises:
            ApiError: 400 for an unknown key name or a value that is not allowed.
        """
        values = _require_object(body)
        try:
            stored = self._env.write(values)
        except EnvError as error:
            raise ApiError(400, str(error)) from error
        return 200, {"hasAiKey": bool(stored[AI_KEY_NAME])}

    @staticmethod
    def _validated_entries(entries: Any) -> dict[str, Any]:
        """Run the data store's entry rules and report a violation as a 400 ApiError."""
        try:
            return validate_entries(entries)
        except DataError as error:
            raise ApiError(400, str(error)) from error


def _content_type_for(path: Path) -> str:
    """Return the Content-Type for a static file.

    Args:
        path: The file about to be served.

    Returns:
        The override for .js/.mjs/.webmanifest, else the mimetypes guess, else octet-stream.
    """
    suffix = path.suffix.lower()
    if suffix in CONTENT_TYPE_OVERRIDES:
        return CONTENT_TYPE_OVERRIDES[suffix]
    guessed, _encoding = mimetypes.guess_type(path.name)
    return guessed or DEFAULT_CONTENT_TYPE


def make_handler(
    root: Path, store: DataStore, env: EnvFile, port: int, version: str
) -> type[BaseHTTPRequestHandler]:
    """Build the request handler class for one server.

    Args:
        root: Project root that static files are served from.
        store: Data file store behind /api/data and /api/conflicts.
        env: .env file behind /api/keys.
        port: Port the server listens on; the Host header must name it.
        version: App version reported by /api/status.

    Returns:
        A BaseHTTPRequestHandler subclass bound to these collaborators.

    Example:
        >>> handler_class = make_handler(root, store, env, 8768, "2.0.0")  # doctest: +SKIP
    """
    api = LanguageApi(store, env, version)

    class LanguageHandler(BaseHTTPRequestHandler):
        """Handles one request: guard checks, then an API route or a static file."""

        server_version = SERVER_NAME
        sys_version = ""
        timeout = REQUEST_TIMEOUT_SECONDS

        def _dispatch(self) -> None:
            """Answer the current request; every failure becomes a JSON error response."""
            try:
                self._route()
            except ApiError as error:
                self._send_json(error.status, error.payload(), error.headers)
            except (BrokenPipeError, ConnectionResetError):
                # The browser navigated away mid-response; nothing is left to answer.
                logger.debug("Client closed the connection early.")
                self.close_connection = True
            except Exception:
                # The one top-level handler: unexpected failures (for example a read-only disk)
                # are logged with their traceback, and the client gets a generic message.
                logger.exception("Unhandled error while serving %s %s", self.command, self._path_only())
                self._send_json(500, {"error": INTERNAL_ERROR_MESSAGE})

        # All methods share one entry point so unsupported ones get a JSON 405, not the framework's HTML 501.
        do_GET = do_HEAD = do_PUT = do_POST = do_DELETE = do_PATCH = do_OPTIONS = _dispatch

        def _path_only(self) -> str:
            """Return the request path without query string or fragment."""
            return self.path.split("#", 1)[0].split("?", 1)[0]

        def _route(self) -> None:
            """Run the guard checks and hand the request to the API or the static server.

            Raises:
                ApiError: 403 for a foreign Host, Origin or content type, 405 for a method
                    the target does not support, plus whatever the target raises.
            """
            host = self.headers.get("Host")
            if not is_allowed_host(host, port):
                raise ApiError(403, "This server only answers requests addressed to localhost.")
            method = self.command
            if method in WRITE_METHODS:
                self._check_write_headers(host or "")
            path = self._path_only()
            if path == API_PREFIX or path.startswith(API_PREFIX + "/"):
                self._serve_api(method, path)
            elif method in READ_METHODS:
                self._serve_static()
            else:
                raise ApiError(405, "Only GET and HEAD are supported here.", headers={"Allow": "GET, HEAD"})

        def _check_write_headers(self, host: str) -> None:
            """Reject writes that a cross-site page could have sent.

            Args:
                host: The already validated Host header.

            Raises:
                ApiError: 403 when the content type is not JSON or the Origin is foreign.
            """
            # Cross-site HTML forms cannot send application/json without a CORS preflight.
            if not is_json_request(self.headers.get("Content-Type")):
                raise ApiError(403, "Writes must be sent as application/json.")
            if not is_allowed_origin(self.headers.get("Origin"), host):
                raise ApiError(403, "Cross-origin writes are not allowed.")

        def _serve_api(self, method: str, path: str) -> None:
            """Find the API action for `method` and `path`, run it and send its reply.

            Raises:
                ApiError: 404 for an unknown path, 405 for a wrong method, plus the action's own errors.
            """
            actions = api.routes.get(path)
            if actions is None:
                raise ApiError(404, "Unknown API path.")
            action = actions.get(method)
            if action is None:
                raise ApiError(405, f"{method} is not supported here.", headers={"Allow": ", ".join(sorted(actions))})
            body = self._read_json_body() if method in WRITE_METHODS else None
            status, payload = action(body)
            self._send_json(status, payload)

        def _read_json_body(self) -> Any:
            """Read and parse the request body, which must be JSON of at most MAX_BODY_BYTES.

            Returns:
                The parsed JSON value.

            Raises:
                ApiError: 411 without Content-Length, 400 for a malformed length, a truncated
                    body or invalid JSON, 413 when the declared size exceeds the limit.
            """
            declared = self.headers.get("Content-Length")
            if declared is None:
                raise ApiError(411, "A Content-Length header is required.")
            # isascii first: str.isdigit() also accepts digits such as "²" that int() rejects.
            if not (declared.isascii() and declared.isdigit()):
                raise ApiError(400, "Content-Length must be a non-negative integer.")
            length = int(declared)
            if length > MAX_BODY_BYTES:
                raise ApiError(413, f"The request body is larger than {MAX_BODY_BYTES // (1024 * 1024)} MB.")
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ApiError(400, "The request body is shorter than its Content-Length.")
            try:
                return json.loads(raw.decode("utf-8"))
            except (ValueError, RecursionError) as error:
                # ValueError covers bad JSON and bad UTF-8; RecursionError is absurdly deep nesting.
                raise ApiError(400, "The request body is not valid JSON.") from error

        def _serve_static(self) -> None:
            """Send (GET) or describe (HEAD) the allowlisted file the request path points at.

            Raises:
                ApiError: 404 when the guard refuses the path or the file cannot be opened.
            """
            # Serve exactly the path the guard resolved, never one rebuilt from the URL.
            target = resolve_static(root, self.path)
            if target is None:
                raise ApiError(404, "Not found.")
            try:
                handle = target.open("rb")
            except OSError as error:
                raise ApiError(404, "Not found.") from error
            with handle:
                size = os.fstat(handle.fileno()).st_size
                self._send_head(200, _content_type_for(target), size, STATIC_HEADERS)
                if self.command != "HEAD":
                    # Streamed in chunks so a large file never sits in memory.
                    shutil.copyfileobj(handle, self.wfile)

        def _send_json(self, status: int, payload: dict[str, Any], extra_headers: dict[str, str] | None = None) -> None:
            """Send a JSON response with the API headers (no-store, nosniff).

            Args:
                status: HTTP status code.
                payload: JSON-serializable body.
                extra_headers: Optional further headers, for example Allow.
            """
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self._send_head(status, JSON_CONTENT_TYPE, len(body), {**API_HEADERS, **(extra_headers or {})})
            if self.command != "HEAD":
                self.wfile.write(body)

        def _send_head(self, status: int, content_type: str, length: int, headers: dict[str, str]) -> None:
            """Send the status line and headers of a response.

            Args:
                status: HTTP status code.
                content_type: Value of Content-Type.
                length: Size of the body in bytes (also sent for HEAD, as the standard asks).
                headers: Further headers to add.
            """
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(length))
            for name, value in headers.items():
                self.send_header(name, value)
            self.end_headers()

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 (name fixed by the base class)
            """Route the framework's request log to the logging module at debug level."""
            logger.debug("%s %s", self.address_string(), format % args)

        def log_error(self, format: str, *args: Any) -> None:  # noqa: A002 (name fixed by the base class)
            """Route the framework's error log to the logging module as a warning."""
            logger.warning("%s %s", self.address_string(), format % args)

    return LanguageHandler


class _Ipv6Server(ThreadingHTTPServer):
    """ThreadingHTTPServer that listens on an IPv6 address such as ::1."""

    address_family = socket.AF_INET6


def create_server(
    root: Path,
    port: int = DEFAULT_PORT,
    host: str = DEFAULT_HOST,
    data_dir: Path | None = None,
    env_path: Path | None = None,
) -> ThreadingHTTPServer:
    """Create (but do not start) the language-learning server.

    Args:
        root: Project root; static files come from here.
        port: TCP port; 0 picks a free one (used by tests), and the Host check then
            uses the port that was actually bound.
        host: Address to bind, 127.0.0.1 by default.
        data_dir: Folder for the data file; defaults to `root/data`.
        env_path: The .env file; defaults to `root/.env`.

    Returns:
        A ThreadingHTTPServer; call `serve_forever()` to run it and `server_close()` after.

    Raises:
        OSError: The address cannot be bound (for example the port is already in use).

    Example:
        >>> server = create_server(Path("."), port=0)  # doctest: +SKIP
        >>> server.server_address[1] > 0  # doctest: +SKIP
        True
    """
    project_root = root.resolve()
    store = DataStore(data_dir if data_dir is not None else project_root / DATA_DIR_NAME)
    env = EnvFile(env_path if env_path is not None else project_root / ENV_FILE_NAME)
    server_class = _Ipv6Server if ":" in host else ThreadingHTTPServer
    server = server_class((host, port), BaseHTTPRequestHandler)
    # The real port is only known after binding (port 0), and the handler needs it for the Host
    # check, so the handler class is attached now. serve_forever has not started yet.
    server.RequestHandlerClass = make_handler(
        project_root, store, env, server.server_address[1], read_version(project_root)
    )
    return server
