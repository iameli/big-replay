#!/usr/bin/env python3
"""Convert legacy Big Replay recordings to verified sparse v2 copies."""
import argparse
from contextlib import closing, nullcontext
import gzip
import os
from pathlib import Path
import re
import sys
import tempfile
import zlib

from replay_conversion import encode_records, verify_records
from replay_legacy import encode_json, legacy_records


# Old recorder collisions could produce names such as walk.replay.json-1-2.gz.
LEGACY_NAME = re.compile(r"\.replay(?:-\d+)*\.json(?:-\d+)*(?:\.gz)?$", re.IGNORECASE)
LEGACY_SUFFIX = re.compile(r"\.json((?:-\d+)*)(?:\.gz)?$", re.IGNORECASE)


def sources(path):
    if path.is_file():
        if not LEGACY_SUFFIX.search(path.name):
            raise ValueError("expected a finished .json or .json.gz recording")
        yield path
    elif path.is_dir():
        def onerror(error):
            raise error
        for root, dirs, files in os.walk(path, onerror=onerror):
            dirs.sort()
            for name in sorted(files):
                if LEGACY_NAME.search(name):
                    yield Path(root) / name
    else:
        raise ValueError("not a file or directory")


def header_first(path):
    # Recorder order needs only one pass. JSON object members may be reordered by
    # other tools: find their header, then rewind instead of buffering the frames.
    with closing(legacy_records(path)) as records:
        first = next(records, None)
        if first and first[0] == "header":
            yield first
            yield from records
            return
        header = next((r for r in records if r[0] == "header"), None)
    if header is None:
        raise ValueError("missing v1 header")
    yield header
    with closing(legacy_records(path)) as records:
        for record in records:
            if record[0] != "header":
                yield record


def verify(source, output, compressed):
    opener = gzip.open if compressed else open
    with opener(output, "rt", encoding="utf-8", newline="") as lines, closing(header_first(source)) as records:
        verify_records(records, lines)


def convert(source, plain):
    suffix = ".jsonl" if plain else ".jsonl.gz"
    target = source.with_name(LEGACY_SUFFIX.sub(lambda m: (m[1] or "") + suffix, source.name))
    if target.exists():
        verify(source, target, not plain)  # A name collision is not proof of a prior conversion.
        return "already verified", target

    temp = tempfile.NamedTemporaryFile(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent, delete=False)
    staging = Path(temp.name)
    try:
        with temp, closing(header_first(source)) as records:
            wrapper = nullcontext(temp) if plain else gzip.GzipFile(filename="", mode="wb", fileobj=temp, mtime=0, compresslevel=6)
            with wrapper as out:
                for record in encode_records(records):
                    out.write((encode_json(record) + "\n").encode("utf-8"))
            temp.flush()
            os.fsync(temp.fileno())
        verify(source, staging, not plain)
        # Publish a completed file only. Both operations fail if a concurrent
        # converter created the destination during verification; never replace it.
        if os.name == "nt":
            os.rename(staging, target)
        else:
            os.link(staging, target)
    finally:
        staging.unlink(missing_ok=True)
    return "converted and verified", target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", type=Path, help="v1 file(s) or directories to search recursively")
    parser.add_argument("--plain", action="store_true", help="write uncompressed .jsonl instead of .jsonl.gz")
    args = parser.parse_args()
    ok = failed = 0
    for path in args.paths:
        try:
            for source in sources(path):
                try:
                    status, target = convert(source, args.plain)
                    print(f"{status}: {source} -> {target}")
                    ok += 1
                except (ValueError, OSError, EOFError, zlib.error, RecursionError) as error:
                    print(f"FAILED: {source}: {error}", file=sys.stderr)
                    failed += 1
        except (ValueError, OSError) as error:
            print(f"FAILED: {path}: {error}", file=sys.stderr)
            failed += 1
    if not ok and not failed:
        print("No finished legacy replay files found.", file=sys.stderr)
    print(f"{ok} verified, {failed} failed. Originals unchanged.")
    return 1 if failed or not ok else 0


if __name__ == "__main__":
    sys.exit(main())
