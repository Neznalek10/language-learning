"""Data file storage for the language app: one JSON file holding every tracked browser entry.

Responsibility: load and validate `data/language-data.json`, save it atomically behind an integer revision check
(optimistic concurrency), and keep the losing side of a conflict in `data/conflicts/`.
Fits in: server/app.py calls DataStore from its request handlers; nothing here knows about HTTP.
Uses: the standard library only.

Invariants:
- The file is `{"app", "format", "revision" (>= 1), "savedAt", "entries"}`, UTF-8, pretty-printed, sorted keys.
- Every entry key starts with one of TRACKED_PREFIXES and every value is plain JSON (no NaN or Infinity).
- No entry holds a non-empty AI key: keys belong in .env, so such a payload is rejected, never written.
- Writes go to `<name>.tmp` in the same folder and are moved into place with `os.replace`.
- `save` and `save_conflict` share one lock, because the HTTP server is threaded.
"""

from __future__ import annotations

import json
import os
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DATA_FILE_NAME = "language-data.json"
CONFLICTS_DIR_NAME = "conflicts"
APP_NAME = "language-learning"
DATA_FORMAT = 1
TRACKED_PREFIXES: tuple[str, ...] = ("vocab.",)
MAX_KEY_LENGTH = 200
MAX_REASON_LENGTH = 300
# Deepest nesting accepted inside an entry value; real app state is far shallower, this only stops abuse.
MAX_VALUE_DEPTH = 100
# Wrapper key for a localStorage string that is not valid JSON (see js/sync/snapshot.js encodeValue).
RAW_MARKER = "$raw"
SAVED_AT_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
CONFLICT_STAMP_FORMAT = "%Y%m%dT%H%M%SZ"
TEMP_SUFFIX = ".tmp"
FIRST_REVISION = 1
# Matches any ASCII or C1 control character (they must not appear in entry keys).
CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]")


class DataError(ValueError):
    """The data file or a payload is invalid; the message says what is wrong and where."""


class RevisionConflict(Exception):
    """The caller's base revision is not the revision stored on disk.

    Attributes:
        current: The revision of the stored file (0 when no file exists yet).
    """

    def __init__(self, current: int) -> None:
        """Remember the stored revision so the caller can report it.

        Args:
            current: The revision found in the data file (0 when missing).
        """
        super().__init__(f"Stored revision is {current}; reload the data and try again.")
        self.current = current


@dataclass(frozen=True)
class DataFile:
    """The content of one data file revision.

    Attributes:
        revision: Integer revision, 1 for the first save and +1 for every later save.
        saved_at: ISO 8601 UTC timestamp of the save, for example "2026-11-02T10:00:00Z".
        entries: Tracked localStorage key -> parsed JSON value.
    """

    revision: int
    saved_at: str
    entries: dict[str, Any]

    def to_json(self) -> dict[str, Any]:
        """Return the file object exactly as it is stored on disk.

        Returns:
            A dict with the keys app, format, revision, savedAt and entries.
        """
        return {
            "app": APP_NAME,
            "format": DATA_FORMAT,
            "revision": self.revision,
            "savedAt": self.saved_at,
            "entries": self.entries,
        }


def _is_int(value: Any) -> bool:
    """Return True for real integers (a bool is not accepted as a number here)."""
    return isinstance(value, int) and not isinstance(value, bool)


def _is_ai_config_with_key(value: dict[str, Any]) -> bool:
    """Return True when a dict looks like an AI settings object that holds a non-empty key.

    The shape mirrors redactSecrets in js/sync/snapshot.js: a string `key` plus a string `url` or `model`.
    """
    key = value.get("key")
    has_endpoint = isinstance(value.get("url"), str) or isinstance(value.get("model"), str)
    return isinstance(key, str) and key != "" and has_endpoint


def _check_text(text: str, where: str) -> None:
    """Raise DataError when a string cannot be written as UTF-8 (for example a lone surrogate).

    Args:
        text: The string to test.
        where: Human-readable location used in the error message.
    """
    try:
        text.encode("utf-8")
    except UnicodeEncodeError as error:
        raise DataError(f"{where}: text is not valid Unicode.") from error


