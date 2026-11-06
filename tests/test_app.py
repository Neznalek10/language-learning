"""Tests for server/app.py and serve.py: routes, status codes, headers and the entry point.

Each test starts a real `create_server(port=0)` in a thread on a throw-away project root
(a few allowed and forbidden static files, plus a symlink that leaves the root) with its
own temp data folder and .env path, and talks to it over loopback HTTP. No shared state,
no network beyond 127.0.0.1.
"""

from __future__ import annotations

import contextlib
import http.client
import io
import json
import logging
import socket
import stat
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any

import serve
from server.app import (
    CONTENT_SECURITY_POLICY,
    LOGGER_NAME,
    MAX_BODY_BYTES,
    create_server,
    read_version,
)

JSON_TYPE = "application/json"
INDEX_HTML = "<!doctype html><title>Příliš žluťoučký kůň</title>"
SCRIPT_JS = "export const word = 'žluťoučký';\n"
PNG_BYTES = bytes(range(256)) * 4
VERSION_JS = "// Bump me\nself.APP_VERSION = '9.9.9';\n"
SECRET_TEXT = "TOP-SECRET-OUTSIDE"
TEST_KEY = "sk-test-0123456789"
SOCKET_TIMEOUT = 5
# Shutdown latency of serve_forever; the default 0.5 s would add seconds to every test.
POLL_INTERVAL = 0.01


class Response:
    """Status, headers and body of one HTTP response."""

    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        """Store the parts; header names are kept lower case."""
        self.status = status
        self.headers = headers
        self.body = body

    def json(self) -> Any:
        """Return the body parsed as JSON."""
        return json.loads(self.body.decode("utf-8"))


class ServerTestCase(unittest.TestCase):
    """Base class: a running server on a temp project root, and request helpers."""

    def setUp(self) -> None:
        """Create the temp project, start the server thread and remember how to reach it."""
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        base = Path(self._temp.name)
        self.root = base / "project"
        self.data_dir = base / "userdata"
        self.env_path = base / "user.env"
        self._build_project(base)
        self.httpd = create_server(self.root, port=0, data_dir=self.data_dir, env_path=self.env_path)
        self.port = self.httpd.server_address[1]
        thread = threading.Thread(target=self.httpd.serve_forever, args=(POLL_INTERVAL,), daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def _build_project(self, base: Path) -> None:
        """Write allowed and forbidden files, and a symlink that points out of the root."""
        outside = base / "outside.js"
        outside.write_text(SECRET_TEXT, encoding="utf-8")
        files = {
            "index.html": INDEX_HTML,
            "version.js": VERSION_JS,
            "manifest.json": "{}",
            "sw.js": "// sw",
            "js/a.js": SCRIPT_JS,
            "css/site.css": "body { color: black; }",
            ".env": "AI_API_KEY='sk-root-secret'\n",
            "data/x.json": "{}",
            "tools/t.sh": "echo hi\n",
            "server/app.py": "# source\n",
        }
        for name, text in files.items():
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        (self.root / "icons").mkdir()
        (self.root / "icons" / "i.png").write_bytes(PNG_BYTES)
        (self.root / "js" / "escape.js").symlink_to(outside)

    # -- request helpers ---------------------------------------------------------------------

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        headers: dict[str, str] | None = None,
        raw: bytes | None = None,
    ) -> Response:
        """Send one request and return the response.

        Args:
            method: HTTP method.
            path: Request target.
            body: Value sent as JSON (with a JSON content type) when not None.
            headers: Extra headers; they override the defaults, Host included.
            raw: Exact body bytes (sent with the JSON content type unless overridden).
        """
        sent = dict(headers or {})
        payload = raw
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
        if payload is not None:
            sent.setdefault("Content-Type", JSON_TYPE)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=SOCKET_TIMEOUT)
        try:
            connection.request(method, path, body=payload, headers=sent)
            reply = connection.getresponse()
            return Response(reply.status, {k.lower(): v for k, v in reply.getheaders()}, reply.read())
        finally:
            connection.close()

    def raw_request(self, head: str, body: bytes = b"") -> Response:
        """Send hand-written request bytes (for cases http.client would repair) and read the reply.

        Args:
            head: Request line and headers, lines separated by CRLF, without the final blank line.
            body: Bytes to send after the headers; the write side is then closed.
        """
        with socket.create_connection(("127.0.0.1", self.port), timeout=SOCKET_TIMEOUT) as sock:
            sock.sendall(head.encode("latin-1") + b"\r\n\r\n" + body)
            sock.shutdown(socket.SHUT_WR)
            reply = http.client.HTTPResponse(sock)
            reply.begin()
            return Response(reply.status, {k.lower(): v for k, v in reply.getheaders()}, reply.read())

    def put_data(self, base_revision: int, entries: dict[str, Any]) -> Response:
        """PUT /api/data with the given base revision and entries."""
        return self.request("PUT", "/api/data", {"baseRevision": base_revision, "entries": entries})

    def host_line(self) -> str:
        """Return the correct Host header line for raw requests."""
        return f"Host: 127.0.0.1:{self.port}"


