"""Strict, record-at-a-time JSON I/O for legacy Big Replay files."""
from dataclasses import dataclass
import gzip
from io import TextIOWrapper
import json
from pathlib import Path
import re


@dataclass(frozen=True)
class Number:
    """An original JSON number token, never rounded or normalized."""
    __slots__ = ("text",)
    text: str


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON member {key!r}")
        result[key] = value
    return result


def _not_json_number(text):
    raise ValueError(f"invalid JSON number {text!r}")


_DECODER = json.JSONDecoder(parse_int=Number, parse_float=Number,
                            parse_constant=_not_json_number, object_pairs_hook=_object)


def decode_json(text: str):
    return _DECODER.decode(text)


def _emit(item, parts):
    if isinstance(item, Number):
        parts.append(item.text)
    elif isinstance(item, dict):
        parts.append("{")
        for index, (key, child) in enumerate(item.items()):
            if not isinstance(key, str):
                raise TypeError("JSON object key must be a string")
            if index:
                parts.append(",")
            parts.append(json.dumps(key))
            parts.append(":")
            _emit(child, parts)
        parts.append("}")
    elif isinstance(item, (list, tuple)):
        parts.append("[")
        for index, child in enumerate(item):
            if index:
                parts.append(",")
            _emit(child, parts)
        parts.append("]")
    else:
        parts.append(json.dumps(item, ensure_ascii=True, allow_nan=False))


def encode_json(value) -> str:
    """Encode a JSON tree compactly, emitting Number tokens without quotes."""
    parts = []
    _emit(value, parts)
    return "".join(parts)


_CHUNK = 64 * 1024
_NONSPACE = re.compile(r"[^ \t\n\r]")
_STRUCTURAL = re.compile(r'[][{}"\\]')
_SCALAR_END = re.compile(r"[ \t\n\r,\]}:]")


class _Reader:
    def __init__(self, stream):
        self.stream = stream
        self.buf = ""
        self.pos = 0

    def refill(self):
        self.buf = self.stream.read(_CHUNK)
        self.pos = 0
        return bool(self.buf)

    def peek(self):
        """Consume JSON whitespace; return the next character or '' at EOF."""
        while True:
            match = _NONSPACE.search(self.buf, self.pos)
            if match:
                self.pos = match.start()
                return self.buf[self.pos]
            if not self.refill():
                return ""

    def take(self, char):
        if self.peek() != char:
            return False
        self.pos += 1
        return True

    def expect(self, char):
        if not self.take(char):
            raise ValueError(f"expected {char!r} in legacy replay")

    def value(self):
        first = self.peek()
        if not first:
            raise ValueError("expected JSON value, got end of file")
        structured = first in '[{"'
        if structured:
            # In the usual case one record fits in the remaining buffer. Its
            # closing delimiter is unambiguous, unlike a number ending at EOF.
            try:
                value, self.pos = _DECODER.raw_decode(self.buf, self.pos)
                return value
            except json.JSONDecodeError:
                pass  # May span chunks; isolate it before decoding again.

        pieces = []
        depth = 0
        quoted = False
        skip_until = 0  # An escaped character may start the next chunk.
        while True:
            end = None
            if structured:
                # Only find the end; the standard decoder validates all syntax.
                for match in _STRUCTURAL.finditer(self.buf, self.pos):
                    if match.start() < skip_until:
                        continue
                    char = match[0]
                    if quoted:
                        if char == "\\":
                            skip_until = match.end() + 1
                        elif char == '"':
                            quoted = False
                    elif char == '"':
                        quoted = True
                    elif char in "[{":
                        depth += 1
                    elif char in "]}":
                        depth -= 1
                    if not quoted and depth == 0:
                        end = match.end()
                        break
            else:
                match = _SCALAR_END.search(self.buf, self.pos)
                if match:
                    end = match.start()

            if end is not None:
                pieces.append(self.buf[self.pos:end])
                self.pos = end
                break
            pieces.append(self.buf[self.pos:])
            skip_until = max(0, skip_until - len(self.buf))
            if not self.refill():
                if structured:
                    raise ValueError("unterminated JSON value in legacy replay")
                break
        return decode_json("".join(pieces))

    def records(self):
        self.expect("{")
        seen = set()
        if not self.take("}"):
            while True:
                if self.peek() != '"':
                    raise ValueError("expected a legacy replay member name")
                key = self.value()
                if key not in {"header", "frames", "events"}:
                    raise ValueError(f"unknown legacy replay member {key!r}")
                if key in seen:
                    raise ValueError(f"duplicate legacy replay member {key!r}")
                seen.add(key)
                self.expect(":")
                if key == "header":
                    yield "header", self.value()
                else:
                    kind = "frame" if key == "frames" else "event"
                    self.expect("[")
                    if not self.take("]"):
                        while True:
                            yield kind, self.value()
                            if self.take("]"):
                                break
                            self.expect(",")
                if self.take("}"):
                    break
                self.expect(",")
        missing = {"header", "frames", "events"} - seen
        if missing:
            raise ValueError("missing legacy replay members: " + ", ".join(sorted(missing)))
        if self.peek():  # Read through the gzip trailer, validating CRC on exhaustion.
            raise ValueError("trailing data after legacy replay")


def legacy_records(path: Path):
    """Yield (kind, payload) pairs from gzip or plain v1 JSON in member order."""
    with path.open("rb") as raw:
        magic = raw.read(2)
        raw.seek(0)
        stream = gzip.GzipFile(fileobj=raw, mode="rb") if magic == b"\x1f\x8b" else raw
        with TextIOWrapper(stream, encoding="utf-8-sig", errors="strict", newline="") as text:
            yield from _Reader(text).records()