def _check_value(value: Any, where: str, depth: int = 0) -> None:
    """Walk one entry value and raise DataError unless it is plain, secret-free JSON.

    One walk covers every rule so a large payload is traversed once: allowed types, finite numbers,
    string keys, encodable text, bounded depth and the "no AI key" invariant.

    Args:
        value: The value to check (the parsed JSON of a localStorage string).
        where: Human-readable location used in the error message (the entry key).
        depth: Current nesting depth, used to stop pathological payloads.

    Raises:
        DataError: The value breaks one of the rules above.
    """
    if depth > MAX_VALUE_DEPTH:
        raise DataError(f"{where}: nested deeper than {MAX_VALUE_DEPTH} levels.")
    if value is None or isinstance(value, bool) or _is_int(value):
        return
    if isinstance(value, float):
        # NaN and Infinity are not valid JSON, so a file containing them could not be read by the browser.
        if value != value or value in (float("inf"), float("-inf")):
            raise DataError(f"{where}: numbers must be finite.")
    elif isinstance(value, str):
        _check_text(value, where)
    elif isinstance(value, list):
        for item in value:
            _check_value(item, where, depth + 1)
    elif isinstance(value, dict):
        if _is_ai_config_with_key(value):
            raise DataError(f"{where}: contains an AI key; keys are stored in .env, not in the data file.")
        for name, item in value.items():
            if not isinstance(name, str):
                raise DataError(f"{where}: object keys must be strings.")
            _check_text(name, where)
            _check_value(item, where, depth + 1)
    else:
        raise DataError(f"{where}: {type(value).__name__} is not a JSON value.")


def _check_raw_entry(value: Any, where: str) -> None:
    """Scan the text inside a `{"$raw": "<text>"}` entry for an AI key.

    The client stores a localStorage string that is not valid JSON as `{"$raw": text}`. When that text
    still parses as JSON here, the parsed value gets the same checks as any other entry, so a key cannot
    hide inside raw text. Text that does not parse is opaque and is stored as is.

    Args:
        value: The entry value; only a one-key dict whose `$raw` is a string is examined.
        where: Human-readable location used in the error message (the entry key).

    Raises:
        DataError: The parsed raw text breaks a rule in `_check_value` (the message never contains the text).
    """
    if not (isinstance(value, dict) and len(value) == 1 and isinstance(value.get(RAW_MARKER), str)):
        return
    try:
        parsed = json.loads(value[RAW_MARKER])
    except (ValueError, RecursionError):
        return
    _check_value(parsed, f"{where} ({RAW_MARKER})")


def _check_entry_key(key: Any) -> None:
    """Raise DataError unless `key` is an acceptable tracked localStorage key.

    Args:
        key: Candidate key.

    Raises:
        DataError: Not a string, too long, has control characters, or lacks a tracked prefix.
    """
    if not isinstance(key, str):
        raise DataError("Entry keys must be strings.")
    if len(key) > MAX_KEY_LENGTH:
        raise DataError(f"Entry key is longer than {MAX_KEY_LENGTH} characters: {key[:40]!r}...")
    if CONTROL_CHARACTERS.search(key):
        raise DataError(f"Entry key contains control characters: {key[:40]!r}")
    if not key.startswith(TRACKED_PREFIXES):
        allowed = ", ".join(f"'{prefix}'" for prefix in TRACKED_PREFIXES)
        raise DataError(f"Entry key {key!r} must start with one of: {allowed}.")


