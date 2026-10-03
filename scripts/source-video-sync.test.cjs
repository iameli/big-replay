const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const { buildFfmpegMosaicCommand, ffmpegMosaicStartTime } = runInNewContext(
  readFileSync(join(__dirname, '../source-video-sync.js'), 'utf8')
    + '\n({ buildFfmpegMosaicCommand, ffmpegMosaicStartTime })');

const replayTeleportTime = 4137.1587931;
const replayEndTime = 4256.8036944;
const markedSourceTimes = [
  3629.515694, 3607.528694, 3612.459694, 3691.320694,
  3619.308694, 3749.158694, 3656.622694, 4055.273694,
  3604.610694, 3654.942694, 3624.008694, 3694.036694,
];
const sources = [
  { fileName: 'P1.webm', title: 'P1 Rando', offset: -507.643 },
  { fileName: 'P2.webm', title: 'P2 Agnes Tachyon', offset: -529.630 },
  { fileName: 'P3.webm', title: 'P3 Vilto84', offset: -524.699 },
  { fileName: 'P4.mkv', title: 'P4 CaRawZoh', offset: -445.838 },
  { fileName: 'P5.mkv', title: 'P5 iameli', offset: -517.850 },
  { fileName: 'P6.mkv', title: 'P6 Ravioley', offset: -388.000 },
  { fileName: 'P7.mkv', title: 'P7 Turtley78', offset: -480.536 },
  { fileName: 'P8.webm', title: 'P8 Me!', offset: -81.885 },
  { fileName: 'P9.mkv', title: 'P9 Timon', offset: -532.548 },
  { fileName: 'P10.webm', title: 'P10 horalky', offset: -482.216 },
  { fileName: 'P11.webm', title: 'P11 Herb2005', offset: -513.150 },
  { fileName: 'P12.webm', title: 'P12 xCape', offset: -443.122 },
];

test('supplied Big Game timings generate a compact P1-P12 aligned mosaic command', () => {
  const command = buildFfmpegMosaicCommand(sources, replayEndTime);
  const inputFiles = [...command.matchAll(/-i '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(inputFiles, sources.map(source => source.fileName));

  const startTime = ffmpegMosaicStartTime(sources);
  assert.equal(startTime, 532.548);
  const sourceTrims = [...command.matchAll(/\[\d+:v\]trim=start=(\d+\.\d+)/g)]
    .map(match => Number(match[1]));
  assert.deepEqual(sourceTrims, [
    24.905, 2.918, 7.849, 86.710, 14.698, 144.548,
    52.012, 450.663, 0, 50.332, 19.398, 89.426,
  ]);
  markedSourceTimes.forEach((sourceTeleportTime, index) => {
    assert.ok(Math.abs(
      sourceTeleportTime - sourceTrims[index] - (replayTeleportTime - startTime),
    ) < 0.001);
  });

  const audioTrims = [...command.matchAll(/\[\d+:a:0\]atrim=start=(\d+\.\d+)/g)]
    .map(match => Number(match[1]));
  assert.deepEqual(audioTrims, sourceTrims);
  assert.deepEqual(
    [...command.matchAll(/-map '\[a(\d+)\]'/g)].map(match => Number(match[1])),
    [...sources.keys()],
  );

  assert.doesNotMatch(command, /start_duration=/);
  assert.match(command, /-t 3724\.256/);
  assert.match(command, /\[v0\]\[v1\]\[v2\]\[v3\]\[v4\]\[v5\]\[v6\]\[v7\]\[v8\]\[v9\]\[v10\]\[v11\]xstack=inputs=12/);
  assert.match(command, /layout=0_0\|640_0\|1280_0\|1920_0\|0_360\|640_360\|1280_360\|1920_360\|0_720\|640_720\|1280_720\|1920_720/);
  assert.match(command, /-c:v libx264 -preset medium -crf 20/);
  assert.match(command, /-c:a aac -b:a 160k/);
  assert.match(command, /-metadata:s:a:0 'title=P1 Rando' -disposition:a:0 default/);
  assert.match(command, /-metadata:s:a:11 'title=P12 xCape' -disposition:a:11 0/);
  assert.doesNotMatch(command, / -an /);
  assert.ok(command.endsWith("'big-replay-4x3-synced.mp4'"));
});

test('all sources are trimmed to the common mosaic start and filenames are PowerShell-safe', () => {
  const earlySources = sources.map(source => ({ ...source, offset: 0 }));
  earlySources[0] = { fileName: "P1 O'Brien.webm", title: "P1 O'Brien", offset: 1.25 };
  const command = buildFfmpegMosaicCommand(earlySources, replayEndTime);
  assert.equal(ffmpegMosaicStartTime(earlySources), 0);
  assert.match(command, /-i 'P1 O''Brien\.webm'/);
  assert.match(command, /-metadata:s:a:0 'title=P1 O''Brien'/);
  assert.match(command, /\[0:v\]trim=start=1\.250,setpts=PTS-STARTPTS/);
  assert.doesNotMatch(command, /start_duration=/);
});

test('mosaic command generation rejects incomplete or invalid inputs', () => {
  assert.throws(() => buildFfmpegMosaicCommand(sources.slice(1), replayEndTime), /exactly 12/);
  assert.throws(() => buildFfmpegMosaicCommand(sources, 0), /positive number/);
  assert.throws(() => buildFfmpegMosaicCommand(
    sources.map((source, index) => index === 3 ? { ...source, offset: NaN } : source),
    replayEndTime,
  ), /finite offset/);
  assert.throws(() => buildFfmpegMosaicCommand(
    sources.map(source => ({ ...source, offset: -5000 })),
    replayEndTime,
  ), /do not overlap/);
});
