"""Integration tests for the server side of the acceptance criteria AC4, AC5, AC6 and AC8.

Where it fits: tests/test_app.py checks the server on a toy project root; this file starts the real
`create_server` on the REAL project tree (so the allowlist is checked against the files that actually
exist) with the data folder and the .env path in a temp directory, and drives it over loopback HTTP.
It also checks, as plain text, that the service workers bypass /api/ and that every page loads the sync
script (AC8 and AC4). The browser side of the same criteria is tests/js/integration.test.mjs.

Invariant: the real project's data/ and .env are never touched; only the temp paths are written.
"""

from __future__ import annotations

import http.client
import json
import stat
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any

from server.app import create_server

PROJECT_ROOT = Path(__file__).resolve().parent.parent
JSON_TYPE = "application/json"
SOCKET_TIMEOUT = 5
# Shutdown latency of serve_forever; the default 0.5 s would add seconds to every test.
POLL_INTERVAL = 0.01
TYPED_KEY = "sk-integration-0123456789"
CZECH_TEXT = "Příliš žluťoučký kůň úpěl ďábelské ódy"
AI_SETTINGS_WITH_KEY = {"ai": {"url": "https://openrouter.ai/api/v1", "model": "m", "key": TYPED_KEY}}
SYNC_SCRIPT = "js/sync/page.js"
PAGES_WITH_SYNC = ("index.html",)
# js/data.js promptUrl() fetches <prompt folder><name>.md for these names, per learner language.
PROMPT_NAMES = ("check-answer", "check-write", "free-chat", "make-topic")
PROMPT_FOLDERS = ("prompts", "en/prompts")
# The word manifests of the two learner languages (Czech at the root, English in en/).
MANIFESTS = ("words.json", "en/words.json")
SERVICE_WORKERS = ("sw.js",)
# Paths that exist in the project (or would be natural to guess) and must never be served.
HIDDEN_PATHS = (
    "/.env",
    "/data/language-data.json",
    "/serve.py",
    "/README.md",
    "/tools/test.sh",
    "/tools/conjugate.py",
    "/tools/check_course.py",
    "/launcher.py",
    "/requirements.txt",
    "/LICENSE",
    "/.git/config",
    "/server/app.py",
    "/tests/test_integration.py",
)


class Reply:
    """Status, lower-cased headers and body of one HTTP response."""

    def __init__(self, status: int, headers: dict[str, str], body: bytes) -> None:
        """Store the parts of the response."""
        self.status = status
        self.headers = headers
        self.body = body

    def json(self) -> Any:
        """Return the body parsed as JSON."""
        return json.loads(self.body.decode("utf-8"))


class RealTreeServerCase(unittest.TestCase):
    """Base class: the real project served with a temp data folder and a temp .env."""

    def setUp(self) -> None:
        """Start the server in a thread and remember where its files live."""
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.data_dir = Path(temp.name) / "data"
        self.env_path = Path(temp.name) / ".env"
        self.httpd = create_server(PROJECT_ROOT, port=0, data_dir=self.data_dir, env_path=self.env_path)
        self.port = self.httpd.server_address[1]
        thread = threading.Thread(target=self.httpd.serve_forever, args=(POLL_INTERVAL,), daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        headers: dict[str, str] | None = None,
    ) -> Reply:
        """Send one request.

        Args:
            method: HTTP method.
            path: Request target.
            body: Value sent as JSON (with a JSON content type) when not None.
            headers: Extra headers; they override the defaults, Host included.

        Returns:
            The response.
        """
        sent = dict(headers or {})
        payload = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            sent.setdefault("Content-Type", JSON_TYPE)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=SOCKET_TIMEOUT)
        try:
            connection.request(method, path, body=payload, headers=sent)
            reply = connection.getresponse()
            return Reply(reply.status, {k.lower(): v for k, v in reply.getheaders()}, reply.read())
        finally:
            connection.close()

    def put_data(self, base_revision: int, entries: dict[str, Any]) -> Reply:
        """PUT /api/data with the given base revision and entries."""
        return self.request("PUT", "/api/data", {"baseRevision": base_revision, "entries": entries})

    @property
    def data_path(self) -> Path:
        """Where the data file must appear."""
        return self.data_dir / "language-data.json"