class StaticTests(ServerTestCase):
    """Static files: allowlist, content types, security headers, HEAD."""

    def test_root_serves_index_with_security_headers(self) -> None:
        reply = self.request("GET", "/")
        self.assertEqual(reply.status, 200)
        self.assertEqual(reply.body, INDEX_HTML.encode("utf-8"))
        self.assertTrue(reply.headers["content-type"].startswith("text/html"))
        self.assertEqual(reply.headers["content-security-policy"], CONTENT_SECURITY_POLICY)
        self.assertEqual(reply.headers["x-content-type-options"], "nosniff")
        self.assertEqual(reply.headers["referrer-policy"], "no-referrer")
        self.assertEqual(reply.headers["content-length"], str(len(reply.body)))

    def test_csp_matches_the_contract_text(self) -> None:
        self.assertEqual(
            CONTENT_SECURITY_POLICY,
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; media-src 'self' blob:; "
            "connect-src 'self' https: http://localhost:* http://127.0.0.1:*; "
            "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; worker-src 'self'",
        )

    def test_javascript_content_type_and_unicode_body(self) -> None:
        reply = self.request("GET", "/js/a.js")
        self.assertEqual(reply.status, 200)
        self.assertEqual(reply.headers["content-type"], "text/javascript; charset=utf-8")
        self.assertEqual(reply.body.decode("utf-8"), SCRIPT_JS)

    def test_other_content_types(self) -> None:
        self.assertTrue(self.request("GET", "/css/site.css").headers["content-type"].startswith("text/css"))
        self.assertEqual(self.request("GET", "/icons/i.png").headers["content-type"], "image/png")
        self.assertTrue(self.request("GET", "/manifest.json").headers["content-type"].startswith("application/json"))

    def test_binary_file_is_served_byte_for_byte(self) -> None:
        self.assertEqual(self.request("GET", "/icons/i.png").body, PNG_BYTES)

    def test_root_files_in_the_allowlist_are_served(self) -> None:
        for path in ("/index.html", "/version.js", "/manifest.json", "/sw.js"):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path).status, 200)

    def test_query_string_is_ignored(self) -> None:
        self.assertEqual(self.request("GET", "/js/a.js?v=2").body.decode("utf-8"), SCRIPT_JS)

    def test_forbidden_and_missing_paths_are_404(self) -> None:
        for path in (
            "/.env",
            "/data/x.json",
            "/tools/t.sh",
            "/server/app.py",
            "/js/escape.js",
            "/js/missing.js",
            "/%2e%2e/etc/passwd",
            "/js/../.env",
            "/js",
        ):
            with self.subTest(path=path):
                reply = self.request("GET", path)
                self.assertEqual(reply.status, 404)
                self.assertNotIn(SECRET_TEXT.encode(), reply.body)
                self.assertNotIn(b"sk-root-secret", reply.body)

    def test_head_returns_headers_without_body(self) -> None:
        reply = self.request("HEAD", "/js/a.js")
        self.assertEqual(reply.status, 200)
        self.assertEqual(reply.body, b"")
        self.assertEqual(reply.headers["content-length"], str(len(SCRIPT_JS.encode("utf-8"))))
        self.assertEqual(reply.headers["content-type"], "text/javascript; charset=utf-8")
        self.assertIn("content-security-policy", reply.headers)

    def test_head_on_forbidden_path_is_404(self) -> None:
        self.assertEqual(self.request("HEAD", "/.env").status, 404)

    def test_write_methods_on_static_paths_are_405(self) -> None:
        for method in ("POST", "PUT"):
            with self.subTest(method=method):
                reply = self.request(method, "/index.html", {"a": 1})
                self.assertEqual(reply.status, 405)
        for method in ("DELETE", "PATCH", "OPTIONS"):
            with self.subTest(method=method):
                reply = self.request(method, "/index.html")
                self.assertEqual(reply.status, 405)
                self.assertEqual(reply.headers["allow"], "GET, HEAD")


