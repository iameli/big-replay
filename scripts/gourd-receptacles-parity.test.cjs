const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

const js = runInNewContext(
  readFileSync(join(__dirname, '../gourd-receptacles.js'), 'utf8') + '\nGOURD_RECEPTACLE_GROUPS');
const csharp = readFileSync(join(__dirname, '../src/Replay.Format/GourdReceptacles.cs'), 'utf8');

function csharpGroupNames() {
  const block = csharp.match(/GroupNames\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(block, 'GroupNames table found');
  return [...block[1].matchAll(/"([^"]*)"/g)].map(match => match[1]);
}

function csharpSlotNumbers() {
  const start = csharp.indexOf('GroupPositions =');
  assert.ok(start >= 0, 'GroupPositions table found');
  const end = csharp.indexOf('\n    ];', start);
  assert.ok(end > start, 'GroupPositions table has an end');
  const body = csharp.slice(start, end).replace(/\/\/.*$/gm, '');
  return [...body.matchAll(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)].map(match => Number(match[0]));
}

test('C# receptacle table matches the viewer table exactly', () => {
  const names = csharpGroupNames();
  assert.deepEqual(names, Array.from(js, group => group.name));

  const numbers = csharpSlotNumbers();
  const expected = Array.from(js.flatMap(group => group.positions.flat()));
  for (let i = 0; i < expected.length; i++) {
    assert.equal(numbers[i], expected[i], `coordinate ${i} (${names[Math.floor(i / 3)]})`);
  }
});

test('C# tolerance matches the viewer', () => {
  const tolerance = csharp.match(/Tolerance\s*=\s*([\d.]+)/);
  assert.ok(tolerance, 'Tolerance constant found');
  assert.equal(Number(tolerance[1]), 0.01);
});
