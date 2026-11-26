const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const mapView = readFileSync(join(__dirname, '../map-view.js'), 'utf8');
const csharp = readFileSync(join(__dirname, '../src/Replay.Format/EndgameTeleport.cs'), 'utf8');

function jsRoom() {
  const match = mapView.match(/const SECRET_ROOM = Object\.freeze\(\{([^}]*)\}\)/);
  assert.ok(match, 'SECRET_ROOM found');
  const values = {};
  for (const entry of match[1].matchAll(/(\w+)\s*:\s*(-?[\d.]+)/g)) {
    values[entry[1]] = Number(entry[2]);
  }
  return values;
}

function csharpRoom() {
  const values = {};
  for (const entry of csharp.matchAll(/public const float (Min|Max)([XYZ]) = (-?[\d.]+)/g)) {
    values[`${entry[1].toLowerCase()}${entry[2]}`] = Number(entry[3]);
  }
  return values;
}

test('C# endgame room matches the viewer box exactly', () => {
  assert.deepEqual(csharpRoom(), jsRoom());
});

test('finish trigger uses one player, not the viewer sync consensus', () => {
  const threshold = csharp.match(/MinimumPlayers = (\d+)/);
  assert.ok(threshold, 'MinimumPlayers constant found');
  assert.equal(Number(threshold[1]), 1);
  assert.ok(mapView.includes('BIG_TELEPORT_CONSENSUS = 0.8'),
    'viewer still uses its 80% sync consensus');
});
