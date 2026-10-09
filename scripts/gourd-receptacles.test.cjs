const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const GourdReceptacles = runInNewContext(
  readFileSync(join(__dirname, '../gourd-receptacles.js'), 'utf8') + '\nGourdReceptacles');
const frame = (...gourds) => ({ gourds });
const placed = (model, slot, name = 100) => ({ ...model.slots[slot], name, state: 1, pinnedAtHome: 0 });

test('receptacles match any gourd in XYZ within a centimetre, not its ID or pinned flag', () => {
  const model = new GourdReceptacles();
  const gourd = placed(model, 0, 159);
  assert.equal(model.slotAt(gourd), 0);
  assert.equal(model.slotAt({ ...gourd, x: gourd.x + .005, y: gourd.y - .005, z: gourd.z + .005 }), 0);
  assert.equal(model.slotAt({ ...gourd, y: gourd.y + .011 }), -1, 'same map location on another floor is not placed');
  assert.equal(model.slotAt({ ...gourd, x: gourd.x + .008, z: gourd.z + .008 }), -1, 'tolerance is radial, not per-axis');
  assert.equal(model.slotAt({ ...gourd, x: NaN }), -1);
  model.setReplay([frame(gourd)]);
  assert.equal(model.at(0)[0], 159, 'occupancy retains the actual gourd ID for color');
});

test('occupancy follows observations across seeks, removal, missing frames, and replay replacement', () => {
  const model = new GourdReceptacles();
  const a = placed(model, 0, 100), b = placed(model, 1, 159);
  model.setReplay([
    frame(), frame(a), frame(), frame({ ...a, x: a.x + 2 }, b), frame(), frame(a, b), frame(),
  ]);
  for (const [index, first, second] of [[0, null, null], [1, 100, null], [2, 100, null],
    [3, null, 159], [6, 100, 159], [0, null, null], [4, null, 159], [1, 100, null]]) {
    const occupants = model.at(index);
    assert.equal(occupants[0], first, `slot 0 at frame ${index}`);
    assert.equal(occupants[1], second, `slot 1 at frame ${index}`);
  }
  model.setReplay([frame()]);
  assert.ok(model.at(0).every(name => name === null), 'previous recording must not leak');
});

test('live replay extends the history incrementally and matches a full rebuild', () => {
  const a = new GourdReceptacles(), b = new GourdReceptacles();
  const frames = [frame(), frame(placed(a, 0, 100)), frame(placed(a, 2, 159)), frame(), frame(placed(a, 0, 100))];
  b.setReplay(frames);
  for (let index = 0; index < frames.length; index++) {
    a.extend(frames.slice(0, index + 1));
    assert.equal(a.scanned, index + 1, `scanned through frame ${index}`);
    assert.deepEqual(Array.from(a.at(index)), Array.from(b.at(index)), `occupancy at frame ${index}`);
  }
  // A shorter recording (a new session, a rewind) must rebuild rather than keep stale history.
  a.extend([frame()]);
  assert.equal(a.scanned, 1);
  assert.ok(a.at(0).every(name => name === null));
});

test('moving and swapping gourds clears their old slots regardless of observation order', () => {
  for (const reverse of [false, true]) {
    const model = new GourdReceptacles();
    const a = placed(model, 0, 100), b = placed(model, 1, 159);
    const swapped = [placed(model, 1, 100), placed(model, 0, 159)];
    model.setReplay([frame(a, b), frame(...(reverse ? swapped.reverse() : swapped)),
      frame(placed(model, 2, 159), placed(model, 1, 100))]);
    assert.deepEqual(Array.from(model.at(1).slice(0, 3)), [159, 100, null]);
    assert.deepEqual(Array.from(model.at(2).slice(0, 3)), [null, 100, 159]);
    assert.deepEqual(Array.from(model.at(0).slice(0, 3)), [100, 159, null]);
  }
});
