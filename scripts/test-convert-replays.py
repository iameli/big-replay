"""Run with python scripts/test-convert-replays.py (no dependencies)."""
import gzip
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest


CLI = Path(__file__).with_name("convert-replays.py")


def run(*args):
    return subprocess.run([sys.executable, CLI, *args], capture_output=True, text=True)


def exact(text):
    # Do not use ordinary Python numeric equality: -0 == 0 == False, and
    # distinct long decimal tokens can round to the same binary64 value.
    def token(s):
        return ("number", s)
    return json.loads(text, parse_int=token, parse_float=token)


def expand(text):
    records = list(map(exact, text.splitlines()))
    result = {**records.pop(0), "frames": [], "events": []}
    previous = {key: [] for key in ("players", "gourds", "monuments")}
    for record in records:
        if "event" in record:
            result["events"].append(record["event"])
            continue
        delta = record["frame"]
        for key in previous:
            if key not in delta:
                continue
            count, *pairs = delta[key]
            n = int(count[1]); values = (previous[key] + [None] * n)[:n]
            for i, obj in zip(pairs[::2], pairs[1::2]):
                values[int(i[1])] = obj
            previous[key] = values
        result["frames"].append({"time": delta["time"], **previous})
    return result


class ConverterTest(unittest.TestCase):
    def test_sparse_migration_preserves_tokens_and_order(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp); folder = root / "sub"; folder.mkdir()
            path = folder / "walk.replay.json-1.gz"
            first = '{"time":-0,"players":[],"monuments":[],"gourds":[{"name":101,"x":-0,"y":1.12345678901234567801,"z":"NaN","extra":false},{"name":101,"x":9007199254740993}]}'
            second = first.replace('"time":-0', '"time":1e-8').replace('"x":-0', '"x":0').replace('67801', '67802').replace('false', '0')
            events = '[{"time":2,"type":"a","detail":null},{"time":1,"type":"b"},{"time":1,"type":"b"}]'
            # Non-recorder member order, duplicate identities, exact decimal change,
            # unchanged frame, truncation, and a value spanning decoder chunks.
            source = '{"events":' + events + ',"frames":[' + ','.join((first, second, second, '{"time":3,"players":[],"monuments":[],"gourds":[]}')) + '],"header":{"formatVersion":1,"label":' + json.dumps("雪\n" * 20000) + '}}'
            original = gzip.compress(source.encode()); path.write_bytes(original)
            proc = run(root)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            out = folder / "walk.replay-1.jsonl.gz"
            contents = out.read_bytes(); lines = gzip.decompress(contents).decode()
            want = exact(source); want['header']['formatVersion'] = ('number', '2')
            self.assertEqual(expand(lines), want)
            self.assertIn({"frame": {"time": 1e-8}}, [json.loads(s) for s in lines.splitlines()])
            self.assertEqual(path.read_bytes(), original)
            again = run(root)
            self.assertEqual(again.returncode, 0, again.stderr)
            self.assertIn("already verified", again.stdout)
            self.assertEqual(out.read_bytes(), contents)
            # Valid v2 data that differs only below double precision is NOT a match.
            stale = gzip.compress(lines.replace('67802', '67801').encode()); out.write_bytes(stale)
            self.assertNotEqual(run(root).returncode, 0)
            self.assertEqual(out.read_bytes(), stale)
            self.assertEqual(path.read_bytes(), original)

    def test_existing_output_must_match_all_committed_records(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / 'custom-name.json'
            frame = '{"time":0,"players":[],"gourds":[],"monuments":[]}'
            path.write_text('{"frames":[' + frame + '],"events":[],"header":{"formatVersion":1}}',
                            encoding='utf-8-sig')
            result = run('--plain', path)
            self.assertEqual(result.returncode, 0, result.stderr)
            out = path.with_suffix('.jsonl')
            good = out.read_bytes()
            for broken in (good[:-1], good[:good.index(b'\n') + 1],
                           good + b'{"event":{"time":2,"type":"extra"}}\n',
                           good.replace(b'"time":0', b'"time":0,"players":[1]')):
                with self.subTest(broken=broken):
                    out.write_bytes(broken)
                    self.assertNotEqual(run('--plain', path).returncode, 0)
                    self.assertEqual(out.read_bytes(), broken)

    def test_batch_refuses_data_loss_without_blocking_other_recordings(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            valid = '{"header":{"formatVersion":1},"frames":[],"events":[]}'
            invalid = [valid[:-1], valid.replace('"frames":[]', '"frames":[],"newData":5'),
                       valid.replace('"events":[]', '"events":[],"events":[]'),
                       valid.replace('"frames":[]', '"frames":[{"time":1,"players":[],"gourds":[],"monuments":[],"weather":1}]')]
            for i, text in enumerate(invalid):
                (root / f"bad{i}.replay.json").write_text(text)
            (root / 'broken.replay.json.gz').write_bytes(gzip.compress(valid.encode())[:-1])
            (root / 'active.replay.json.gz.partial').write_bytes(b'unfinished')
            (root / 'z.replay.json').write_text(valid)
            result = run('--plain', root)
            self.assertEqual(result.returncode, 1)
            self.assertIn('1 verified, 5 failed', result.stdout)
            self.assertEqual([p.name for p in root.glob('*.jsonl')], ['z.replay.jsonl'])
            self.assertFalse(list(root.glob('*.tmp')))
            self.assertEqual((root/'active.replay.json.gz.partial').read_bytes(), b'unfinished')


if __name__ == '__main__':
    unittest.main()
