const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const { MosaicVideo, replayFrameIndexAtOrAfter, streamplacePlaylistUrl } = runInNewContext(
  readFileSync(join(__dirname, '../mosaic-video.js'), 'utf8')
    + '\n({ MosaicVideo, replayFrameIndexAtOrAfter, streamplacePlaylistUrl })',
  { encodeURIComponent, HTMLMediaElement: { HAVE_CURRENT_DATA: 2 } },
);

test('Streamplace video AT URIs become encoded HLS playlist requests', () => {
  assert.equal(
    streamplacePlaylistUrl('at://did:plc:abc/place.stream.video/3mxyz'),
    'https://stream.place/xrpc/place.stream.playback.getVideoPlaylist?uri=at%3A%2F%2Fdid%3Aplc%3Aabc%2Fplace.stream.video%2F3mxyz',
  );
});

test('replay start finds the first frame represented by the mosaic video', () => {
  const frames = [{ time: 519.8 }, { time: 532.5 }, { time: 532.6 }, { time: 600 }];
  assert.equal(replayFrameIndexAtOrAfter(frames, 532.548), 2);
  assert.equal(replayFrameIndexAtOrAfter(frames, 519.8), 0);
  assert.equal(replayFrameIndexAtOrAfter(frames, 999), 3);
});

test('mosaic playback maps replay timestamps through the persisted start time', () => {
  let clears = 0, draws = 0;
  const mosaic = Object.create(MosaicVideo.prototype);
  mosaic.ready = true;
  mosaic.timelineStart = 532.548;
  mosaic.targetTime = 0;
  mosaic.shouldPlay = false;
  mosaic.rate = 1;
  mosaic.video = {
    readyState: 2,
    duration: 3724.256,
    currentTime: 0,
    playbackRate: 1,
    paused: true,
    videoWidth: 2560,
    videoHeight: 1080,
    pause() { this.paused = true; },
  };
  mosaic.tiles = Array.from({ length: 12 }, () => ({
    canvas: { width: 640, height: 360 },
    context: {
      clearRect() { clears++; },
      drawImage() { draws++; },
    },
  }));

  mosaic.sync(600, false, 1, true);
  assert.ok(Math.abs(mosaic.video.currentTime - 67.452) < 0.000001);
  assert.equal(draws, 12);
  mosaic.sync(500, false, 1, true);
  assert.equal(clears, 12);
});

test('mosaic seek completion waits for the latest target before resuming', async () => {
  const listeners = new Map();
  const video = {
    _currentTime: 0,
    seeking: false,
    duration: 3724.256,
    get currentTime() { return this._currentTime; },
    set currentTime(value) {
      this._currentTime = value;
      this.seeking = true;
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };
  const mosaic = Object.assign(Object.create(MosaicVideo.prototype), {
    ready: true,
    loadToken: 1,
    timelineStart: 532.548,
    targetTime: 600,
    video,
  });

  const settled = mosaic.waitForSeek();
  assert.equal(video.seeking, true);
  assert.ok(Math.abs(video.currentTime - 67.452) < 0.000001);
  video.seeking = false;
  for (const listener of [...listeners.get('seeked')]) listener();
  await settled;
  assert.equal(listeners.get('seeked').size, 0);
});
