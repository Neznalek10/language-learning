"""Unit tests for server/datastore.py: validation, revision-checked saves, file format and conflicts.

Every test uses its own temporary folder and a fixed clock, so results are deterministic and
nothing outside the temp folder is touched.
"""

from __future__ import annotations

import json
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from server.datastore import (
    DATA_FILE_NAME,
    MAX_KEY_LENGTH,
    MAX_REASON_LENGTH,
    DataError,
    DataFile,
    DataStore,
    RevisionConflict,
    validate_entries,
)

CZECH = "Příliš žluťoučký kůň"
FIXED_TIME = datetime(2026, 11, 2, 10, 0, 0, tzinfo=timezone.utc)


class StoreTestCase(unittest.TestCase):
    """Base class: a DataStore in a fresh temp folder with a controllable clock."""

    def setUp(self) -> None:
        """Create the temp folder and a store whose clock returns `self.now`."""
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.data_dir = Path(temp.name) / "data"
        self.now = FIXED_TIME
        self.store = DataStore(self.data_dir, clock=lambda: self.now)


class ValidateEntriesTests(unittest.TestCase):
    """validate_entries accepts tracked plain JSON and rejects everything else."""

    def test_accepts_all_tracked_prefixes_and_unicode(self) -> None:
        """Keys with each tracked prefix and Czech text pass and come back equal."""
        entries = {"vocab.a": {"name": CZECH}, "vocab.fr-b": [1, 2.5, None, True], "vocab.v2-c": CZECH}
        self.assertEqual(validate_entries(entries), entries)

    def test_empty_entries_are_valid(self) -> None:
        """An empty object is a valid payload."""
        self.assertEqual(validate_entries({}), {})

    def test_returns_a_copy(self) -> None:
        """The result is a new dict, so later changes to the input do not leak in."""
        entries = {"vocab.a": 1}
        result = validate_entries(entries)
        entries["vocab.b"] = 2
        self.assertEqual(result, {"vocab.a": 1})

    def test_rejects_non_object(self) -> None:
        """Lists, strings and None are not entries objects."""
        for bad in ([], "x", None, 3):
            with self.subTest(bad=bad), self.assertRaises(DataError):
                validate_entries(bad)

    def test_rejects_untracked_prefix(self) -> None:
        """A key outside TRACKED_PREFIXES is refused."""
        with self.assertRaisesRegex(DataError, "must start with"):
            validate_entries({"other.key": 1})

    def test_rejects_non_string_key(self) -> None:
        """A non-string key is refused."""
        with self.assertRaises(DataError):
            validate_entries({1: "x"})

    def test_key_length_limit(self) -> None:
        """200 characters pass, 201 fail."""
        ok = "vocab." + "a" * (MAX_KEY_LENGTH - len("vocab."))
        self.assertEqual(len(ok), MAX_KEY_LENGTH)
        validate_entries({ok: 1})
        with self.assertRaisesRegex(DataError, "longer than"):
            validate_entries({ok + "a": 1})

    def test_rejects_control_characters_in_key(self) -> None:
        """Newline, NUL, DEL and C1 control characters are refused in keys."""
        for char in ("\n", "\x00", "\x7f", "\x85"):
            with self.subTest(char=repr(char)), self.assertRaisesRegex(DataError, "control"):
                validate_entries({f"vocab.a{char}b": 1})

    def test_rejects_non_finite_numbers(self) -> None:
        """NaN and Infinity would make the file invalid JSON for the browser."""
        for bad in (float("nan"), float("inf"), float("-inf")):
            with self.subTest(bad=bad), self.assertRaisesRegex(DataError, "finite"):
                validate_entries({"vocab.a": [bad]})

    def test_rejects_non_json_types(self) -> None:
        """Sets, bytes and other Python objects are not JSON values."""
        for bad in ({1}, b"x", object()):
            with self.subTest(bad=bad), self.assertRaisesRegex(DataError, "not a JSON value"):
                validate_entries({"vocab.a": bad})

    def test_rejects_non_string_object_keys_inside_values(self) -> None:
        """Nested objects must have string keys."""
        with self.assertRaisesRegex(DataError, "object keys"):
            validate_entries({"vocab.a": {1: "x"}})

    def test_rejects_lone_surrogates(self) -> None:
        """Text that cannot be encoded as UTF-8 is refused instead of failing at write time."""
        with self.assertRaisesRegex(DataError, "Unicode"):
            validate_entries({"vocab.a": "\ud800"})

    def test_rejects_excessive_nesting(self) -> None:
        """Absurdly deep values are refused."""
        value: object = 1
        for _ in range(150):
            value = [value]
        with self.assertRaisesRegex(DataError, "deeper"):
            validate_entries({"vocab.a": value})

    def test_rejects_ai_key_but_message_hides_it(self) -> None:
        """A non-empty AI key in an AI config object is refused and never echoed."""
        secret = "sk-secret-value-123"
        with self.assertRaises(DataError) as caught:
            validate_entries({"vocab.settings": {"ai": {"key": secret, "url": "https://openrouter.ai/x"}}})
        self.assertNotIn(secret, str(caught.exception))

    def test_ai_key_rule_matches_model_only_config(self) -> None:
        """A config with `key` and `model` (no url) also counts as an AI config."""
        with self.assertRaises(DataError):
            validate_entries({"vocab.settings": {"key": "abc", "model": "m"}})

    def test_rejects_ai_key_hidden_in_raw_text(self) -> None:
        """A `$raw` entry whose text parses as JSON gets the same AI-key check, and the message hides the key."""
        secret = "sk-secret-in-raw"
        raw = json.dumps({"url": "u", "key": secret})
        with self.assertRaises(DataError) as caught:
            validate_entries({"vocab.x": {"$raw": raw}})
        self.assertNotIn(secret, str(caught.exception))

    def test_raw_text_that_is_not_json_or_has_no_key_is_stored(self) -> None:
        """Opaque raw text and raw JSON without a key pass, as does a `$raw` value that is not a string."""
        validate_entries({"vocab.x": {"$raw": "plain text, not json {"}})
        validate_entries({"vocab.x": {"$raw": json.dumps({"url": "u", "key": ""})}})
        validate_entries({"vocab.x": {"$raw": 5}})

    def test_empty_key_and_unrelated_key_fields_are_allowed(self) -> None:
        """An empty key is the redacted form; a `key` field in an unrelated object is not a secret."""
        validate_entries({"vocab.settings": {"key": "", "url": "https://x"}})
        validate_entries({"vocab.cards": [{"key": "a", "value": "b"}]})


