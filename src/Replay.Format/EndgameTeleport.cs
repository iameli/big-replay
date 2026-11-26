namespace Replay.Format;

/// <summary>
/// The hangout room the game teleports everyone to after the final monument. Measured
/// from the 1.5.1 12-player recordings: players stayed within x 724–733, y -24.7–-22.9,
/// z 336.7–346.2; nobody comes within 80 m of it before then. Keep these constants in
/// step with <c>SECRET_ROOM</c> in <c>map-view.js</c>.
/// </summary>
public static class EndgameRoom
{
    public const float MinX = 700;
    public const float MaxX = 760;
    public const float MinY = -40;
    public const float MaxY = -10;
    public const float MinZ = 310;
    public const float MaxZ = 370;

    /// <summary>One located player is enough: the room is far from every route, and waiting
    /// for a consensus would add the slowest client's teleport latency to the run.</summary>
    public const int MinimumPlayers = 1;

    /// <summary>Two frames at the desktop capture rate: enough to reject a one-sample glitch
    /// without delaying the finish by the viewer's one-second video-sync window.</summary>
    public const double StabilitySeconds = 0.1;

    public static bool Contains(float x, float y, float z) =>
        x >= MinX && x <= MaxX &&
        y >= MinY && y <= MaxY &&
        z >= MinZ && z <= MaxZ;
}

public readonly record struct EndgameTeleport(double Time, long Frame, int Inside, int Located);

/// <summary>
/// Detects the first stable frame where at least one player reaches the endgame room.
/// Reset per recording session; one teleport is reported per session.
/// </summary>
public sealed class EndgameTeleportTracker
{
    private double? _roomSince;
    private bool _detected;

    public void Reset()
    {
        _roomSince = null;
        _detected = false;
    }

    public EndgameTeleport? ScanFrame(ReplayFrame frame, long frameIndex)
    {
        if (_detected)
        {
            return null;
        }

        int located = 0;
        int inside = 0;
        foreach (var player in frame.Players)
        {
            if (!float.IsFinite(player.X) || !float.IsFinite(player.Y) || !float.IsFinite(player.Z))
            {
                continue;
            }
            located++;
            if (EndgameRoom.Contains(player.X, player.Y, player.Z))
            {
                inside++;
            }
        }

        bool reached = inside >= EndgameRoom.MinimumPlayers;
        if (!reached)
        {
            _roomSince = null;
            return null;
        }

        if (_roomSince is null || frame.Time < _roomSince)
        {
            _roomSince = frame.Time;
        }
        if (frame.Time - _roomSince >= EndgameRoom.StabilitySeconds)
        {
            _detected = true;
            return new EndgameTeleport(frame.Time, frameIndex, inside, located);
        }
        return null;
    }
}
