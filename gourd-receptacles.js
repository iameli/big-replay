"use strict";

// Game 1.5.1: final occupied positions in the reconciled 12-player full run.
// Reference SHA-256: 934cde4f06c81141c80834ed6e0d72195dbe7ca04650f47e2b5021a703db3bf3.
// Slots are positions, not gourd IDs: any gourd can fill any receptacle.
const GOURD_RECEPTACLE_GROUPS = [
  { name: "Tutorial", positions: [
    [-378.0273, 3.1100001, -710.4163],
    [-377.8072, 3.1100001, -709.85815],
    [-377.58707, 3.1100001, -709.3],
    [-377.3669, 3.1100001, -708.7418],
  ] },
  { name: "Red", positions: [
    [-90.71129, 101.369995, -605.85815],
    [-90.13241, 101.369995, -605.59735],
    [-89.52607, 101.369995, -605.40906],
    [-88.9013, 101.369995, -605.2961],
    [-88.26742, 101.369995, -605.2601],
  ] },
  { name: "Green", positions: [
    [450.72235, 116.909996, -448.64194],
    [451.03647, 116.909996, -449.1937],
    [451.41547, 116.909996, -449.70306],
    [451.85373, 116.909996, -450.16245],
    [452.3447, 116.909996, -450.565],
  ] },
  { name: "Blue", positions: [
    [139.21765, 116.729996, -197.96428],
    [139.8495, 116.729996, -198.02646],
    [140.46907, 116.729996, -198.16519],
    [141.06711, 116.729996, -198.37839],
    [141.6347, 116.729996, -198.66287],
  ] },
  { name: "Yellow", positions: [
    [-232.68297, 135.9, -241.8549],
    [-232.22488, 135.9, -242.29454],
    [-231.71666, 135.9, -242.67506],
    [-231.16583, 135.9, -242.99081],
    [-230.58064, 135.9, -243.23708],
  ] },
  { name: "Black", positions: [
    [-32.255337, 117.32, -285.98932],
    [-31.869665, 117.32, -285.5297],
    [-31.483994, 117.32, -285.07007],
    [-31.09832, 117.32, -284.6104],
    [-30.712646, 117.32, -284.1508],
    [-30.326975, 117.32, -283.69116],
  ] },
  { name: "Storage", positions: [
    [-122.04227, 46.1063, -444.98605],
    [-121.725685, 46.1063, -445.76334],
    [-121.5346, 46.1063, -446.58054],
    [-128.45128, 47.1063, -440.68274],
    [-127.622215, 47.1063, -440.53415],
    [-126.78123, 47.1063, -440.4877],
    [-124.27566, 47.1063, -453.79724],
    [-123.513306, 47.1063, -453.43912],
    [-122.80028, 47.1063, -452.99078],
    [-122.83191, 48.1063, -441.75864],
    [-122.17584, 48.1063, -442.28687],
    [-121.58905, 48.1063, -442.89108],
    [-120.31282, 48.1063, -449.6704],
    [-120.08294, 48.1063, -448.8601],
    [-119.95352, 48.1063, -448.02783],
  ] },
];

// Display names for the 45 world gourds, pre-populated from MapGenie's puzzle
// locations (category_id 27066) by fitting their latitude/longitude to this map.
// Every pair matched within ~15 m. "Locked Box" uses its linked box marker
// (location 930216), which lands ~1.5 m from gourd 116; the puzzle marker itself
// is at the button across the valley.
const GOURD_NAMES = Object.freeze({
  100: "Little Patience",
  101: "Tutorial Crane",
  103: "Cannon",
  104: "Easy Golf",
  105: "Invisible Ink",
  106: "Locked In",
  107: "Crane",
  108: "Tutorial Green",
  109: "Split Circle",
  113: "Red Parkour",
  114: "Passing",
  115: "GPS Box",
  116: "Tutorial Box",
  117: "Interrogation",
  118: "Maze",
  121: "Basketball",
  122: "Stage",
  123: "House House",
  124: "Poses",
  125: "Scribbles",
  127: "Memory",
  133: "Forget-Me-Not",
  134: "Warehouse",
  135: "Musical Chairs",
  137: "Point and Click",
  138: "Coordinate Box",
  139: "Pegs",
  140: "Tutorial Blue",
  141: "Beach Houses",
  142: "Big Patience",
  143: "Telescopes",
  144: "Kettles",
  147: "Hundred Lights Red",
  148: "Music Box",
  149: "Climbing",
  150: "Easy Music",
  151: "Hard Music",
  152: "Purple Parkour",
  153: "Headless Parkour",
  154: "Headless Chicken",
  155: "Counting Heads",
  156: "Hundred Lights Purple",
  157: "Flare Box",
  158: "Hard Golf",
  159: "Hard Scribbles",
});