class GuardTests(ServerTestCase):
    """Host, Origin and content-type rejections."""

    def test_foreign_host_is_403_on_static_and_api(self) -> None:
        for path in ("/", "/api/status", "/api/keys"):
            with self.subTest(path=path):
                reply = self.request("GET", path, headers={"Host": "evil.example.com"})
                self.assertEqual(reply.status, 403)
                self.assertIn("error", reply.json())

    def test_rebinding_lookalike_and_wrong_port_hosts_are_403(self) -> None:
        for host in (f"127.0.0.1.evil.com:{self.port}", f"localhost:{self.port + 1}", "127.0.0.1"):
            with self.subTest(host=host):
                self.assertEqual(self.request("GET", "/api/status", headers={"Host": host}).status, 403)

    def test_localhost_and_ipv6_host_names_are_accepted(self) -> None:
        for host in (f"localhost:{self.port}", f"[::1]:{self.port}", f"127.0.0.1:{self.port}"):
            with self.subTest(host=host):
                self.assertEqual(self.request("GET", "/api/status", headers={"Host": host}).status, 200)

    def test_missing_host_header_is_403(self) -> None:
        self.assertEqual(self.raw_request("GET /api/status HTTP/1.0").status, 403)

    def test_foreign_origin_write_is_403_and_changes_nothing(self) -> None:
        reply = self.request(
            "PUT", "/api/data", {"baseRevision": 0, "entries": {}}, headers={"Origin": "http://evil.example.com"}
        )
        self.assertEqual(reply.status, 403)
        self.assertFalse(self.request("GET", "/api/status").json()["exists"])

    def test_own_origin_and_missing_origin_writes_are_accepted(self) -> None:
        own = {"Origin": f"http://127.0.0.1:{self.port}"}
        self.assertEqual(self.request("PUT", "/api/data", {"baseRevision": 0, "entries": {}}, headers=own).status, 200)
        self.assertEqual(self.put_data(1, {}).status, 200)

    def test_origin_must_match_the_host_header_exactly(self) -> None:
        headers = {"Origin": f"http://localhost:{self.port}"}
        # Host says 127.0.0.1 but the Origin says localhost: not the same origin.
        reply = self.request("PUT", "/api/data", {"baseRevision": 0, "entries": {}}, headers=headers)
        self.assertEqual(reply.status, 403)

    def test_non_json_content_types_are_403(self) -> None:
        body = json.dumps({"baseRevision": 0, "entries": {}}).encode("utf-8")
        for content_type in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonx"):
            with self.subTest(content_type=content_type):
                reply = self.request("PUT", "/api/data", raw=body, headers={"Content-Type": content_type})
                self.assertEqual(reply.status, 403)
        self.assertFalse(self.request("GET", "/api/status").json()["exists"])

    def test_missing_content_type_is_403(self) -> None:
        body = b'{"baseRevision": 0, "entries": {}}'
        reply = self.raw_request(f"PUT /api/data HTTP/1.0\r\n{self.host_line()}\r\nContent-Length: {len(body)}", body)
        self.assertEqual(reply.status, 403)

    def test_json_content_type_with_charset_is_accepted(self) -> None:
        reply = self.request(
            "PUT",
            "/api/data",
            {"baseRevision": 0, "entries": {}},
            headers={"Content-Type": "application/json; charset=utf-8"},
        )
        self.assertEqual(reply.status, 200)

    def test_guard_runs_before_routing_for_writes(self) -> None:
        reply = self.request("POST", "/api/nothing", {"a": 1}, headers={"Origin": "http://evil.example.com"})
        self.assertEqual(reply.status, 403)