class DataRoundTripTest(RealTreeServerCase):
    """AC4: data written through the API is read back and stored in a readable, stable file."""

    def test_put_then_get_returns_the_same_entries(self) -> None:
        """What the page saves is what another machine restores."""
        entries = {"vocab.a1.notes": [{"title": CZECH_TEXT}], "vocab.v2-plain": {"$raw": "text"}}
        saved = self.put_data(0, entries)
        self.assertEqual(saved.status, 200)
        self.assertEqual(saved.json()["revision"], 1)
        fetched = self.request("GET", "/api/data")
        self.assertEqual(fetched.status, 200)
        self.assertEqual(fetched.json()["entries"], entries)
        self.assertEqual(fetched.json()["revision"], 1)

    def test_file_is_pretty_printed_with_sorted_keys_and_keeps_czech_text(self) -> None:
        """Git diffs stay line based: indent 1, sorted keys, real UTF-8 instead of \\u escapes."""
        self.put_data(0, {"vocab.b": 1, "vocab.a": {"z": CZECH_TEXT, "y": 2}})
        text = self.data_path.read_text(encoding="utf-8")
        self.assertIn(CZECH_TEXT, text)
        self.assertNotIn("\\u", text)
        self.assertTrue(text.endswith("}\n"))
        self.assertEqual(text, json.dumps(json.loads(text), indent=1, sort_keys=True, ensure_ascii=False) + "\n")
        self.assertLess(text.index('"vocab.a"'), text.index('"vocab.b"'))

    def test_second_save_with_current_revision_bumps_it(self) -> None:
        """Each accepted save moves the revision up by one."""
        self.put_data(0, {"vocab.a": 1})
        second = self.put_data(1, {"vocab.a": 2})
        self.assertEqual(second.json()["revision"], 2)
        self.assertEqual(self.request("GET", "/api/status").json()["revision"], 2)

    def test_get_data_is_404_before_the_first_save(self) -> None:
        """A fresh machine finds no data file yet."""
        self.assertEqual(self.request("GET", "/api/data").status, 404)


class KeysTest(RealTreeServerCase):
    """AC5: AI keys live in .env and never in the data file."""

    def test_entries_that_still_hold_a_key_are_rejected(self) -> None:
        """A page that forgot to redact cannot leak the key into git."""
        reply = self.put_data(0, {"vocab.a1.settings": AI_SETTINGS_WITH_KEY})
        self.assertEqual(reply.status, 400)
        self.assertFalse(self.data_path.exists())

    def test_key_is_written_to_env_with_mode_0600_and_read_back(self) -> None:
        """PUT /api/keys creates a private .env that GET /api/keys returns."""
        reply = self.request("PUT", "/api/keys", {"AI_API_KEY": TYPED_KEY})
        self.assertEqual(reply.status, 200)
        self.assertEqual(reply.json(), {"hasAiKey": True})
        self.assertIn(TYPED_KEY, self.env_path.read_text(encoding="utf-8"))
        self.assertEqual(stat.S_IMODE(self.env_path.stat().st_mode), 0o600)
        self.assertEqual(self.request("GET", "/api/keys").json(), {"AI_API_KEY": TYPED_KEY})
        self.assertTrue(self.request("GET", "/api/status").json()["hasAiKey"])

    def test_empty_value_removes_the_key(self) -> None:
        """"Forget key" ends with an empty value, which deletes the line."""
        self.request("PUT", "/api/keys", {"AI_API_KEY": TYPED_KEY})
        reply = self.request("PUT", "/api/keys", {"AI_API_KEY": ""})
        self.assertEqual(reply.json(), {"hasAiKey": False})
        self.assertEqual(self.request("GET", "/api/keys").json(), {"AI_API_KEY": ""})
        self.assertNotIn(TYPED_KEY, self.env_path.read_text(encoding="utf-8"))

    def test_data_file_never_contains_the_key(self) -> None:
        """After a key is saved and data is stored, the key appears only in .env."""
        self.request("PUT", "/api/keys", {"AI_API_KEY": TYPED_KEY})
        self.put_data(0, {"vocab.a1.settings": {"ai": {**AI_SETTINGS_WITH_KEY["ai"], "key": ""}}})
        self.assertNotIn(TYPED_KEY, self.data_path.read_text(encoding="utf-8"))
        self.assertNotIn(TYPED_KEY, self.request("GET", "/api/data").body.decode("utf-8"))

    def test_unknown_key_name_is_rejected(self) -> None:
        """Only allowlisted names can be written to .env."""
        self.assertEqual(self.request("PUT", "/api/keys", {"PATH": "/bin"}).status, 400)