class DataFileTests(unittest.TestCase):
    """DataFile.to_json produces the documented file object."""

    def test_to_json_shape(self) -> None:
        """The object has app, format, revision, savedAt and entries."""
        data = DataFile(revision=3, saved_at="2026-11-02T10:00:00Z", entries={"vocab.a": 1})
        self.assertEqual(
            data.to_json(),
            {
                "app": "language-learning",
                "format": 1,
                "revision": 3,
                "savedAt": "2026-11-02T10:00:00Z",
                "entries": {"vocab.a": 1},
            },
        )


class LoadAndStatusTests(StoreTestCase):
    """load and status on missing, valid and broken files."""

    def test_missing_file(self) -> None:
        """No file: load is None and status reports revision 0."""
        self.assertIsNone(self.store.load())
        self.assertEqual(self.store.status(), {"exists": False, "revision": 0, "savedAt": None})

    def test_path_is_inside_data_dir(self) -> None:
        """The store exposes the data file path."""
        self.assertEqual(self.store.path, self.data_dir / DATA_FILE_NAME)

    def test_status_after_save(self) -> None:
        """status reflects the saved revision and timestamp."""
        self.store.save(0, {"vocab.a": 1})
        self.assertEqual(
            self.store.status(), {"exists": True, "revision": 1, "savedAt": "2026-11-02T10:00:00Z"}
        )

    def _write_raw(self, text: str | bytes) -> None:
        """Place arbitrary bytes at the data file path."""
        self.data_dir.mkdir(parents=True, exist_ok=True)
        data = text if isinstance(text, bytes) else text.encode("utf-8")
        self.store.path.write_bytes(data)

    def test_invalid_json(self) -> None:
        """Unparseable content raises DataError."""
        self._write_raw("{not json")
        with self.assertRaisesRegex(DataError, "not valid JSON"):
            self.store.load()

    def test_invalid_utf8(self) -> None:
        """Bytes that are not UTF-8 raise DataError."""
        self._write_raw(b"\xff\xfe\x00")
        with self.assertRaisesRegex(DataError, "UTF-8"):
            self.store.load()

    def test_wrong_shapes(self) -> None:
        """Wrong app, format, revision, savedAt, entries or top-level type raise DataError."""
        good = {"app": "language-learning", "format": 1, "revision": 1, "savedAt": "t", "entries": {}}
        variants = [
            [],
            {**good, "app": "other"},
            {**good, "format": 2},
            {**good, "revision": 0},
            {**good, "revision": True},
            {**good, "revision": "1"},
            {**good, "savedAt": ""},
            {**good, "entries": []},
            {**good, "entries": {"bad.key": 1}},
        ]
        for variant in variants:
            with self.subTest(variant=variant):
                self._write_raw(json.dumps(variant))
                with self.assertRaises(DataError):
                    self.store.load()
                self.store.path.unlink()


