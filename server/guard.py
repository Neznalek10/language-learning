"""Request guard: the security boundary of the local language-learning server.

Responsibility:
    Pure, side-effect-free decisions about whether a request may be served:
    the Host header check (DNS rebinding defence), the Origin check and the
    JSON content-type check for writes, and the static file allowlist that maps
    a raw URL path onto a real file inside the project root.

Where it fits:
    server/app.py calls these functions for every request. This module imports
    nothing from the rest of the server, and performs no I/O beyond the
    stat/resolve calls needed to follow symlinks in `resolve_static`.

Invariants:
    * `resolve_static` never returns a path outside the resolved project root,
      and never returns a path that the allowlist would refuse by name, either
      as requested or after symlinks are followed.
    * Markdown is refused everywhere except the AI prompt templates in prompts/ and en/prompts/.
    * Every refusal is a plain `False` / `None`; callers turn that into 403 or
      404. Nothing here raises for hostile input.
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import unquote

# Files served from the project root, by exact name.
STATIC_FILES: frozenset[str] = frozenset({"index.html", "manifest.json", "version.js", "sw.js", "words.json"})

# Top-level folders whose contents may be served (subject to the other rules).
STATIC_DIRS: frozenset[str] = frozenset({"css", "js", "icons", "conjugations", "courses", "en", "prompts", "words"})

# File extensions (lower case, with the dot) that may be served from STATIC_DIRS.
STATIC_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".html", ".js", ".mjs", ".css", ".json", ".webmanifest", ".svg", ".png",
        ".ico", ".jpg", ".jpeg", ".webp", ".woff2", ".txt",
    }
)

# Markdown is served only for the AI prompt templates the app fetches (./prompts/<name>.md for Czech,
# ./en/prompts/<name>.md for English). Every other .md file (README, docs) stays hidden.
PROMPT_EXTENSION = ".md"
PROMPT_FOLDERS: frozenset[tuple[str, ...]] = frozenset({("prompts",), ("en", "prompts")})

# Folder names that are never served at any depth (compared case-insensitively).
DENIED_SEGMENTS: frozenset[str] = frozenset(
    {"tools", "docs", "tests", "data", "venv", "server", "node_modules", "__pycache__"}
)

# What "/" maps to.
INDEX_FILE = "index.html"

# Host names the browser may use to reach this loopback-only server.
LOOPBACK_HOST_NAMES: tuple[str, ...] = ("127.0.0.1", "localhost", "[::1]")

# The only media type accepted for request bodies.
JSON_MEDIA_TYPE = "application/json"

# Highest code point of the ASCII control range, and DEL.
_LAST_CONTROL_CODE = 31
_DELETE_CODE = 127


def is_allowed_host(host: str | None, port: int) -> bool:
    """Tell whether a Host header names this server on a loopback address.

    Only `127.0.0.1:<port>`, `localhost:<port>` and `[::1]:<port>` pass. The
    port is mandatory and must match exactly, so look-alikes such as
    `127.0.0.1.evil.com:8768` or `evil.com` are refused (DNS rebinding defence).

    Args:
        host: Raw Host header value, or None when the header is missing.
        port: Port the server is listening on.

    Returns:
        True when the header is an allowed loopback host with the right port.

    Example:
        >>> is_allowed_host("localhost:8768", 8768)
        True
        >>> is_allowed_host("127.0.0.1.evil.com:8768", 8768)
        False
    """
    if not host:
        return False
    # Host names are case-insensitive (RFC 9110); everything else is exact.
    return host.lower() in {f"{name}:{port}" for name in LOOPBACK_HOST_NAMES}


def is_allowed_origin(origin: str | None, host: str) -> bool:
    """Tell whether an Origin header is absent or is this server's own origin.

    Args:
        origin: Raw Origin header value; None or "" means the header is absent
            (same-origin requests from some clients, or non-browser tools).
        host: The already validated Host header of the request.

    Returns:
        True when the header is absent or equals `http://<host>`.

    Example:
        >>> is_allowed_origin("http://localhost:8768", "localhost:8768")
        True
        >>> is_allowed_origin("http://evil.com", "localhost:8768")
        False
    """
    if not origin:
        return True
    return origin == f"http://{host}"


def is_json_request(content_type: str | None) -> bool:
    """Tell whether a Content-Type header declares a JSON body.

    Requiring JSON on writes keeps cross-site HTML forms (which can only send
    form or plain-text types without a CORS preflight) from reaching the API.
    Parameters such as `; charset=utf-8` are ignored.

    Args:
        content_type: Raw Content-Type header value, or None when missing.

    Returns:
        True when the media type is `application/json` (case-insensitive).

    Example:
        >>> is_json_request("application/json; charset=utf-8")
        True
        >>> is_json_request("text/plain")
        False
    """
    if not content_type:
        return False
    media_type = content_type.split(";", 1)[0].strip().lower()
    return media_type == JSON_MEDIA_TYPE


def resolve_static(root: Path, url_path: str) -> Path | None:
    """Map a raw request path onto an allowed, existing file under `root`.

    The path is cut at `?` and `#`, percent-decoded exactly once, and then every
    segment is checked against the allowlist. The candidate is finally resolved
    (following symlinks) and must still be a file inside the resolved root whose
    real location also passes the allowlist, so a symlink cannot lead out of the
    root or into a denied folder.

    Args:
        root: Project root folder that static files are served from.
        url_path: Raw request target (may be percent-encoded and may carry a
            query string or fragment), for example "/js/app.js?v=2".

    Returns:
        The resolved path of an existing, allowed file, or None for anything
        else (denied, missing, malformed, or escaping the root).

    Example:
        >>> resolve_static(Path("."), "/")  # doctest: +SKIP
        PosixPath('/project/index.html')
    """
    parts = _requested_parts(url_path)
    if parts is None or not _is_allowed_parts(parts):
        return None
    try:
        root_resolved = root.resolve(strict=True)
        # strict=True makes a missing file raise OSError; Python 3.12 reports a
        # symlink loop as RuntimeError (OSError on newer versions).
        resolved = root_resolved.joinpath(*parts).resolve(strict=True)
        # Containment check on the real location: blocks symlinks out of the root.
        real_parts = resolved.relative_to(root_resolved).parts
        is_file = resolved.is_file()
    except (OSError, RuntimeError, ValueError):
        # Missing file or over-long name (OSError), symlink loop (RuntimeError on
        # 3.12) or a location outside the root (ValueError from relative_to).
        return None
    # Re-apply the name rules to the real location: a symlink inside js/ must not
    # expose data/ or server/ either.
    if not is_file or not _is_allowed_parts(real_parts):
        return None
    return resolved


def _requested_parts(url_path: str) -> tuple[str, ...] | None:
    """Turn a raw request target into path segments, or None when malformed.

    Args:
        url_path: Raw request target, possibly percent-encoded with a query.

    Returns:
        The decoded segments (("index.html",) for "/"), or None when the path
        is not absolute, is not valid UTF-8 once decoded, contains control
        characters or backslashes, or has empty (double slash) segments.
    """
    # Cut query and fragment first, so an encoded "?" or "#" stays part of the name.
    path = url_path.split("#", 1)[0].split("?", 1)[0]
    if not path.startswith("/"):
        return None
    try:
        # One decoding pass only; strict so overlong or invalid UTF-8 is refused
        # instead of being replaced by look-alike characters.
        decoded = unquote(path, errors="strict")
    except UnicodeDecodeError:
        return None
    if "\\" in decoded or any(_is_control(char) for char in decoded):
        return None
    if decoded == "/":
        return (INDEX_FILE,)
    # Encoded slashes (%2f) are already real slashes here, so they are split and
    # every resulting segment is checked like any other.
    segments = decoded[1:].split("/")
    if any(segment == "" for segment in segments):
        return None
    return tuple(segments)


def _is_control(char: str) -> bool:
    """Tell whether a character is an ASCII control character (NUL included) or DEL."""
    return ord(char) <= _LAST_CONTROL_CODE or ord(char) == _DELETE_CODE


def _is_allowed_parts(parts: tuple[str, ...]) -> bool:
    """Apply the static allowlist to path segments relative to the root.

    Args:
        parts: Segments below the project root, for example ("js", "app.js").

    Returns:
        True when no segment is a dot segment, hidden or denied, and the file is
        either one of STATIC_FILES at the root, a file with an allowed extension
        below one of STATIC_DIRS, or a prompt template (see `_is_prompt_template`).
    """
    for part in parts:
        # "." and ".." fall under this rule too, as do dotfiles like ".env".
        if part.startswith("."):
            return False
        # Case-insensitive so the rule also holds on case-insensitive file systems.
        if part.lower() in DENIED_SEGMENTS:
            return False
    if len(parts) == 1:
        return parts[0] in STATIC_FILES
    if parts[0] not in STATIC_DIRS:
        return False
    return Path(parts[-1]).suffix.lower() in STATIC_EXTENSIONS or _is_prompt_template(parts)


def _is_prompt_template(parts: tuple[str, ...]) -> bool:
    """Tell whether segments name a Markdown prompt such as prompts/free-chat.md or en/prompts/check-write.md.

    Args:
        parts: Segments below the project root.

    Returns:
        True for a ".md" file directly inside one of PROMPT_FOLDERS (the extension is case-sensitive).
    """
    return Path(parts[-1]).suffix == PROMPT_EXTENSION and parts[:-1] in PROMPT_FOLDERS
