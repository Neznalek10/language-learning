"""Unit tests for server/envfile.py: reading, writing, removing and validating allowlisted .env keys.

Each test works in its own temp folder; the secret values used here are fake placeholders.
"""

from __future__ import annotations

import stat
import tempfile
import unittest
from pathlib import Path

from server.envfile import ENV_KEYS, MAX_VALUE_LENGTH, EnvError, EnvFile

KEY = "AI_API_KEY"


class EnvFileTests(unittest.TestCase):
    """Behavior of EnvFile against a real file in a temp folder."""

    def setUp(self) -> None:
        """Create a temp folder and an EnvFile pointing at a not-yet-existing .env."""
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.path = Path(temp.name) / ".env"
        self.env = EnvFile(self.path)

    def test_read_missing_file_gives_empty_values(self) -> None:
        """A missing file is fine: every allowed key reads as an empty string."""
        self.assertEqual(self.env.read(), {name: "" for name in ENV_KEYS})
        self.assertFalse(self.path.exists())

    def test_write_then_read_round_trips(self) -> None:
        """A written value is returned by write and by a fresh EnvFile."""
        self.assertEqual(self.env.write({KEY: "sk-test-123"}), {KEY: "sk-test-123"})
        self.assertEqual(EnvFile(self.path).read(), {KEY: "sk-test-123"})

    def test_special_characters_round_trip(self) -> None:
        """Quotes, backslashes, hashes, spaces, dollars and Czech text survive quoting unchanged."""
        values = (
            "it's", "back\\slash", "a#b", " padded ", "${HOME}", "$X", "Příliš žluťoučký kůň", "a\\'b", "x\\",
        )
        for value in values:
            with self.subTest(value=value):
                self.assertEqual(self.env.write({KEY: value})[KEY], value)

    def test_new_file_is_private(self) -> None:
        """A newly created .env is readable and writable by the owner only (0600)."""
        self.env.write({KEY: "sk-test"})
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_empty_value_removes_key(self) -> None:
        """Writing "" deletes the line and reads back as empty."""
        self.env.write({KEY: "sk-test"})
        self.assertEqual(self.env.write({KEY: ""}), {KEY: ""})
        self.assertNotIn(KEY, self.path.read_text(encoding="utf-8"))

    def test_empty_value_without_file_creates_nothing(self) -> None:
        """Removing a key when there is no file is a no-op and does not create one."""
        self.assertEqual(self.env.write({KEY: ""}), {KEY: ""})
        self.assertFalse(self.path.exists())

    def test_empty_value_when_key_absent_keeps_file(self) -> None:
        """Removing an absent key leaves the other lines exactly as they were."""
        self.path.write_text("OTHER=1\n", encoding="utf-8")
        self.env.write({KEY: ""})
        self.assertEqual(self.path.read_text(encoding="utf-8"), "OTHER=1\n")

    def test_unrelated_lines_are_kept(self) -> None:
        """Comments and other variables survive both setting and removing the key."""
        self.path.write_text("# my notes\nOTHER=keep me\n", encoding="utf-8")
        self.env.write({KEY: "sk-test"})
        text = self.path.read_text(encoding="utf-8")
        self.assertIn("# my notes\n", text)
        self.assertIn("OTHER=keep me\n", text)
        self.env.write({KEY: ""})
        text = self.path.read_text(encoding="utf-8")
        self.assertIn("# my notes\n", text)
        self.assertIn("OTHER=keep me\n", text)

    def test_overwrite_replaces_existing_value(self) -> None:
        """Setting the key again replaces the value without duplicating the line."""
        self.env.write({KEY: "first"})
        self.env.write({KEY: "second"})
        self.assertEqual(self.env.read(), {KEY: "second"})
        self.assertEqual(self.path.read_text(encoding="utf-8").count(KEY), 1)

    def test_existing_file_is_tightened_to_private_on_write(self) -> None:
        """A file made earlier with looser permissions (0644) becomes 0600 after a key is written."""
        self.path.write_text("OTHER=1\n", encoding="utf-8")
        self.path.chmod(0o644)
        self.env.write({KEY: "sk-test"})
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_existing_file_is_tightened_to_private_on_removal(self) -> None:
        """Removing a key also leaves the remaining file at 0600."""
        self.path.write_text("OTHER=1\nAI_API_KEY='x'\n", encoding="utf-8")
        self.path.chmod(0o644)
        self.env.write({KEY: ""})
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)

    def test_read_ignores_other_keys_and_bare_names(self) -> None:
        """Only allowlisted names are returned; a bare `AI_API_KEY` line without = is unset."""
        self.path.write_text("OTHER=1\nAI_API_KEY\n", encoding="utf-8")
        self.assertEqual(self.env.read(), {KEY: ""})

    def test_unknown_key_is_rejected(self) -> None:
        """A name outside ENV_KEYS raises EnvError and writes nothing."""
        with self.assertRaisesRegex(EnvError, "not a supported key"):
            self.env.write({"PATH": "x"})
        self.assertFalse(self.path.exists())

    def test_invalid_values_are_rejected_without_leaking_them(self) -> None:
        """Non-strings, control characters and too-long values raise EnvError; the message omits the value."""
        secret = "sk-secret\nINJECT=1"
        cases = [None, 5, ["x"], secret, "tab\there", "nul\x00", "x" * (MAX_VALUE_LENGTH + 1)]
        for value in cases:
            with self.subTest(value=repr(value)[:20]):
                with self.assertRaises(EnvError) as caught:
                    self.env.write({KEY: value})  # type: ignore[dict-item]
                self.assertNotIn("sk-secret", str(caught.exception))
        self.assertFalse(self.path.exists())

    def test_max_length_value_is_accepted(self) -> None:
        """Exactly MAX_VALUE_LENGTH characters is allowed."""
        value = "k" * MAX_VALUE_LENGTH
        self.assertEqual(self.env.write({KEY: value})[KEY], value)

    def test_non_dict_is_rejected(self) -> None:
        """The values argument must be a mapping."""
        with self.assertRaises(EnvError):
            self.env.write(["AI_API_KEY"])  # type: ignore[arg-type]

    def test_one_bad_entry_changes_nothing(self) -> None:
        """Validation covers the whole request before the first write."""
        with self.assertRaises(EnvError):
            self.env.write({KEY: "sk-ok", "OTHER": "x"})
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main()