class SaveTests(StoreTestCase):
    """save: revisions, conflicts, file format and atomicity."""

    def test_first_save_creates_folder_and_revision_one(self) -> None:
        """Base revision 0 on a missing file creates data_dir and revision 1."""
        saved = self.store.save(0, {"vocab.a": CZECH})
        self.assertEqual((saved.revision, saved.saved_at), (1, "2026-11-02T10:00:00Z"))
        self.assertEqual(self.store.load(), saved)

    def test_revision_increments(self) -> None:
        """Each save with the current revision advances it by one."""
        first = self.store.save(0, {"vocab.a": 1})
        second = self.store.save(first.revision, {"vocab.a": 2})
        self.assertEqual(second.revision, 2)
        self.assertEqual(self.store.load().entries, {"vocab.a": 2})

    def test_stale_base_revision_conflicts(self) -> None:
        """A base revision that is not current raises RevisionConflict carrying the stored revision."""
        self.store.save(0, {"vocab.a": 1})
        self.store.save(1, {"vocab.a": 2})
        with self.assertRaises(RevisionConflict) as caught:
            self.store.save(1, {"vocab.a": 3})
        self.assertEqual(caught.exception.current, 2)
        self.assertEqual(self.store.load().entries, {"vocab.a": 2})

    def test_nonzero_base_on_missing_file_conflicts(self) -> None:
        """With no file the current revision is 0, so base 5 conflicts."""
        with self.assertRaises(RevisionConflict) as caught:
            self.store.save(5, {})
        self.assertEqual(caught.exception.current, 0)
        self.assertFalse(self.store.path.exists())

    def test_zero_base_on_existing_file_conflicts(self) -> None:
        """A client that never synced (base 0) cannot overwrite an existing file."""
        self.store.save(0, {"vocab.a": 1})
        with self.assertRaises(RevisionConflict):
            self.store.save(0, {"vocab.a": 2})

    def test_invalid_base_revision(self) -> None:
        """Negative, boolean, float and string base revisions are DataErrors."""
        for bad in (-1, True, 1.0, "0", None):
            with self.subTest(bad=bad), self.assertRaises(DataError):
                self.store.save(bad, {})  # type: ignore[arg-type]

    def test_invalid_entries_write_nothing(self) -> None:
        """A rejected payload leaves no file behind."""
        with self.assertRaises(DataError):
            self.store.save(0, {"nope": 1})
        self.assertFalse(self.data_dir.exists())

    def test_saved_at_uses_clock_in_utc(self) -> None:
        """A non-UTC aware clock is converted to UTC for savedAt."""
        prague = timezone(timedelta(hours=1))
        self.now = datetime(2026, 11, 2, 11, 30, 5, tzinfo=prague)
        self.assertEqual(self.store.save(0, {}).saved_at, "2026-11-02T10:30:05Z")

    def test_file_format_is_readable_utf8(self) -> None:
        """The file is pretty-printed, sorted, keeps Czech characters unescaped and ends with a newline."""
        self.store.save(0, {"vocab.b": CZECH, "vocab.a": {"z": 1, "a": 2}})
        text = self.store.path.read_text(encoding="utf-8")
        expected = json.dumps(json.loads(text), indent=1, sort_keys=True, ensure_ascii=False) + "\n"
        self.assertEqual(text, expected)
        self.assertIn(CZECH, text)
        self.assertLess(text.index('"vocab.a"'), text.index('"vocab.b"'))

    def test_no_temp_file_left_after_save(self) -> None:
        """Only the data file remains in the folder."""
        self.store.save(0, {"vocab.a": 1})
        self.assertEqual([p.name for p in self.data_dir.iterdir()], [DATA_FILE_NAME])

    def test_failed_write_keeps_old_file_and_removes_temp(self) -> None:
        """If the final rename fails, the previous revision survives and the temp file is cleaned up."""
        self.store.save(0, {"vocab.a": 1})
        with mock.patch("server.datastore.os.replace", side_effect=OSError("disk gone")):
            with self.assertRaises(OSError):
                self.store.save(1, {"vocab.a": 2})
        self.assertEqual(self.store.load().entries, {"vocab.a": 1})
        self.assertEqual([p.name for p in self.data_dir.iterdir()], [DATA_FILE_NAME])

    def test_concurrent_saves_with_same_base_only_one_wins(self) -> None:
        """Many threads saving against revision 0 produce exactly one success and one stored revision."""
        outcomes: list[str] = []
        barrier = threading.Barrier(8)

        def attempt(index: int) -> None:
            """Wait for all threads, then try one save against revision 0 and record the outcome."""
            barrier.wait()
            try:
                self.store.save(0, {"vocab.a": index})
                outcomes.append("saved")
            except RevisionConflict:
                outcomes.append("conflict")

        threads = [threading.Thread(target=attempt, args=(i,)) for i in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(outcomes), ["conflict"] * 7 + ["saved"])
        self.assertEqual(self.store.load().revision, 1)