def validate_entries(entries: Any) -> dict[str, Any]:
    """Check an entries payload and return it as a plain dict.

    Args:
        entries: Mapping of localStorage key -> parsed JSON value.

    Returns:
        A new dict with the same content, safe to write to the data file.

    Raises:
        DataError: `entries` is not an object, a key is not tracked, too long or has control characters,
            or a value is not plain JSON or holds a non-empty AI key.

    Example:
        >>> validate_entries({"vocab.a1.imports": [{"title": "Příliš žluťoučký kůň"}]})
        {'vocab.a1.imports': [{'title': 'Příliš žluťoučký kůň'}]}
    """
    if not isinstance(entries, dict):
        raise DataError("Entries must be a JSON object of key -> value.")
    for key, value in entries.items():
        _check_entry_key(key)
        _check_value(value, key)
        _check_raw_entry(value, key)
    return dict(entries)


def _check_base_revision(base_revision: Any) -> None:
    """Raise DataError unless the base revision is a non-negative integer."""
    if not _is_int(base_revision) or base_revision < 0:
        raise DataError("baseRevision must be an integer of 0 or more.")


def _parse_data_file(raw: Any, path: Path) -> DataFile:
    """Turn the parsed JSON of a data file into a DataFile, checking its shape.

    Args:
        raw: The result of json.loads on the file.
        path: The file path, used in error messages.

    Raises:
        DataError: The shape, app name, format, revision, timestamp or entries are wrong.
    """
    if not isinstance(raw, dict):
        raise DataError(f"{path.name}: expected a JSON object at the top level.")
    if raw.get("app") != APP_NAME or raw.get("format") != DATA_FORMAT:
        raise DataError(f"{path.name}: not a {APP_NAME} data file of format {DATA_FORMAT}.")
    revision = raw.get("revision")
    if not _is_int(revision) or revision < FIRST_REVISION:
        raise DataError(f"{path.name}: revision must be an integer of {FIRST_REVISION} or more.")
    saved_at = raw.get("savedAt")
    if not isinstance(saved_at, str) or not saved_at:
        raise DataError(f"{path.name}: savedAt must be a timestamp string.")
    return DataFile(revision=revision, saved_at=saved_at, entries=validate_entries(raw.get("entries")))


def _serialize(document: dict[str, Any]) -> bytes:
    """Return the canonical on-disk form: readable, sorted, UTF-8, ending with a newline."""
    text = json.dumps(document, indent=1, sort_keys=True, ensure_ascii=False, allow_nan=False)
    return (text + "\n").encode("utf-8")


def _write_atomically(path: Path, document: dict[str, Any]) -> None:
    """Write `document` to `path` so a crash never leaves a half-written file.

    The bytes go to `<name>.tmp` next to the target and are flushed to disk, then `os.replace` swaps
    the temp file in (atomic on one filesystem). The temp file is removed when anything fails.

    Args:
        path: Final file path; its folder must exist.
        document: JSON-serializable object to store.

    Raises:
        OSError: The file system refused the write.
    """
    temp_path = path.with_name(path.name + TEMP_SUFFIX)
    try:
        with open(temp_path, "wb") as handle:
            handle.write(_serialize(document))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


