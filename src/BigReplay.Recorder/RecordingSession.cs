using System.Diagnostics;
using BigReplay.Live;
using GameAccess;
using Replay.Format;

namespace BigReplay.Recorder;

public readonly record struct RecordingStatus(double ElapsedSeconds, int Players, long Frames);
public readonly record struct RecordingResult(string? Path, long Frames);

/// <summary>
/// Shared CLI/desktop capture loop. The caller owns the read-only game handle.
/// The optional live stream receives the same logical samples and events in publication order;
/// only the capture file uses sparse frames.
/// </summary>
public static class RecordingSession
{
    private const string GameVersion = "1.5.1 2608271531";
    private const string UnityVersion = "6000.3.17f1";

    public static RecordingResult Record(GameStateReader reader, string outPath,
        double rate, double duration, CancellationToken cancellationToken,
        Action<RecordingStatus>? report = null, LiveSession? live = null,
        TowerProgressTracker? towerProgress = null, Action<TowerCompletion>? towerCompleted = null,
        EndgameTeleportTracker? endgame = null, Action<EndgameTeleport>? endgameReached = null)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(rate);
        if (!double.IsFinite(rate) || !double.IsFinite(duration))
        {
            throw new ArgumentException("Rate and duration must be finite.");
        }
        // Never overwrite a previous run (finished or stranded .partial); pick the next free name.
        string requestedPath = outPath;
        bool gzip = outPath.EndsWith(".gz", StringComparison.OrdinalIgnoreCase);
        string extension = gzip ? ReplayFile.Extension + ".gz" : ReplayFile.Extension;
        if (!outPath.EndsWith(extension, StringComparison.OrdinalIgnoreCase))
        {
            extension = Path.GetExtension(outPath);
        }
        string partialPath = outPath + ".partial";
        int suffix = 1;
        while (File.Exists(outPath) || File.Exists(partialPath))
        {
            int split = requestedPath.Length - extension.Length;
            outPath = $"{requestedPath[..split]}-{suffix}{requestedPath[split..]}";
            partialPath = outPath + ".partial";
            suffix++;
        }
        using var file = new FileStream(partialPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        using var writer = new ReplayWriter(file, gzip);
        long frames = 0;
        int failedSamples = 0;
        // Every event the file records also goes to the live stream, at the same moment, so a
        // viewer that connected mid-run sees the same history a finished replay would show.
        void AddEvent(ReplayEvent replayEvent)
        {
            writer.WriteEvent(replayEvent);
            live?.PublishEvent(replayEvent);
        }
        string endReason = "stopped";
        double lastStatus = -1;
        var clock = Stopwatch.StartNew();
        double interval = 1.0 / rate;
        double next = 0;
        bool headerWritten = false;
        bool serverWasActive = false;
        var prevPlayers = new HashSet<uint>();
        towerProgress?.BeginSession();
        endgame?.Reset();
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
                bool active;
                List<PlayerSnapshot> players;
                List<GourdSnapshot> gourds;
                List<MonumentSnapshot> monuments;
                List<Landmark> landmarks;
                int corpses;
                try
                {
                    if (reader.Game.HasExited)
                    {
                        endReason = "game-exited";
                        break;
                    }
                    active = reader.IsServerActive();
                    players = reader.ReadPlayers();
                    if (t - lastStatus >= 1)
                    {
                        lastStatus = t;
                        report?.Invoke(new RecordingStatus(t, players.Count, frames));
                    }
                    (monuments, landmarks) = reader.ReadHomes();
                    if (!headerWritten && players.Count == 0)
                    {
                        serverWasActive = active;
                        continue;
                    }
                    corpses = reader.ReadCorpseCount();
                    gourds = reader.ReadGourds();
                }
                catch (Exception ex)
                {
                    // A failed memory read publishes nothing and does not advance the delta baseline.
                    // Disk I/O is deliberately outside this catch: never append after a failed write.
                    failedSamples++;
                    if (failedSamples <= 3)
                    {
                        Console.Error.WriteLine($"  sample failed (skipping): {ex.Message}");
                    }
                    if (failedSamples > Math.Max(30, rate * 30))
                    {
                        Console.Error.WriteLine("  too many failed samples; stopping.");
                        endReason = "capture-failed";
                        break;
                    }
                    continue;
                }
                failedSamples = 0;

                if (!headerWritten)
                {
                    var header = new ReplayHeader
                    {
                        GameVersion = GameVersion,
                        UnityVersion = UnityVersion,
                        RecordedAt = DateTime.UtcNow,
                        SampleIntervalSec = interval,
                        Landmarks = landmarks,
                    };
                    writer.WriteHeader(header);
                    live?.BeginRun(header);
                    headerWritten = true;
                    AddEvent(new ReplayEvent { Time = t, Type = "run-started" });
                }

                // ---- events from deltas ----
                var nowIds = players.Select(p => p.NetId).ToHashSet();
                foreach (uint id in nowIds)
                {
                    if (!prevPlayers.Contains(id))
                    {
                        AddEvent(new ReplayEvent { Time = t, Type = "player-joined", Detail = id.ToString() });
                    }
                }
                foreach (uint id in prevPlayers)
                {
                    if (!nowIds.Contains(id))
                    {
                        AddEvent(new ReplayEvent { Time = t, Type = "player-left", Detail = id.ToString() });
                    }
                }
                prevPlayers = nowIds;

                if (corpses > prevCorpses)
                {
                    AddEvent(new ReplayEvent { Time = t, Type = "death", Detail = (corpses - prevCorpses).ToString() });
                }
                prevCorpses = corpses;

                foreach (var m in monuments)
                {
                    if (m.Filled && !prevFilled.Contains(m.HomeName))
                    {
                        AddEvent(new ReplayEvent { Time = t, Type = "gourd-pinned", Detail = m.HomeName.ToString() });
                        var tower = BigWalkData.TowerHomes.FirstOrDefault(kv => kv.Value.Contains(m.HomeName));
                        if (tower.Key != null)
                        {
                            var group = BigWalkData.TowerHomes[tower.Key];
                            if (group.All(h => monuments.Any(mm => mm.HomeName == h && mm.Filled)))
                            {
                                AddEvent(new ReplayEvent { Time = t, Type = "tower-filled", Detail = tower.Key });
                            }
                        }
                    }
                }
                prevFilled = monuments.Where(m => m.Filled).Select(m => m.HomeName).ToHashSet();

                if (players.Count == 0 || (!active && serverWasActive))
                {
                    AddEvent(new ReplayEvent { Time = t, Type = "run-ended" });
                }
                else if (active && !serverWasActive)
                {
                    AddEvent(new ReplayEvent { Time = t, Type = "run-started" });
                }
                serverWasActive = active;

                // ---- carried gourd positions: snap stashed gourds to their holder ----
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

                var frame = new ReplayFrame
                {
                    Time = t,
                    Players = players,
                    Gourds = gourds,
                    Monuments = monuments,
                };
                if (towerProgress is not null)
                {
                    IReadOnlyList<TowerCompletion> completions = towerProgress.ScanFrame(frame, frames);
                    if (towerCompleted is not null)
                    {
                        foreach (var completion in completions)
                        {
                            towerCompleted(completion);
                        }
                    }
                }
                if (endgame is not null)
                {
                    EndgameTeleport? teleport = endgame.ScanFrame(frame, frames);
                    if (teleport is not null)
                    {
                        endgameReached?.Invoke(teleport.Value);
                    }
                }
                writer.WriteFrame(frame);
                live?.PublishFrame(frame);
                frames++;
                // No header is written until players arrive, so idle menus never split.
                // Keep the final empty-player frame and its leave/end events in this replay.
                if (players.Count == 0)
                {
                    endReason = "run-ended";
                    break;
                }
            }
        }
        finally
        {
            if (headerWritten)
            {
                // The live socket stays open: the viewer shows the finished run and waits for the
                // next hello, which the desktop app sends when the following walk starts.
                live?.EndRun(endReason);
            }
        }
        // Close the stream (and finish optional gzip) before renaming on Windows.
        writer.Dispose();
        if (!headerWritten)
        {
            File.Delete(partialPath);
            return new RecordingResult(null, 0);
        }
        File.Move(partialPath, outPath);
        return new RecordingResult(outPath, frames);
    }
}
