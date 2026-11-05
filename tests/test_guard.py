"""Unit tests for server/guard.py: host, origin, content-type and static path rules.

The static tests build a throw-away project root in a temp folder (including
symlinks that point outside it) so the allowlist and the containment check are
exercised against a real file system. No network, no shared state.
"""

from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path

from server.guard import (
    is_allowed_host,
    is_allowed_origin,
    is_json_request,
    resolve_static,
)

PORT = 8768


class HostTests(unittest.TestCase):
    """is_allowed_host accepts only loopback names with the exact port."""

    def test_accepts_loopback_names_with_port(self) -> None:
        for host in ("127.0.0.1:8768", "localhost:8768", "[::1]:8768", "LocalHost:8768"):
            with self.subTest(host=host):
                self.assertTrue(is_allowed_host(host, PORT))

    def test_rejects_lookalike_and_foreign_hosts(self) -> None:
        for host in (
            "127.0.0.1.evil.com:8768",
            "evil.com",
            "evil.com:8768",
            "localhost.evil.com:8768",
            "evil.com:8768@localhost:8768",
            "localhost:8768.evil.com",
            "0.0.0.0:8768",
            "127.0.0.2:8768",
            " localhost:8768",
            "localhost:8768 ",
            "localhost:8768,evil.com",
        ):
            with self.subTest(host=host):
                self.assertFalse(is_allowed_host(host, PORT))

    def test_rejects_wrong_or_missing_port(self) -> None:
        for host in ("127.0.0.1", "localhost", "localhost:8767", "localhost:80", "localhost:"):
            with self.subTest(host=host):
                self.assertFalse(is_allowed_host(host, PORT))

    def test_rejects_missing_header(self) -> None:
        self.assertFalse(is_allowed_host(None, PORT))
        self.assertFalse(is_allowed_host("", PORT))

    def test_port_follows_the_argument(self) -> None:
        self.assertTrue(is_allowed_host("localhost:51234", 51234))
        self.assertFalse(is_allowed_host("localhost:8768", 51234))


class OriginTests(unittest.TestCase):
    """is_allowed_origin lets through a missing Origin or the server's own."""

    def test_missing_origin_is_allowed(self) -> None:
        self.assertTrue(is_allowed_origin(None, "localhost:8768"))
        self.assertTrue(is_allowed_origin("", "localhost:8768"))

    def test_same_origin_is_allowed(self) -> None:
        self.assertTrue(is_allowed_origin("http://127.0.0.1:8768", "127.0.0.1:8768"))

    def test_foreign_origins_are_rejected(self) -> None:
        for origin in (
            "http://evil.com",
            "https://127.0.0.1:8768",
            "http://localhost:8768",
            "http://127.0.0.1:8768.evil.com",
            "http://127.0.0.1:8768/",
            "null",
        ):
            with self.subTest(origin=origin):
                self.assertFalse(is_allowed_origin(origin, "127.0.0.1:8768"))


class JsonRequestTests(unittest.TestCase):
    """is_json_request accepts only the application/json media type."""

    def test_accepts_json_with_and_without_parameters(self) -> None:
        for value in ("application/json", "application/json; charset=utf-8", "Application/JSON"):
            with self.subTest(value=value):
                self.assertTrue(is_json_request(value))

    def test_rejects_other_types_and_missing_header(self) -> None:
        for value in (
            None,
            "",
            "text/plain",
            "application/x-www-form-urlencoded",
            "multipart/form-data; boundary=x",
            "text/plain; application/json",
            "application/jsonp",
        ):
            with self.subTest(value=value):
                self.assertFalse(is_json_request(value))