class DataStore:
    """The data file and its conflict folder, with revision-checked saves.

    Attributes:
        path: Location of the data file (`data_dir / DATA_FILE_NAME`).

    Example:
        >>> import tempfile
        >>> store = DataStore(Path(tempfile.mkdtemp()) / "data")   # a temp folder, never the real data/
        >>> saved = store.save(0, {"vocab.accounts": []})   # first save: base revision 0
        >>> store.save(saved.revision, {"vocab.accounts": [1]}).revision
        2
    """

    def __init__(
        self,
        data_dir: Path,
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        """Create a store; nothing is read or created until it is used.

        Args:
            data_dir: Folder for the data file; created on the first save.
            clock: Returns the current time as a timezone-aware datetime (injected so tests are deterministic).
        """
        self._data_dir = data_dir
        self._clock = clock
        # Serializes read-check-write cycles: two threads must not both pass the revision check.
        self._lock = threading.Lock()
        self.path = data_dir / DATA_FILE_NAME

    def load(self) -> DataFile | None:
        """Read the data file.

        Returns:
            The stored DataFile, or None when the file does not exist.

        Raises:
            DataError: The file is not valid UTF-8 JSON or does not have the documented shape.
        """
        try:
            text = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        except UnicodeDecodeError as error:
            raise DataError(f"{self.path.name}: file is not valid UTF-8.") from error
        try:
            raw = json.loads(text)
        except (ValueError, RecursionError) as error:
            raise DataError(f"{self.path.name}: file is not valid JSON ({error}).") from error
        return _parse_data_file(raw, self.path)

    def status(self) -> dict[str, Any]:
        """Summarize the file without returning its entries.

        Returns:
            {"exists": bool, "revision": int (0 when missing), "savedAt": str or None}

        Raises:
            DataError: The file exists but is unreadable or malformed.
        """
        current = self.load()
        if current is None:
            return {"exists": False, "revision": 0, "savedAt": None}
        return {"exists": True, "revision": current.revision, "savedAt": current.saved_at}

    def save(self, base_revision: int, entries: dict[str, Any]) -> DataFile:
        """Store `entries` as the next revision if `base_revision` is still current.

        Args:
            base_revision: The revision the caller last saw (0 when the caller has no file yet).
            entries: Tracked localStorage key -> parsed JSON value.

        Returns:
            The new DataFile (revision = previous + 1, or 1 for the first save).

        Raises:
            DataError: The payload is invalid, or the stored file is malformed.
            RevisionConflict: `base_revision` differs from the stored revision (0 when no file exists).
            OSError: The file system refused the write.
        """
        _check_base_revision(base_revision)
        checked = validate_entries(entries)
        with self._lock:
            stored = self.load()
            current = stored.revision if stored else 0
            if base_revision != current:
                raise RevisionConflict(current)
            saved = DataFile(
                revision=current + 1,
                saved_at=self._clock().astimezone(timezone.utc).strftime(SAVED_AT_FORMAT),
                entries=checked,
            )
            self._data_dir.mkdir(parents=True, exist_ok=True)
            _write_atomically(self.path, saved.to_json())
            return saved

    def save_conflict(self, entries: dict[str, Any], reason: str) -> Path:
        """Keep local entries that lost a revision conflict in `conflicts/conflict-<stamp>[-n].json`.

        An existing file is never overwritten: a second conflict in the same second gets `-2`, then `-3`.

        Args:
            entries: The entries to preserve (same rules as `save`).
            reason: Why they were set aside; truncated to MAX_REASON_LENGTH characters.

        Returns:
            The path of the file that was written.

        Raises:
            DataError: `entries` is invalid or `reason` is not a string.
            OSError: The file system refused the write.
        """
        checked = validate_entries(entries)
        if not isinstance(reason, str):
            raise DataError("reason must be a string.")
        _check_text(reason, "reason")
        moment = self._clock().astimezone(timezone.utc)
        document = {
            "app": APP_NAME,
            "format": DATA_FORMAT,
            "reason": reason[:MAX_REASON_LENGTH],
            "savedAt": moment.strftime(SAVED_AT_FORMAT),
            "entries": checked,
        }
        conflicts_dir = self._data_dir / CONFLICTS_DIR_NAME
        with self._lock:
            conflicts_dir.mkdir(parents=True, exist_ok=True)
            target = self._free_conflict_path(conflicts_dir, moment.strftime(CONFLICT_STAMP_FORMAT))
            _write_atomically(target, document)
            return target

    @staticmethod
    def _free_conflict_path(conflicts_dir: Path, stamp: str) -> Path:
        """Return the first unused `conflict-<stamp>[-n].json` path in `conflicts_dir`.

        Args:
            conflicts_dir: Existing conflicts folder.
            stamp: Timestamp part of the name, for example "20261102T100000Z".
        """
        candidate = conflicts_dir / f"conflict-{stamp}.json"
        suffix = 2
        # Same-second conflicts get -2, -3, ... so none is ever lost.
        while candidate.exists():
            candidate = conflicts_dir / f"conflict-{stamp}-{suffix}.json"
            suffix += 1
        return candidate