function gourdName(name) {
  return GOURD_NAMES[name] ?? `Gourd ${name}`;
}

const GOURD_RECEPTACLE_TOLERANCE = 0.01; // One centimetre in XYZ, not proximity on the map.

class GourdReceptacles {
  constructor() {
    this.slots = [];
    this.groups = GOURD_RECEPTACLE_GROUPS.map(group => {
      const start = this.slots.length;
      let x = 0, z = 0;
      for (const [sx, sy, sz] of group.positions) {
        this.slots.push({ x: sx, y: sy, z: sz });
        x += sx; z += sz;
      }
      return { name: group.name, start, count: group.positions.length,
        x: x / group.positions.length, z: z / group.positions.length };
    });
    this.slotGroups = this.groups.flatMap((group, index) => Array(group.count).fill(index));
    this.setReplay([]);
  }

  slotAt(gourd) {
    const radius2 = GOURD_RECEPTACLE_TOLERANCE ** 2;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const dx = gourd.x - slot.x, dy = gourd.y - slot.y, dz = gourd.z - slot.z;
      if (dx * dx + dy * dy + dz * dz <= radius2) return i;
    }
    return -1;
  }

  setReplay(frames) {
    this.history = this.slots.map(() => []);
    this.occupants = this.slots.map(() => null);
    this.frame = null;
    this.current = this.slots.map(() => null);
    this.locations = new Map();
    this.holders = new Map();
    this.deposits = [];
    this.scanned = 0;
    this.scan(frames);
  }

  /**
   * Live replay: frames only ever arrive at the end, so a session can continue the scan instead
   * of replaying every earlier frame again (which is quadratic over a long run).
   */
  extend(frames) {
    if (this.scanned > frames.length) {
      this.setReplay(frames); // rewound or replaced: rebuild from scratch
      return;
    }
    if (this.scanned === frames.length) return;
    this.scan(frames);
  }

  scan(frames) {
    const current = this.current, locations = this.locations;
    // A gourd entering a receptacle is a deposit. Attribute it to the player who
    // held it in the preceding frame, falling back to the last observed holder
    // when an intervening sample was dropped.
    const holderOf = (frameIndex, name) => {
      if (frameIndex > 0) {
        const previous = frames[frameIndex - 1];
        for (const player of previous.players || []) {
          if (player.carriedGourd === name) return player.netId;
        }
        for (const gourd of previous.gourds || []) {
          if (gourd.name === name && gourd.holderNetId) return gourd.holderNetId;
        }
      }
      return this.holders.get(name);
    };
    // Record changes only. Missing observations (including the empty shutdown
    // frame) retain the last known placement; an observed move clears it.
    const change = (slot, name, frame) => {
      if (current[slot] === name) return;
      current[slot] = name;
      const history = this.history[slot];
      if (history.at(-1)?.frame === frame) history[history.length - 1].name = name;
      else history.push({ frame, name });
    };
    for (let frame = this.scanned; frame < frames.length; frame++) {
      const data = frames[frame];
      for (const player of data.players || []) {
        if (player.carriedGourd) this.holders.set(player.carriedGourd, player.netId);
      }
      for (const gourd of data.gourds || []) {
        if (gourd.holderNetId) this.holders.set(gourd.name, gourd.holderNetId);
      }
      for (const gourd of data.gourds || []) {
        const slot = this.slotAt(gourd), previous = locations.get(gourd.name);
        if (previous !== undefined && previous !== slot && current[previous] === gourd.name) {
          change(previous, null, frame);
        }
        if (slot >= 0) {
          const deposited = frame > 0 && previous !== slot && current[slot] !== gourd.name;
          change(slot, gourd.name, frame);
          locations.set(gourd.name, slot);
          if (deposited) {
            const group = this.groups[this.slotGroups[slot]];
            let filled = 0;
            for (let i = group.start; i < group.start + group.count; i++) {
              if (current[i] !== null) filled++;
            }
            this.deposits.push({
              time: data.time,
              type: "gourd-deposited",
              frame,
              gourd: gourd.name,
              netId: holderOf(frame, gourd.name) ?? 0,
              tower: group.name,
              filled,
              total: group.count,
            });
          }
        } else locations.delete(gourd.name);
      }
    }
    this.scanned = frames.length;
  }

  at(frame) {
    if (frame === this.frame) return this.occupants;
    this.frame = frame;
    for (let i = 0; i < this.history.length; i++) {
      const history = this.history[i];
      let lo = 0, hi = history.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (history[mid].frame <= frame) lo = mid + 1;
        else hi = mid;
      }
      this.occupants[i] = lo ? history[lo - 1].name : null;
    }
    return this.occupants;
  }
}
