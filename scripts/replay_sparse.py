"""Slot-based collection patches shared by the replay file tools."""

COLLECTIONS = {"players": "netId", "gourds": "name", "monuments": "homeName"}


def frame_delta(previous, frame):
    delta = {"time": frame["time"]}
    for key in COLLECTIONS:
        old, new = previous[key], frame[key]
        if new is old:
            continue
        patch = [len(new)]
        for i, item in enumerate(new):
            if i >= len(old) or item != old[i]:
                patch.extend((i, item))
        if len(patch) > 1 or len(new) != len(old):
            delta[key] = patch
    return delta


def _native_integer(value):
    if type(value) is not int:
        raise ValueError("expected a JSON integer")
    return value


def apply_patch(previous, patch, identity, integer=_native_integer):
    """Decode one patch without mutating previous. `integer` checks the number type."""
    if not isinstance(patch, list) or len(patch) % 2 != 1:
        raise ValueError("invalid collection patch")
    size = integer(patch[0])
    if size < 0:
        raise ValueError("invalid collection length")
    result = previous[:size]
    last = -1
    for offset in range(1, len(patch), 2):
        index, item = integer(patch[offset]), patch[offset + 1]
        if (not last < index < size or index > len(result)
                or not isinstance(item, dict)):
            raise ValueError("invalid replacement slot")
        integer(item.get(identity))
        if index == len(result):
            result.append(item)
        else:
            result[index] = item
        last = index
    if len(result) != size:
        raise ValueError("missing new slot")
    return result