class ResolveStaticTests(unittest.TestCase):
    """resolve_static serves only allowlisted files that really live in the root."""

    def setUp(self) -> None:
        """Build a project root with allowed, denied and symlinked files."""
        self.base = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.base, ignore_errors=True)
        self.root = self.base / "project"
        self.outside = self.base / "outside"
        files = {
            "index.html": "<html>",
            "manifest.json": "{}",
            "version.js": "x",
            "sw.js": "x",
            "README.md": "docs",
            "serve.py": "py",
            ".env": "AI_API_KEY=secret",
            "css/app.css": "a{}",
            "js/app.js": "x",
            "js/views/chem.js": "x",
            "js/příliš žluťoučký.js": "x",
            "js/notes.md": "x",
            "prompts/free-chat.md": "prompt",
            "prompts/Upper.MD": "x",
            "prompts/sub/deep.md": "x",
            "prompts/notes.py": "x",
            "en/prompts/check-write.md": "prompt",
            "en/README.md": "docs",
            "en/words.json": "{}",
            "en/courses/fr/course.json": "{}",
            "courses/fr/course.json": "{}",
            "words/fr/basics.json": "[]",
            "conjugations/fr.json": "{}",
            "words.json": "{}",
            "js/prompts/leak.md": "x",
            "css/prompts/leak.md": "x",
            "words/prompts/leak.md": "x",
            "js/secret.py": "x",
            "js/no_extension": "x",
            "js/.hidden.js": "x",
            "js/.git/config.js": "x",
            "js/data/x.js": "x",
            "js/Server/x.js": "x",
            "icons/icon.png": "x",
            "data/language-data.json": "{}",
            "server/app.py": "py",
            "tools/make-public.sh": "sh",
            "tests/test_x.js": "x",
            "docs/ARCHITECTURE.md": "x",
            "venv/lib/x.js": "x",
            "outside/secret.js": "stolen",
            "outside/secret.txt": "stolen",
        }
        for relative, text in files.items():
            target = (self.root / relative) if not relative.startswith("outside/") else self.base / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        # Symlinks: out of the root (file and folder), into a denied folder, a loop,
        # and a harmless one that stays inside an allowed folder.
        (self.root / "js" / "leak.js").symlink_to(self.outside / "secret.js")
        (self.root / "js" / "leakdir").symlink_to(self.outside, target_is_directory=True)
        (self.root / "js" / "intodata.json").symlink_to(self.root / "data" / "language-data.json")
        (self.root / "js" / "loop.js").symlink_to(self.root / "js" / "loop.js")
        (self.root / "js" / "alias.js").symlink_to(self.root / "js" / "app.js")

    def assertServes(self, url_path: str, relative: str) -> None:
        """Assert url_path resolves to the file at `relative` below the root."""
        self.assertEqual(resolve_static(self.root, url_path), self.root / relative, url_path)

    def assertDenied(self, url_path: str) -> None:
        """Assert url_path is refused."""
        self.assertIsNone(resolve_static(self.root, url_path), url_path)

    def test_root_serves_index(self) -> None:
        self.assertServes("/", "index.html")

    def test_serves_allowed_root_files(self) -> None:
        for name in ("index.html", "manifest.json", "version.js", "sw.js", "words.json"):
            with self.subTest(name=name):
                self.assertServes(f"/{name}", name)

    def test_serves_allowed_nested_files(self) -> None:
        for relative in (
            "css/app.css",
            "js/app.js",
            "js/views/chem.js",
            "icons/icon.png",
            "en/words.json",
            "en/courses/fr/course.json",
            "courses/fr/course.json",
            "words/fr/basics.json",
            "conjugations/fr.json",
        ):
            with self.subTest(relative=relative):
                self.assertServes(f"/{relative}", relative)

    def test_serves_markdown_prompt_templates(self) -> None:
        """The app fetches ./prompts/<name>.md (Czech) and ./en/prompts/<name>.md (English)."""
        for relative in (
            "prompts/free-chat.md",
            "en/prompts/check-write.md",
        ):
            with self.subTest(relative=relative):
                self.assertServes(f"/{relative}", relative)

    def test_other_markdown_stays_hidden(self) -> None:
        """Only prompts/*.md and en/prompts/*.md open; README, docs and prompts folders elsewhere stay 404."""
        for path in (
            "/README.md",
            "/en/README.md",
            "/js/notes.md",
            "/js/prompts/leak.md",
            "/css/prompts/leak.md",
            "/words/prompts/leak.md",
            "/prompts/sub/deep.md",
            "/prompts/Upper.MD",
            "/prompts/notes.py",
            "/prompts",
            "/prompts/",
        ):
            with self.subTest(path=path):
                self.assertDenied(path)

    def test_markdown_prompt_symlink_to_readme_is_denied(self) -> None:
        """A symlink named like a prompt must not expose a markdown file elsewhere."""
        (self.root / "prompts" / "link.md").symlink_to(self.root / "README.md")
        self.assertDenied("/prompts/link.md")

    def test_query_and_fragment_are_ignored(self) -> None:
        self.assertServes("/js/app.js?v=2", "js/app.js")
        self.assertServes("/js/app.js#top", "js/app.js")
        self.assertServes("/js/app.js?a=1#b", "js/app.js")
        self.assertServes("/?utm=1", "index.html")

    def test_query_never_changes_which_file_is_served(self) -> None:
        # The query is dropped, so only the real path decides what is served.
        self.assertServes("/js/app.js?/../../data/language-data.json", "js/app.js")
        self.assertDenied("/data/language-data.json?/js/app.js")
        # An encoded "?" is part of the name, not a query separator.
        self.assertDenied("/js/app.js%3Fv=2")

    def test_unicode_names_work_percent_encoded_and_raw(self) -> None:
        self.assertServes("/js/p%C5%99%C3%ADli%C5%A1%20%C5%BElu%C5%A5ou%C4%8Dk%C3%BD.js", "js/příliš žluťoučký.js")
        self.assertServes("/js/příliš žluťoučký.js", "js/příliš žluťoučký.js")

    def test_denies_files_outside_the_allowlist(self) -> None:
        for path in (
            "/README.md",
            "/serve.py",
            "/.env",
            "/data/language-data.json",
            "/server/app.py",
            "/tools/make-public.sh",
            "/tests/test_x.js",
            "/docs/ARCHITECTURE.md",
            "/venv/lib/x.js",
            "/outside/secret.js",
            "/.git/config",
            "/package.json",
        ):
            with self.subTest(path=path):
                self.assertDenied(path)

    def test_denies_bad_extensions_below_allowed_dirs(self) -> None:
        for path in ("/js/notes.md", "/js/secret.py", "/js/no_extension"):
            with self.subTest(path=path):
                self.assertDenied(path)

    def test_denies_hidden_and_denied_segments_at_depth(self) -> None:
        for path in ("/js/.hidden.js", "/js/.git/config.js", "/js/data/x.js", "/js/Server/x.js", "/js/SERVER/x.js"):
            with self.subTest(path=path):
                self.assertDenied(path)

    def test_denies_directories_and_missing_files(self) -> None:
        for path in ("/js", "/js/", "/js/views", "/js/missing.js", "/css", "/en"):
            with self.subTest(path=path):
                self.assertDenied(path)

    def test_denies_traversal(self) -> None:
        for path in (
            "/../outside/secret.js",
            "/js/../data/language-data.json",
            "/js/../../outside/secret.js",
            "/js/./app.js",
            "/./index.html",
            "/js/views/../app.js",
            "/js/..",
            "/..",
        ):
            with self.subTest(path=path):
                self.assertDenied(path)

    def test_denies_percent_encoded_traversal_and_slashes(self) -> None:
        for path in (
            "/%2e%2e/outside/secret.js",
            "/%2E%2E/outside/secret.js",
            "/js/%2e%2e/data/language-data.json",
            "/js/%2e%2e%2fdata%2flanguage-data.json",
            "/js/..%2fdata%2flanguage-data.json",
            "/js%2f..%2f..%2foutside%2fsecret.js",
            "/%2e/index.html",
            "/js/%2e/app.js",
            "/data%2flanguage-data.json",
            "/%2e%65nv",
            "/%2eenv",
        ):
            with self.subTest(path=path):
                self.assertDenied(path)

    def test_encoded_slash_inside_allowed_path_is_just_a_slash(self) -> None:
        self.assertServes("/js%2fapp.js", "js/app.js")

    def test_double_encoding_is_decoded_only_once(self) -> None:
        # %252e%252e decodes once to the literal text "%2e%2e", which is no file.
        self.assertDenied("/%252e%252e/outside/secret.js")
        self.assertDenied("/js/%252e%252e/data/language-data.json")
        self.assertDenied("/js/app%252ejs")

    def test_denies_backslashes(self) -> None:
        for path in (
            "/js\\app.js",
            "/js/..\\data\\language-data.json",
            "/js%5Capp.js",
            "/..%5Coutside%5Csecret.js",
            "\\js\\app.js",
        ):
            with self.subTest(path=path):
                self.assertDenied(path)

    def test_denies_nul_and_control_characters(self) -> None:
        for path in (
            "/js/app.js\x00.png",
            "/js/app.js%00",
            "/js/app.js%00.png",
            "/index.html%00.txt",
            "/js/app.js%0a",
            "/js/app%0d.js",
            "/js/app.js\n",
            "/js/ap\tp.js",
            "/js/app.js%7f",
        ):
            with self.subTest(path=path):
                self.assertDenied(path)

    def test_denies_double_slashes_and_trailing_slash_files(self) -> None:
        for path in ("//", "//index.html", "/js//app.js", "/js/app.js/", "/js/views//chem.js", "//js/app.js"):
            with self.subTest(path=path):
                self.assertDenied(path)

    def test_denies_non_absolute_and_empty_paths(self) -> None:
        for path in ("", "js/app.js", "index.html", "*", "http://localhost:8768/js/app.js", "?x=1", "#x"):
            with self.subTest(path=path):
                self.assertDenied(path)

    def test_denies_invalid_utf8_after_decoding(self) -> None:
        # Overlong encoding of "." and a lone continuation byte.
        for path in ("/%c0%ae%c0%ae/outside/secret.js", "/js/app%ff.js", "/js/%80.js"):
            with self.subTest(path=path):
                self.assertDenied(path)

    def test_case_tricks_do_not_reach_denied_or_wrong_files(self) -> None:
        for path in (
            "/DATA/language-data.json",
            "/Data/language-data.json",
            "/SERVER/app.py",
            "/Index.html",
            "/INDEX.HTML",
            "/JS/app.js",
            "/Js/app.js",
            "/js/APP.JS",
            "/js/App.js",
            "/js/Data/x.js",
        ):
            with self.subTest(path=path):
                self.assertDenied(path)

    def test_denies_symlink_to_file_outside_root(self) -> None:
        self.assertDenied("/js/leak.js")

    def test_denies_symlinked_directory_leading_outside_root(self) -> None:
        self.assertDenied("/js/leakdir/secret.js")
        self.assertDenied("/js/leakdir/secret.txt")

    def test_denies_symlink_into_denied_folder_inside_root(self) -> None:
        self.assertDenied("/js/intodata.json")

    def test_denies_symlink_loop(self) -> None:
        self.assertDenied("/js/loop.js")

    def test_allows_symlink_that_stays_inside_an_allowed_folder(self) -> None:
        self.assertServes("/js/alias.js", "js/app.js")

    def test_denies_overlong_segment_without_raising(self) -> None:
        self.assertDenied("/js/" + "a" * 5000 + ".js")

    def test_root_that_is_itself_a_symlink_still_works(self) -> None:
        link = self.base / "root-link"
        link.symlink_to(self.root, target_is_directory=True)
        self.assertEqual(resolve_static(link, "/js/app.js"), self.root / "js" / "app.js")
        self.assertIsNone(resolve_static(link, "/js/leak.js"))

    def test_missing_root_returns_none(self) -> None:
        self.assertIsNone(resolve_static(self.base / "nope", "/index.html"))


if __name__ == "__main__":
    unittest.main()