class ApiRoutingTests(ServerTestCase):
    """Unknown paths, wrong methods and API headers."""

    def test_unknown_api_paths_are_404(self) -> None:
        for path in ("/api", "/api/", "/api/nope", "/api/status/extra", "/api/data/"):
            with self.subTest(path=path):
                reply = self.request("GET", path)
                self.assertEqual(reply.status, 404)
                self.assertIn("error", reply.json())

    def test_wrong_methods_are_405_with_allow_header(self) -> None:
        cases = [
            ("POST", "/api/status", "GET"),
            ("DELETE", "/api/status", "GET"),
            ("HEAD", "/api/status", "GET"),
            ("DELETE", "/api/data", "GET, PUT"),
            ("POST", "/api/data", "GET, PUT"),
            ("GET", "/api/conflicts", "POST"),
            ("PUT", "/api/conflicts", "POST"),
            ("POST", "/api/keys", "GET, PUT"),
        ]
        for method, path, allow in cases:
            with self.subTest(method=method, path=path):
                reply = self.request(method, path, {} if method in ("POST", "PUT") else None)
                self.assertEqual(reply.status, 405)
                self.assertEqual(reply.headers["allow"], allow)

    def test_every_api_response_is_no_store_and_nosniff(self) -> None:
        self.put_data(0, {"vocab.a": 1})
        replies = [
            self.request("GET", "/api/status"),
            self.request("GET", "/api/data"),
            self.request("GET", "/api/keys"),
            self.put_data(1, {"vocab.a": 2}),
            self.put_data(1, {"vocab.a": 3}),  # 409
            self.put_data(2, {"bad": 3}),  # 400
            self.request("POST", "/api/conflicts", {"entries": {}, "reason": "r"}),
            self.request("PUT", "/api/keys", {"AI_API_KEY": ""}),
            self.request("GET", "/api/nope"),  # 404
            self.request("DELETE", "/api/status"),  # 405
            self.request("GET", "/api/status", headers={"Host": "evil.example.com"}),  # 403
        ]
        for reply in replies:
            with self.subTest(status=reply.status):
                self.assertEqual(reply.headers["cache-control"], "no-store")
                self.assertEqual(reply.headers["x-content-type-options"], "nosniff")
                self.assertTrue(reply.headers["content-type"].startswith("application/json"))


