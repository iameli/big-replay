"""Stream full v1 samples into sparse v2 records and verify their logical contents."""

import math
from decimal import Decimal, InvalidOperation

from replay_legacy import Number, decode_json
from replay_sparse import COLLECTIONS, apply_patch, frame_delta


_FRAME_FIELDS = {"time", *COLLECTIONS}
_V2 = Number("2")


def _integer(value):
    # Both the viewer (finite JS numbers) and the merge tool (JSON integer
    # tokens) must accept replacements. Never store this parsed value in an item.
    if not isinstance(value, Number) or not math.isfinite(float(value.text)):
        raise ValueError("expected a finite JSON integer")
    try:
        return int(value.text)
    except ValueError:
        raise ValueError("expected a JSON integer token") from None


def _validate_time(payload):
    time = payload.get("time") if isinstance(payload, dict) else None
    if not isinstance(time, Number) or not math.isfinite(float(time.text)):
        raise ValueError("expected a finite numeric time")


def _validate_frame(frame):
    _validate_time(frame)
    if frame.keys() != _FRAME_FIELDS:
        missing = sorted(_FRAME_FIELDS - frame.keys())
        extra = sorted(frame.keys() - _FRAME_FIELDS)
        raise ValueError(f"unexpected frame fields (missing: {missing}, extra: {extra})")
    for key, identity in COLLECTIONS.items():
        items = frame[key]
        if not isinstance(items, list):
            raise ValueError(f"expected an array for {key}")
        for i, item in enumerate(items):
            try:
                _integer(item.get(identity) if isinstance(item, dict) else None)
            except ValueError as error:
                raise ValueError(f"{key}[{i}].{identity}: {error}") from error


def _validate_event(event):
    _validate_time(event)
    if not isinstance(event.get("type"), str):
        raise ValueError("expected a string event type")
    if event.get("detail") is not None and not isinstance(event["detail"], str):
        raise ValueError("expected a string or null event detail")


def _validated_source(records):
    records = iter(records)
    first = next(records, None)
    if first is None or first[0] != "header" or not isinstance(first[1], dict):
        raise ValueError("expected a v1 header first")
    version = first[1].get("formatVersion")
    try:
        is_v1 = isinstance(version, Number) and Decimal(version.text) == 1
    except InvalidOperation:
        is_v1 = False
    if not is_v1:
        raise ValueError("expected v1 header.formatVersion = 1")
    yield first
    for number, (kind, payload) in enumerate(records, 2):
        try:
            if kind == "frame":
                _validate_frame(payload)
            elif kind == "event":
                _validate_event(payload)
            else:
                raise ValueError(f"unexpected record kind: {kind}")
        except ValueError as error:
            raise ValueError(f"source record {number} ({kind}): {error}") from error
        yield kind, payload


def encode_records(records):
    """Yield records in source order, with only changed collection slots on disk."""
    previous = {key: [] for key in COLLECTIONS}
    for kind, payload in _validated_source(records):
        if kind == "header":
            yield {"header": dict(payload, formatVersion=_V2)}
        elif kind == "frame":
            yield {"frame": frame_delta(previous, payload)}
            previous = payload
        else:
            yield {"event": payload}


def verify_records(source_records, lines):
    """Decode every committed line and compare it with the corresponding full v1 record."""
    lines = iter(lines)
    previous = {key: [] for key in COLLECTIONS}
    for number, (kind, source) in enumerate(_validated_source(source_records), 1):
        line = next(lines, None)
        if line is None:
            raise ValueError(f"missing output line {number} ({kind})")
        try:
            if not line.endswith("\n") or line.find("\n") != len(line) - 1:
                raise ValueError("expected a single LF-terminated record")
            record = decode_json(line)
            if not isinstance(record, dict) or record.keys() != {kind}:
                raise ValueError(f"expected only {kind}")
            actual = record[kind]
            if kind == "header":
                source = dict(source, formatVersion=_V2)
            elif kind == "frame":
                _validate_time(actual)
                if actual.keys() - _FRAME_FIELDS:
                    raise ValueError("unknown sparse frame field")
                frame = {"time": actual["time"]}
                for key, identity in COLLECTIONS.items():
                    frame[key] = (apply_patch(previous[key], actual[key], identity, _integer)
                                  if key in actual else previous[key])
                actual = previous = frame
            # All input numbers are Number objects (including when nested), so
            # equality distinguishes true from 1 and even -0 from 0.
            if actual != source:
                raise ValueError(f"decoded {kind} differs from source")
        except ValueError as error:
            raise ValueError(f"output line {number}: {error}") from error
    if next(lines, None) is not None:
        raise ValueError("extra data after last output record")
