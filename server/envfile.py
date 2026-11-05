"""Reads and writes the allowlisted secrets in the project's `.env` file.

Responsibility: let the language app store its AI key in `.env` (never in the data file) and read it back.
Fits in: server/app.py serves GET and PUT /api/keys through EnvFile; the browser sync engine
fills empty key fields from it. Uses python-dotenv for parsing and for updating single lines.

Invariants:
- Only names in ENV_KEYS can be read or written; any other name is an EnvError.
- A value is one line without control characters and at most MAX_VALUE_LENGTH characters.
- Writing an empty value removes the key. Unrelated lines in the file are kept untouched.
- The file has mode 0600 (owner only) after every write, whether it was created here or already existed.
  Values are never logged or put into error messages.
"""

from __future__ import annotations

import os
import re
import threading
from pathlib import Path

from dotenv import dotenv_values, set_key, unset_key

ENV_KEYS: tuple[str, ...] = ("AI_API_KEY",)
MAX_VALUE_LENGTH = 400
ENV_ENCODING = "utf-8"
PRIVATE_FILE_MODE = 0o600
# Matches any ASCII or C1 control character, which includes line breaks and tabs.
CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]")


class EnvError(ValueError):
    """A key name or value is not allowed in .env; the message says which and why (never the value)."""


def _check_value(name: str, value: object) -> str:
    """Return `value` if it may be stored under `name`, otherwise raise EnvError.

    Args:
        name: An allowlisted key name (used in the message).
        value: Candidate value.

    Raises:
        EnvError: Not a string, too long, or contains control characters (including line breaks).
    """
    if not isinstance(value, str):
        raise EnvError(f"{name} must be a string.")
    if len(value) > MAX_VALUE_LENGTH:
        raise EnvError(f"{name} is longer than {MAX_VALUE_LENGTH} characters.")
    if CONTROL_CHARACTERS.search(value):
        raise EnvError(f"{name} must be a single line without control characters.")
    return value


class EnvFile:
    """The `.env` file, restricted to the keys in ENV_KEYS.

    Example:
        >>> env = EnvFile(Path(".env"))
        >>> env.write({"AI_API_KEY": "sk-example"})
        {'AI_API_KEY': 'sk-example'}
        >>> env.write({"AI_API_KEY": ""})   # removes the line
        {'AI_API_KEY': ''}
    """

    def __init__(self, path: Path) -> None:
        """Remember the file location; the file is created on the first non-empty write.

        Args:
            path: Location of the .env file (its folder must exist).
        """
        self._path = path
        # The server is threaded and a write is a read-modify-write of the whole file.
        self._lock = threading.Lock()

    def read(self) -> dict[str, str]:
        """Return the value of every name in ENV_KEYS.

        Returns:
            Name -> value, with "" for names that are unset. A missing file is fine and yields all "".
        """
        # interpolate=False: a key containing "${...}" must come back exactly as stored, not expanded.
        parsed = dotenv_values(self._path, encoding=ENV_ENCODING, interpolate=False)
        # dotenv gives None for a bare `NAME` line without "="; treat it as unset.
        return {name: parsed.get(name) or "" for name in ENV_KEYS}

    def write(self, values: dict[str, str]) -> dict[str, str]:
        """Set or remove allowlisted keys.

        All values are validated before anything is written, so a bad request changes nothing.

        Args:
            values: Name -> new value. An empty string removes the key.

        Returns:
            The result of `read()` after the update.

        Raises:
            EnvError: `values` is not a dict, a name is not in ENV_KEYS, or a value is not an allowed string.
            OSError: The file could not be written.
        """
        if not isinstance(values, dict):
            raise EnvError("Values must be an object of name -> value.")
        checked: dict[str, str] = {}
        for name, value in values.items():
            if name not in ENV_KEYS:
                raise EnvError(f"{name!r} is not a supported key; allowed: {', '.join(ENV_KEYS)}.")
            checked[name] = _check_value(name, value)
        with self._lock:
            for name, value in checked.items():
                if value:
                    self._set(name, value)
                else:
                    self._remove(name)
            return self.read()

    def _set(self, name: str, value: str) -> None:
        """Store one non-empty value in a file that is made owner-only (0600) first."""
        # Create first so a new file never exists with looser permissions (set_key keeps an existing mode).
        os.close(os.open(self._path, os.O_WRONLY | os.O_CREAT, PRIVATE_FILE_MODE))
        # An older file (for example made by hand with 0644) is tightened before the secret goes in.
        self._path.chmod(PRIVATE_FILE_MODE)
        set_key(self._path, name, value, quote_mode="always", encoding=ENV_ENCODING)

    def _remove(self, name: str) -> None:
        """Delete one key's line if present; a missing file or key is already the wanted state."""
        if not self._path.exists():
            return
        # Tighten permissions on every write, including a removal, so the other keys stay private too.
        self._path.chmod(PRIVATE_FILE_MODE)
        # Check before unset_key: it logs a warning for a missing key, which is noise here.
        if name in dotenv_values(self._path, encoding=ENV_ENCODING, interpolate=False):
            unset_key(self._path, name, quote_mode="always", encoding=ENV_ENCODING)
