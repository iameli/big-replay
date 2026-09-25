using System.Diagnostics;
using GameAccess;
using Replay.Format;

namespace BigWalkReplay.Recorder;

public readonly record struct RecordingStatus(double ElapsedSeconds, int Players, long Frames);
public readonly record struct RecordingResult(string? Path, long Frames);

/// <summary>Shared CLI/desktop capture loop. The caller owns the read-only game handle.</summary>
public static class RecordingSession
{
    private const string GameVersion = "1.5.1 2608271531";
    private const string UnityVersion = "6000.3.17f1";

    public static RecordingResult Record(GameStateReader reader, string outPath,
        double rate, double duration, CancellationToken cancellationToken,
        Action<RecordingStatus>? report = null)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(rate);
        if (!double.IsFinite(rate) || !double.IsFinite(duration))
        {
            throw new ArgumentException("Rate and duration must be finite.");
        }
        string partialPath = outPath + ".partial";
        // Never overwrite a previous run. Only finished gzip/JSON files get the replay extension.
        if (File.Exists(outPath))
        {
            throw new IOException($"A replay already exists at {outPath}.");
        }
        using var file = new FileStream(partialPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        using var writer = new ReplayWriter(file);
        long frames = 0;
        double lastStatus = -1;
        var events = new List<ReplayEvent>();

        var clock = Stopwatch.StartNew();
        double interval = 1.0 / rate;
        double next = 0;
        bool headerWritten = false;
        bool serverWasActive = false;
        var prevPlayers = new HashSet<uint>();
        var prevFilled = new HashSet<int>();
        int prevCorpses = 0;
        try
        {
            while (!cancellationToken.IsCancellationRequested &&
                (duration <= 0 || clock.Elapsed.TotalSeconds < duration))
            {
                double t = clock.Elapsed.TotalSeconds;
                if (t < next)
                {
                    cancellationToken.WaitHandle.WaitOne(Math.Max(1, (int)((next - t) * 1000)));
                    continue;
                }
                next = t + interval;
                if (reader.Game.HasExited) break;
                bool active = reader.IsServerActive();
                var players = reader.ReadPlayers();

                if (t - lastStatus >= 1)
                {
                    lastStatus = t;
                    report?.Invoke(new RecordingStatus(t, players.Count, frames));
                }

                var (monuments, landmarks) = reader.ReadHomes();

                if (!headerWritten && players.Count > 0)
                {
                    writer.WriteHeader(new ReplayHeader
                    {
                        GameVersion = GameVersion,
                        UnityVersion = UnityVersion,
                        RecordedAt = DateTime.UtcNow,
                        SampleIntervalSec = interval,
                        Landmarks = landmarks,
                    });
                    headerWritten = true;
                    events.Add(new ReplayEvent { Time = t, Type = "run-started" });
                }

                if (!headerWritten)
                {
                    serverWasActive = active;
                    continue;
                }

                // ---- events from deltas ----
                var nowIds = players.Select(p => p.NetId).ToHashSet();
                foreach (uint id in nowIds)
                {
                    if (!prevPlayers.Contains(id))
                    {
                        events.Add(new ReplayEvent { Time = t, Type = "player-joined", Detail = id.ToString() });
                    }
                }
                foreach (uint id in prevPlayers)
                {
                    if (!nowIds.Contains(id))
                    {
                        events.Add(new ReplayEvent { Time = t, Type = "player-left", Detail = id.ToString() });
                    }
                }
                prevPlayers = nowIds;

                int corpses = reader.ReadCorpseCount();
                if (corpses > prevCorpses)
                {
                    events.Add(new ReplayEvent { Time = t, Type = "death", Detail = (corpses - prevCorpses).ToString() });
                }
                prevCorpses = corpses;

                foreach (var m in monuments)
                {
                    if (m.Filled && !prevFilled.Contains(m.HomeName))
                    {
                        events.Add(new ReplayEvent { Time = t, Type = "gourd-pinned", Detail = m.HomeName.ToString() });
                        var tower = BigWalkData.TowerHomes.FirstOrDefault(kv => kv.Value.Contains(m.HomeName));
                        if (tower.Key != null)
                        {
                            var group = BigWalkData.TowerHomes[tower.Key];
                            if (group.All(h => monuments.Any(mm => mm.HomeName == h && mm.Filled)))
                            {
                                events.Add(new ReplayEvent { Time = t, Type = "tower-filled", Detail = tower.Key });
                            }
                        }
                    }
                }
                prevFilled = monuments.Where(m => m.Filled).Select(m => m.HomeName).ToHashSet();

                if (active && !serverWasActive)
                {
                    events.Add(new ReplayEvent { Time = t, Type = "run-started" });
                }
                else if (!active && serverWasActive)
                {
                    events.Add(new ReplayEvent { Time = t, Type = "run-ended" });
                }
                serverWasActive = active;

                // ---- carried gourd positions: snap stashed gourds to their holder ----
                var gourds = reader.ReadGourds();
                var carriedByNetId = new Dictionary<uint, int>();
                foreach (var g in gourds)
                {
                    if (g.State == GourdState.Stashed)
                    {
                        var holder = players.FirstOrDefault(p => p.NetId == g.HolderNetId);
                        if (holder != null)
                        {
                            g.X = holder.X; g.Y = holder.Y; g.Z = holder.Z;
                            carriedByNetId[g.HolderNetId] = g.Name;
                        }
                    }
                }
                foreach (var p in players)
                {
                    if (carriedByNetId.TryGetValue(p.NetId, out int gourdName))
                    {
                        p.CarriedGourd = gourdName;
                    }
                }

                writer.WriteFrame(new ReplayFrame
                {
                    Time = t,
                    Players = players,
                    Gourds = gourds,
                    Monuments = monuments,
                });
                frames++;
            }
        }
        finally
        {
            // Preserve all completed samples even if a later memory read fails.
            if (headerWritten)
            {
                writer.Finish(events);
            }
        }
        writer.Dispose();
        file.Dispose();
        if (!headerWritten)
        {
            File.Delete(partialPath);
            return new RecordingResult(null, 0);
        }
        File.Move(partialPath, outPath);
        return new RecordingResult(outPath, frames);
    }
}