class SaveConflictTests(StoreTestCase):
    """save_conflict: file name, content, collisions and validation."""

    def test_writes_conflict_file(self) -> None:
        """The file lands in conflicts/ with the documented name and content."""
        path = self.store.save_conflict({"vocab.a": CZECH}, "stale tab")
        self.assertEqual(path, self.data_dir / "conflicts" / "conflict-20261102T100000Z.json")
        self.assertEqual(
            json.loads(path.read_text(encoding="utf-8")),
            {
                "app": "language-learning",
                "format": 1,
                "reason": "stale tab",
                "savedAt": "2026-11-02T10:00:00Z",
                "entries": {"vocab.a": CZECH},
            },
        )

    def test_same_second_conflicts_get_numbered_names(self) -> None:
        """A second and third conflict in one second never overwrite the first."""
        names = [self.store.save_conflict({"vocab.a": i}, "r").name for i in range(3)]
        self.assertEqual(
            names,
            [
                "conflict-20261102T100000Z.json",
                "conflict-20261102T100000Z-2.json",
                "conflict-20261102T100000Z-3.json",
            ],
        )
        first = json.loads((self.data_dir / "conflicts" / names[0]).read_text(encoding="utf-8"))
        self.assertEqual(first["entries"], {"vocab.a": 0})

    def test_reason_is_truncated(self) -> None:
        """A reason longer than MAX_REASON_LENGTH is cut to that length."""
        path = self.store.save_conflict({}, "x" * (MAX_REASON_LENGTH + 50))
        self.assertEqual(len(json.loads(path.read_text(encoding="utf-8"))["reason"]), MAX_REASON_LENGTH)

    def test_does_not_touch_data_file(self) -> None:
        """Saving a conflict leaves the main data file and its revision alone."""
        self.store.save(0, {"vocab.a": 1})
        self.store.save_conflict({"vocab.a": 2}, "r")
        self.assertEqual(self.store.status()["revision"], 1)

    def test_invalid_input_writes_nothing(self) -> None:
        """Bad entries or a non-string reason raise DataError and create no file."""
        with self.assertRaises(DataError):
            self.store.save_conflict({"bad": 1}, "r")
        with self.assertRaises(DataError):
            self.store.save_conflict({}, 5)  # type: ignore[arg-type]
        self.assertFalse((self.data_dir / "conflicts").exists())

    def test_ai_key_in_raw_text_is_refused(self) -> None:
        """Conflict files also scan `$raw` text for an AI key."""
        with self.assertRaises(DataError):
            self.store.save_conflict({"vocab.s": {"$raw": '{"url": "u", "key": "sk-1"}'}}, "r")

    def test_ai_key_is_refused(self) -> None:
        """Conflict files obey the same no-secret rule as the data file."""
        with self.assertRaises(DataError):
            self.store.save_conflict({"vocab.s": {"key": "sk-1", "url": "u"}}, "r")


if __name__ == "__main__":
    unittest.main()
