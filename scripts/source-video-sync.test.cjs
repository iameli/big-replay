const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const buildFfmpegMosaicCommand = runInNewContext(
  readFileSync(join(__dirname, '../source-video-sync.js'), 'utf8') + '\nbuildFfmpegMosaicCommand');

const replayTeleportTime = 4137.1587931;
const replayEndTime = 4256.8036944;
const markedSourceTimes = [
  3629.515694, 3607.528694, 3612.459694, 3691.320694,
  3619.308694, 3749.158694, 3656.622694, 4055.273694,
  3604.610694, 3654.942694, 3624.008694, 3694.036694,
];
const sources = [
  { fileName: 'P1.webm', offset: -507.643 },
  { fileName: 'P2.webm', offset: -529.630 },
  { fileName: 'P3.webm', offset: -524.699 },
  { fileName: 'P4.mkv', offset: -445.838 },
  { fileName: 'P5.mkv', offset: -517.850 },
  { fileName: 'P6.mkv', offset: -388.000 },
  { fileName: 'P7.mkv', offset: -480.536 },
  { fileName: 'P8.webm', offset: -81.885 },
  { fileName: 'P9.mkv', offset: -532.548 },
  { fileName: 'P10.webm', offset: -482.216 },
  { fileName: 'P11.webm', offset: -513.150 },
  { fileName: 'P12.webm', offset: -443.122 },
];

test('supplied Big Game timings generate a P1-P12 aligned mosaic command', () => {
  const command = buildFfmpegMosaicCommand(sources, replayEndTime);
  const inputFiles = [...command.matchAll(/-i '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(inputFiles, sources.map(source => source.fileName));

  const delays = [...command.matchAll(/start_duration=(\d+\.\d+)/g)]
    .map(match => Number(match[1]));
  assert.deepEqual(delays, sources.map(source => -source.offset));
  markedSourceTimes.forEach((sourceTeleportTime, index) => {
    assert.ok(Math.abs(sourceTeleportTime + delays[index] - replayTeleportTime) < 0.001);
  });

  assert.doesNotMatch(command, /trim=start=/);
  assert.match(command, /-t 4256\.804/);
  assert.match(command, /\[v0\]\[v1\]\[v2\]\[v3\]\[v4\]\[v5\]\[v6\]\[v7\]\[v8\]\[v9\]\[v10\]\[v11\]xstack=inputs=12/);
  assert.match(command, /layout=0_0\|640_0\|1280_0\|1920_0\|0_360\|640_360\|1280_360\|1920_360\|0_720\|640_720\|1280_720\|1920_720/);
  assert.match(command, /-c:v libx264 -preset medium -crf 20/);
  assert.ok(command.endsWith("'big-replay-4x3-synced.mp4'"));
});

test('a source that starts before replay time zero is trimmed and filenames are PowerShell-safe', () => {
  const earlySources = sources.map(source => ({ ...source, offset: 0 }));
  earlySources[0] = { fileName: "P1 O'Brien.webm", offset: 1.25 };
  const command = buildFfmpegMosaicCommand(earlySources, replayEndTime);
  assert.match(command, /-i 'P1 O''Brien\.webm'/);
  assert.match(command, /\[0:v\]trim=start=1\.250,setpts=PTS-STARTPTS/);
  assert.match(command, /\[0:v\].*start_duration=0\.000/);
});

test('mosaic command generation rejects incomplete or invalid inputs', () => {
  assert.throws(() => buildFfmpegMosaicCommand(sources.slice(1), replayEndTime), /exactly 12/);
  assert.throws(() => buildFfmpegMosaicCommand(sources, 0), /positive number/);
  assert.throws(() => buildFfmpegMosaicCommand(
    sources.map((source, index) => index === 3 ? { ...source, offset: NaN } : source),
    replayEndTime,
  ), /finite offset/);
});