class StatusAndDataTests(ServerTestCase):
    """GET /api/status, GET and PUT /api/data, the 409 flow and POST /api/conflicts."""

    def test_status_of_a_fresh_install(self) -> None:
        reply = self.request("GET", "/api/status")
        self.assertEqual(reply.status, 200)
        self.assertEqual(
            reply.json(),
            {
                "app": "language-learning",
                "version": "9.9.9",
                "mode": "file",
                "dataFile": "data/language-data.json",
                "exists": False,
                "revision": 0,
                "savedAt": None,
                "hasAiKey": False,
            },
        )

    def test_get_data_is_404_before_the_first_save(self) -> None:
        reply = self.request("GET", "/api/data")
        self.assertEqual(reply.status, 404)
        self.assertIn("error", reply.json())

    def test_first_save_then_read_back(self) -> None:
        entries = {"vocab.subjects": [{"name": "Příliš žluťoučký kůň"}], "vocab.v2-x": {"$raw": "plain"}}
        saved = self.put_data(0, entries)
        self.assertEqual(saved.status, 200)
        self.assertEqual(saved.json()["revision"], 1)
        self.assertRegex(saved.json()["savedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        stored = self.request("GET", "/api/data").json()
        self.assertEqual(stored["app"], "language-learning")
        self.assertEqual(stored["format"], 1)
        self.assertEqual(stored["revision"], 1)
        self.assertEqual(stored["entries"], entries)
        status = self.request("GET", "/api/status").json()
        self.assertEqual((status["exists"], status["revision"]), (True, 1))
        self.assertEqual(status["savedAt"], saved.json()["savedAt"])
        self.assertTrue((self.data_dir / "language-data.json").is_file())

    def test_revision_increases_on_every_save(self) -> None:
        self.assertEqual(self.put_data(0, {}).json()["revision"], 1)
        self.assertEqual(self.put_data(1, {"vocab.a": 1}).json()["revision"], 2)
        self.assertEqual(self.put_data(2, {"vocab.a": 2}).json()["revision"], 3)

    def test_large_body_is_read_completely(self) -> None:
        big = "ž" * (2 * 1024 * 1024)
        self.assertEqual(self.put_data(0, {"vocab.big": big}).status, 200)
        self.assertEqual(self.request("GET", "/api/data").json()["entries"]["vocab.big"], big)

    def test_stale_revision_is_409_with_the_current_revision(self) -> None:
        self.put_data(0, {"vocab.a": 1})
        reply = self.put_data(0, {"vocab.a": 2})
        self.assertEqual(reply.status, 409)
        self.assertEqual(reply.json()["revision"], 1)
        self.assertIn("error", reply.json())
        self.assertEqual(self.request("GET", "/api/data").json()["entries"], {"vocab.a": 1})

    def test_conflict_flow_keeps_the_losing_side_and_recovers(self) -> None:
        self.put_data(0, {"vocab.a": "remote"})
        lost = {"vocab.a": "local"}
        self.assertEqual(self.put_data(0, lost).status, 409)
        kept = self.request("POST", "/api/conflicts", {"entries": lost, "reason": "stale tab"})
        self.assertEqual(kept.status, 201)
        name = kept.json()["file"]
        self.assertRegex(name, r"^data/conflicts/conflict-\d{8}T\d{6}Z(-\d+)?\.json$")
        written = json.loads((self.data_dir / "conflicts" / Path(name).name).read_text(encoding="utf-8"))
        self.assertEqual(written["entries"], lost)
        self.assertEqual(written["reason"], "stale tab")
        fresh = self.request("GET", "/api/data").json()
        self.assertEqual(self.put_data(fresh["revision"], {"vocab.a": "merged"}).json()["revision"], 2)

    def test_invalid_put_payloads_are_400(self) -> None:
        bad_payloads: list[Any] = [
            {"entries": {}},
            {"baseRevision": "0", "entries": {}},
            {"baseRevision": True, "entries": {}},
            {"baseRevision": -1, "entries": {}},
            {"baseRevision": 0},
            {"baseRevision": 0, "entries": []},
            {"baseRevision": 0, "entries": {"other.key": 1}},
            {"baseRevision": 0, "entries": {"vocab.cfg": {"key": "sk-leak", "url": "https://openrouter.ai"}}},
            [1, 2],
            "text",
        ]
        for payload in bad_payloads:
            with self.subTest(payload=payload):
                reply = self.request("PUT", "/api/data", payload)
                self.assertEqual(reply.status, 400)
                self.assertIn("error", reply.json())
        self.assertFalse(self.request("GET", "/api/status").json()["exists"])

    def test_invalid_json_bodies_are_400(self) -> None:
        for raw in (b"", b"{not json", b'{"baseRevision": 0,', b"\xff\xfe\xfa", b"[" * 100000):
            with self.subTest(raw=raw[:12]):
                self.assertEqual(self.request("PUT", "/api/data", raw=raw).status, 400)

    def test_missing_content_length_is_411(self) -> None:
        head = f"PUT /api/data HTTP/1.0\r\n{self.host_line()}\r\nContent-Type: application/json"
        self.assertEqual(self.raw_request(head, b'{"baseRevision": 0, "entries": {}}').status, 411)

    def test_malformed_content_length_is_400(self) -> None:
        for value in ("abc", "-5", "1.5", "²"):
            with self.subTest(value=value):
                head = (
                    f"PUT /api/data HTTP/1.0\r\n{self.host_line()}\r\n"
                    f"Content-Type: application/json\r\nContent-Length: {value}"
                )
                self.assertEqual(self.raw_request(head).status, 400)

    def test_body_over_the_limit_is_413_without_reading_it(self) -> None:
        head = (
            f"PUT /api/data HTTP/1.0\r\n{self.host_line()}\r\n"
            f"Content-Type: application/json\r\nContent-Length: {MAX_BODY_BYTES + 1}"
        )
        reply = self.raw_request(head)
        self.assertEqual(reply.status, 413)
        self.assertIn("error", reply.json())

    def test_body_shorter_than_content_length_is_400(self) -> None:
        head = f"PUT /api/data HTTP/1.0\r\n{self.host_line()}\r\nContent-Type: application/json\r\nContent-Length: 50"
        self.assertEqual(self.raw_request(head, b'{"a":').status, 400)

    def test_extra_bytes_after_content_length_are_not_read(self) -> None:
        body = b'{"baseRevision": 0, "entries": {}}'
        head = f"PUT /api/data HTTP/1.0\r\n{self.host_line()}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}"
        self.assertEqual(self.raw_request(head, body + b"garbage").status, 200)

    def test_conflict_payload_errors_are_400(self) -> None:
        bad_payloads: list[Any] = [
            {"entries": {}},
            {"entries": {}, "reason": 5},
            {"reason": "x"},
            {"entries": {"nope": 1}, "reason": "x"},
            {"entries": [], "reason": "x"},
            [],
        ]
        for payload in bad_payloads:
            with self.subTest(payload=payload):
                self.assertEqual(self.request("POST", "/api/conflicts", payload).status, 400)
        self.assertFalse((self.data_dir / "conflicts").exists())


class DamagedFileTests(ServerTestCase):
    """A corrupt stored data file is a server problem (500), not a bad request."""

    def setUp(self) -> None:
        """Start the server and write a broken data file."""
        super().setUp()
        self.data_dir.mkdir(parents=True)
        (self.data_dir / "language-data.json").write_text("{ this is not json", encoding="utf-8")

    def test_status_data_and_put_report_500_with_a_message(self) -> None:
        replies = [
            self.request("GET", "/api/status"),
            self.request("GET", "/api/data"),
            self.put_data(0, {"vocab.a": 1}),
        ]
        for reply in replies:
            with self.subTest(status=reply.status):
                self.assertEqual(reply.status, 500)
                self.assertIn("language-data.json", reply.json()["error"])
                self.assertIn("then restart", reply.json()["error"])

    def test_the_damaged_file_is_left_untouched(self) -> None:
        self.put_data(0, {"vocab.a": 1})
        self.assertEqual((self.data_dir / "language-data.json").read_text(encoding="utf-8"), "{ this is not json")


class KeysTests(ServerTestCase):
    """GET and PUT /api/keys and the .env file behind them."""

    def test_keys_are_empty_by_default(self) -> None:
        reply = self.request("GET", "/api/keys")
        self.assertEqual((reply.status, reply.json()), (200, {"AI_API_KEY": ""}))

    def test_save_read_and_remove_a_key(self) -> None:
        saved = self.request("PUT", "/api/keys", {"AI_API_KEY": TEST_KEY})
        self.assertEqual((saved.status, saved.json()), (200, {"hasAiKey": True}))
        self.assertEqual(self.request("GET", "/api/keys").json(), {"AI_API_KEY": TEST_KEY})
        self.assertTrue(self.request("GET", "/api/status").json()["hasAiKey"])
        self.assertEqual(stat.S_IMODE(self.env_path.stat().st_mode), 0o600)
        removed = self.request("PUT", "/api/keys", {"AI_API_KEY": ""})
        self.assertEqual(removed.json(), {"hasAiKey": False})
        self.assertEqual(self.request("GET", "/api/keys").json(), {"AI_API_KEY": ""})

    def test_status_never_contains_the_key(self) -> None:
        self.request("PUT", "/api/keys", {"AI_API_KEY": TEST_KEY})
        self.assertNotIn(TEST_KEY.encode(), self.request("GET", "/api/status").body)

    def test_key_does_not_reach_the_data_file(self) -> None:
        self.request("PUT", "/api/keys", {"AI_API_KEY": TEST_KEY})
        self.put_data(0, {"vocab.a": 1})
        self.assertNotIn(TEST_KEY, (self.data_dir / "language-data.json").read_text(encoding="utf-8"))

    def test_bad_key_requests_are_400_and_change_nothing(self) -> None:
        bad_payloads: list[Any] = [
            {"OTHER_KEY": "x"},
            {"AI_API_KEY": 5},
            {"AI_API_KEY": "line\nbreak"},
            {"AI_API_KEY": "x" * 401},
            {"AI_API_KEY": TEST_KEY, "OTHER_KEY": "x"},
            ["AI_API_KEY"],
        ]
        for payload in bad_payloads:
            with self.subTest(payload=str(payload)[:40]):
                self.assertEqual(self.request("PUT", "/api/keys", payload).status, 400)
        self.assertEqual(self.request("GET", "/api/keys").json(), {"AI_API_KEY": ""})

    def test_keys_and_bodies_are_never_logged(self) -> None:
        with self.assertLogs(LOGGER_NAME, level=logging.DEBUG) as captured:
            self.request("PUT", "/api/keys", {"AI_API_KEY": TEST_KEY})
            self.request("GET", "/api/keys")
            self.put_data(0, {"vocab.secret-note": "body-marker-text"})
        output = "\n".join(captured.output)
        self.assertNotIn(TEST_KEY, output)
        self.assertNotIn("body-marker-text", output)
        self.assertIn("PUT /api/keys", output)


class CreateServerTests(unittest.TestCase):
    """create_server defaults, and read_version."""

    def test_defaults_put_data_and_env_under_the_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            httpd = create_server(root, port=0)
            thread = threading.Thread(target=httpd.serve_forever, args=(POLL_INTERVAL,), daemon=True)
            thread.start()
            try:
                port = httpd.server_address[1]
                self.assertGreater(port, 0)
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=SOCKET_TIMEOUT)
                body = json.dumps({"baseRevision": 0, "entries": {"vocab.a": 1}})
                connection.request("PUT", "/api/data", body=body, headers={"Content-Type": JSON_TYPE})
                self.assertEqual(connection.getresponse().status, 200)
                connection.close()
                self.assertTrue((root / "data" / "language-data.json").is_file())
            finally:
                httpd.shutdown()
                thread.join()
                httpd.server_close()

    def test_read_version_reads_the_assignment(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "version.js").write_text('self.APP_VERSION = "2.0.0";\n', encoding="utf-8")
            self.assertEqual(read_version(root), "2.0.0")

    def test_read_version_falls_back_to_dev(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.assertEqual(read_version(root), "dev")
            (root / "version.js").write_text("// no version here\n", encoding="utf-8")
            self.assertEqual(read_version(root), "dev")


class ServeScriptTests(unittest.TestCase):
    """serve.py: loopback rule and option parsing."""

    def test_loopback_hosts(self) -> None:
        for host in ("127.0.0.1", "::1", "localhost", "LOCALHOST"):
            with self.subTest(host=host):
                self.assertTrue(serve.is_loopback_host(host))

    def test_non_loopback_hosts(self) -> None:
        """Wider binds and loopback addresses the Host check would refuse (127.0.0.2) are rejected."""
        for host in ("0.0.0.0", "192.168.1.5", "::", "", "example.com", "127.0.0.1.evil.com", "127.0.0.2"):
            with self.subTest(host=host):
                self.assertFalse(serve.is_loopback_host(host))

    def test_non_loopback_host_is_refused_with_a_clear_message(self) -> None:
        """--host 0.0.0.0 exits with code 2 and names the loopback addresses to use."""
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors), self.assertRaises(SystemExit) as raised:
            serve.main(["--host", "0.0.0.0", "--port", "0"])
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("is not allowed; the language app is local-only", errors.getvalue())
        self.assertIn("127.0.0.1", errors.getvalue())

    def test_allow_remote_option_no_longer_exists(self) -> None:
        """--allow-remote is an unknown option, so no flag can widen the bind."""
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors), self.assertRaises(SystemExit) as raised:
            serve.main(["--host", "0.0.0.0", "--allow-remote", "--port", "0"])
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("--allow-remote", errors.getvalue())

    def test_bad_port_is_refused(self) -> None:
        for value in ("abc", "-1", "70000"):
            with self.subTest(value=value):
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                    serve.main(["--port", value])
                self.assertEqual(raised.exception.code, 2)

    def test_defaults(self) -> None:
        options = serve.build_parser().parse_args([])
        self.assertEqual((options.port, options.host), (8768, "127.0.0.1"))
        self.assertFalse(options.open)
        self.assertFalse(options.verbose)

    def test_url_brackets_ipv6(self) -> None:
        self.assertEqual(serve._url_for("127.0.0.1", 8768), "http://127.0.0.1:8768/")
        self.assertEqual(serve._url_for("::1", 8768), "http://[::1]:8768/")

    def test_busy_port_exits_with_a_one_line_error(self) -> None:
        with socket.socket() as blocker:
            blocker.bind(("127.0.0.1", 0))
            blocker.listen()
            port = blocker.getsockname()[1]
            errors = io.StringIO()
            with contextlib.redirect_stderr(errors):
                self.assertEqual(serve.main(["--port", str(port)]), serve.EXIT_FAILURE)
            self.assertEqual(len(errors.getvalue().strip().splitlines()), 1)
            self.assertIn(f"Port {port} is in use", errors.getvalue())
            self.assertIn(f"--port {port + 1}", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