class ConflictTest(RealTreeServerCase):
    """AC6: a stale writer is refused and its data is kept in data/conflicts/."""

    def test_stale_base_revision_is_409_and_keeps_the_newer_data(self) -> None:
        """The loser gets the current revision and the file is untouched."""
        self.put_data(0, {"vocab.a": "first"})
        self.put_data(1, {"vocab.a": "second"})
        stale = self.put_data(1, {"vocab.a": "stale"})
        self.assertEqual(stale.status, 409)
        self.assertEqual(stale.json()["revision"], 2)
        self.assertEqual(self.request("GET", "/api/data").json()["entries"], {"vocab.a": "second"})

    def test_conflict_copy_is_written_under_data_conflicts(self) -> None:
        """POST /api/conflicts stores the losing entries as a separate file."""
        reply = self.request("POST", "/api/conflicts", {"entries": {"vocab.a": CZECH_TEXT}, "reason": "stale"})
        self.assertEqual(reply.status, 201)
        name = reply.json()["file"]
        self.assertTrue(name.startswith("data/conflicts/conflict-"), name)
        stored = json.loads((self.data_dir / "conflicts" / Path(name).name).read_text(encoding="utf-8"))
        self.assertEqual(stored["entries"], {"vocab.a": CZECH_TEXT})
        self.assertEqual(stored["reason"], "stale")

    def test_conflict_copy_does_not_change_the_revision(self) -> None:
        """A conflict copy is a side file, not a save."""
        self.put_data(0, {"vocab.a": 1})
        self.request("POST", "/api/conflicts", {"entries": {"vocab.a": 2}, "reason": "r"})
        self.assertEqual(self.request("GET", "/api/status").json()["revision"], 1)


class SecurityOnRealTreeTest(RealTreeServerCase):
    """AC8: the allowlist, Host and Origin checks and headers, against the real project files."""

    def test_index_html_is_served_with_security_headers(self) -> None:
        """The home page loads, with a CSP and nosniff."""
        for path in ("/", "/index.html"):
            reply = self.request("GET", path)
            self.assertEqual(reply.status, 200, path)
            self.assertIn("default-src 'self'", reply.headers["content-security-policy"])
            self.assertEqual(reply.headers["x-content-type-options"], "nosniff")

    def test_app_scripts_and_both_apps_are_served(self) -> None:
        """The allowlist keeps everything the browser needs."""
        for path in ("/js/sync/page.js", "/js/app.js", "/sw.js", "/words.json", "/en/words.json", "/conjugations/fr.json"):
            self.assertEqual(self.request("GET", path).status, 200, path)

    def test_secrets_sources_and_tools_are_not_served(self) -> None:
        """Dotfiles, data, source and docs files are 404 even though they exist on disk."""
        for path in HIDDEN_PATHS:
            self.assertEqual(self.request("GET", path).status, 404, path)

    def test_encoded_and_dotted_paths_do_not_escape(self) -> None:
        """Percent-encoded traversal and a hidden segment stay 404."""
        for path in ("/%2e%2e/serve.py", "/js/../serve.py", "/js/%2e%2e/.env", "/%2eenv"):
            self.assertEqual(self.request("GET", path).status, 404, path)

    def test_foreign_host_is_403_for_pages_and_api(self) -> None:
        """DNS rebinding: a page reached through another name is refused."""
        for path in ("/", "/api/status", "/api/keys"):
            reply = self.request("GET", path, headers={"Host": "evil.example"})
            self.assertEqual(reply.status, 403, path)

    def test_cross_origin_write_is_403_and_changes_nothing(self) -> None:
        """A write with a foreign Origin never reaches the store."""
        reply = self.request(
            "PUT", "/api/data", {"baseRevision": 0, "entries": {}}, headers={"Origin": "http://evil.example"}
        )
        self.assertEqual(reply.status, 403)
        reply = self.request("PUT", "/api/keys", {"AI_API_KEY": "x"}, headers={"Origin": "http://evil.example"})
        self.assertEqual(reply.status, 403)
        self.assertFalse(self.data_path.exists())
        self.assertFalse(self.env_path.exists())

    def test_same_origin_write_is_accepted(self) -> None:
        """The page's own Origin passes the check."""
        origin = f"http://127.0.0.1:{self.port}"
        reply = self.request("PUT", "/api/data", {"baseRevision": 0, "entries": {}}, headers={"Origin": origin})
        self.assertEqual(reply.status, 200)

    def test_non_json_write_is_refused(self) -> None:
        """A form post cannot write data."""
        reply = self.request(
            "PUT", "/api/data", None, headers={"Content-Type": "text/plain", "Content-Length": "2"}
        )
        self.assertEqual(reply.status, 403)

    def test_api_responses_are_not_cacheable(self) -> None:
        """Every API answer, success or error, says no-store."""
        for method, path in (("GET", "/api/status"), ("GET", "/api/data"), ("GET", "/api/keys"), ("GET", "/api/nope")):
            reply = self.request(method, path)
            self.assertEqual(reply.headers["cache-control"], "no-store", path)
            self.assertEqual(reply.headers["x-content-type-options"], "nosniff", path)


