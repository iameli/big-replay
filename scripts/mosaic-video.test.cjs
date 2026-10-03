const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const streamplacePlaylistUrl = runInNewContext(
  readFileSync(join(__dirname, '../mosaic-video.js'), 'utf8') + '\nstreamplacePlaylistUrl',
  { encodeURIComponent },
);

test('Streamplace video AT URIs become encoded HLS playlist requests', () => {
  assert.equal(
    streamplacePlaylistUrl('at://did:plc:abc/place.stream.video/3mxyz'),
    'https://stream.place/xrpc/place.stream.playback.getVideoPlaylist?uri=at%3A%2F%2Fdid%3Aplc%3Aabc%2Fplace.stream.video%2F3mxyz',
  );
});