def referenced_json_paths(value: Any) -> set[str]:
    """Collect every string ending in ".json" inside a parsed words.json (the paths the app fetches)."""
    if isinstance(value, str):
        return {value} if value.endswith(".json") else set()
    children = value.values() if isinstance(value, dict) else value if isinstance(value, list) else []
    return set().union(*(referenced_json_paths(child) for child in children))


class AppFilesTest(RealTreeServerCase):
    """The allowlist must not break the app: every file it fetches by path is served, its docs are not."""

    def test_prompt_templates_are_served(self) -> None:
        """ai.js fetches the prompts as Markdown; a 404 would silently disable the AI features."""
        for folder in PROMPT_FOLDERS:
            for name in PROMPT_NAMES:
                path = f"/{folder}/{name}.md"
                self.assertTrue((PROJECT_ROOT / path.lstrip("/")).is_file(), path)
                reply = self.request("GET", path)
                self.assertEqual(reply.status, 200, path)
                self.assertEqual(reply.body, (PROJECT_ROOT / path.lstrip("/")).read_bytes(), path)

    def test_every_json_file_listed_in_the_manifests_is_served(self) -> None:
        """Decks, courses, drills and conjugations named by both manifests load under serve.py."""
        for manifest in MANIFESTS:
            index = json.loads((PROJECT_ROOT / manifest).read_text(encoding="utf-8"))
            paths = referenced_json_paths(index)
            self.assertGreater(len(paths), 10, manifest)
            for relative in sorted(paths | {manifest}):
                reply = self.request("GET", f"/{relative}")
                self.assertEqual(reply.status, 200, f"{manifest}: {relative}")
                json.loads(reply.body.decode("utf-8"))

    def test_every_course_file_is_served(self) -> None:
        """Course parts are fetched relative to their index, so each file in courses/ must open."""
        files = sorted((PROJECT_ROOT / "courses").rglob("*.json")) + sorted((PROJECT_ROOT / "en" / "courses").rglob("*.json"))
        self.assertGreater(len(files), 5)
        for file in files:
            path = "/" + file.relative_to(PROJECT_ROOT).as_posix()
            self.assertEqual(self.request("GET", path).status, 200, path)

    def test_readme_stays_hidden(self) -> None:
        """Only the prompts open; README.md is 404."""
        self.assertEqual(self.request("GET", "/README.md").status, 404)


class StaticFilesTest(unittest.TestCase):
    """Static checks on the real files: service workers and pages (AC8, AC4)."""

    def test_service_workers_bypass_the_api(self) -> None:
        """No worker may cache /api/, or a stale revision would be served from the cache."""
        for name in SERVICE_WORKERS:
            text = (PROJECT_ROOT / name).read_text(encoding="utf-8")
            # The worker computes the api/ path from its own location and returns early for it.
            self.assertRegex(text, r"new URL\('(\./|\.\./\.\./)api/', self\.location\)", name)
            self.assertRegex(text, r"startsWith\((API_PATH|apiPath)\)", name)

    def test_every_page_loads_the_sync_script(self) -> None:
        """Without the script tag a page's data would never reach the data file."""
        for name in PAGES_WITH_SYNC:
            text = (PROJECT_ROOT / name).read_text(encoding="utf-8")
            self.assertIn(SYNC_SCRIPT, text, name)
            self.assertIn('type="module"', text, name)


if __name__ == "__main__":
    unittest.main()
