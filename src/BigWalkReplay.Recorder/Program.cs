using System.Diagnostics;
using GameAccess;
using Replay.Format;

namespace BigWalkReplay.Recorder;

/// <summary>
/// Big Walk replay recorder. Pure reads from attach to exit: no allocations in the game,
/// no writes, no threads, no injection. Field layout comes from the offline manifest.
///
///   probe   — attach, load manifest, print one live sample (validation)
///   record  — attach, sample at N Hz, write a replay file (Ctrl+C to stop)
///
/// Run this on the HOST machine during a lobby.
/// </summary>
internal static class Program
{
    private const string GameVersion = "1.5.1 2608271531";
    private const string UnityVersion = "6000.3.17f1";

    private static int Main(string[] args)
    {
        try
        {
            string mode = args.Length > 0 ? args[0] : "probe";
            string manifestPath = args.Length > 1 && !args[1].StartsWith('-') ? args[1] : "manifest.json";
            string[] rest = manifestPath == "manifest.json" && args.Length > 1 ? args.Skip(1).ToArray() : args.Skip(2).ToArray();
            return mode switch
            {
                "probe" => Probe(manifestPath),
                "probe-ro" => ProbeReadOnly(manifestPath),
                "record" => Record(manifestPath, rest),
                _ => throw new ArgumentException($"unknown mode '{mode}' (use 'probe', 'probe-ro' or 'record')"),
            };
        }
        catch (Exception e)
        {
            Console.Error.WriteLine($"FAILED: {e.Message}");
            Console.Error.WriteLine(e);
            return 1;
        }
    }

    private static int Probe(string manifestPath)
    {
        using var game = GameProcess.Attach();
        Console.WriteLine($"attached: GameAssembly.dll base=0x{game.GameAssemblyBase:X} size=0x{game.GameAssemblySize:X}");

        var layout = GameLayout.Attach(game, manifestPath);
        Console.WriteLine($"manifest OK: build {layout.Manifest.BuildId} ({layout.Manifest.GameVersion})");

        var entries = layout.Classes.Select(kv => (kv.Key, kv.Value)).ToArray();
        Console.WriteLine("waiting for static blocks (classes initialize in-world)...");
        for (int attempt = 0; attempt < 60; attempt++)
        {
            int done = entries.Count(e => e.Value.Resolved);
            foreach (var (_, cls) in entries)
            {
                cls.TryResolveStaticBlock();
            }
            if (entries.All(e => e.Value.Resolved))
            {
                break;
            }
            Thread.Sleep(500);
        }
        foreach (var (name, cls) in entries)
        {
            Console.WriteLine($"  static block {name}: {(cls.Resolved ? $"0x{cls.StaticBlock:X}" : "(class not initialized yet)")}");
        }

        var reader = new GameStateReader(game, layout);
        Console.WriteLine($"server active: {reader.IsServerActive()}  connectState: {reader.GetConnectState()}");

        var players = reader.ReadPlayers();
        Console.WriteLine($"players: {players.Count}");
        foreach (var p in players)
        {
            Console.WriteLine($"  netId={p.NetId} pos=({p.X:F2}, {p.Y:F2}, {p.Z:F2}) yaw={p.Yaw * 180 / Math.PI:F0}° pending={p.IsPending} drowsy={p.Drowsy}");
        }

        var (monuments, landmarks) = reader.ReadHomes();
        Console.WriteLine($"monuments: {monuments.Count}  landmarks: {landmarks.Count}");
        foreach (var m in monuments)
        {
            Console.WriteLine($"  home {m.HomeName}: filled={m.Filled}");
        }
        Console.WriteLine($"corpses: {reader.ReadCorpseCount()}");

        var gourds = reader.ReadGourds();
        Console.WriteLine($"gourds: {gourds.Count}");
        foreach (var g in gourds.Take(12))
        {
            Console.WriteLine($"  gourd {g.Name} state={g.State} pos=({g.X:F1}, {g.Y:F1}, {g.Z:F1}) holder={g.HolderNetId}");
        }
        return 0;
    }

    private static int ProbeReadOnly(string manifestPath)
    {
        using var game = GameProcess.Attach();
        Console.WriteLine($"attached: GameAssembly.dll base=0x{game.GameAssemblyBase:X} size=0x{game.GameAssemblySize:X}");

        var layout = GameLayout.Attach(game, manifestPath);
        Console.WriteLine($"manifest OK: build {layout.Manifest.BuildId} ({layout.Manifest.GameVersion}) — pure-read mode: no allocations, no threads");

        foreach (var (name, cls) in layout.Classes)
        {
            Console.WriteLine($"  class {name}: statics=[{string.Join(", ", cls.StaticFieldNames)}]");
        }
        Console.WriteLine("idling 30s (attach + reads only)…");
        for (int i = 0; i < 30; i++)
        {
            Thread.Sleep(1000);
        }
        Console.WriteLine("done");
        return 0;
    }

    private static int Record(string manifestPath, string[] args)
    {
        double rate = 10;
        string? outPath = null;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "-r" or "--rate" when i + 1 < args.Length:
                    rate = double.Parse(args[++i], System.Globalization.CultureInfo.InvariantCulture);
                    break;
                case "-o" or "--out" when i + 1 < args.Length:
                    outPath = args[++i];
                    break;
                default:
                    if (args[i].EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                    {
                        break; // positional manifest (already resolved in Main)
                    }
                    throw new ArgumentException($"unknown option '{args[i]}'");
        }
        rate = Math.Clamp(rate, 1, 60);
        outPath ??= $"bigwalk-replay-{DateTime.UtcNow:yyyyMMdd-HHmmss}.replay.json.gz";

        using var game = GameProcess.Attach();
        Console.WriteLine($"attached: GameAssembly.dll base=0x{game.GameAssemblyBase:X}");

        var layout = GameLayout.Attach(game, manifestPath);
        var reader = new GameStateReader(game, layout);
        Console.WriteLine($"manifest OK; recording at {rate} Hz (Ctrl+C to stop)");

        using var file = File.Create(outPath);
        var writer = new ReplayWriter(file);
        var events = new List<ReplayEvent>();

        var clock = Stopwatch.StartNew();
        double interval = 1.0 / rate;
        double next = 0;
        bool headerWritten = false;
        bool serverWasActive = false;
        var prevPlayers = new HashSet<uint>();
        var prevFilled = new HashSet<int>();
        int prevCorpses = 0;

        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            _stop = true;
        };

        while (!_stop)
        {
            double t = clock.Elapsed.TotalSeconds;
            if (t < next)
            {
                Thread.Sleep(5);
                continue;
            }
            next = t + interval;

            try
            {
                bool active = reader.IsServerActive();
                var players = reader.ReadPlayers();
                var (monuments, landmarks) = reader.ReadHomes();

                if (!headerWritten && active && players.Count > 0)
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
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"sample failed (skipping): {e.Message}");
            }
        }

        writer.Finish(events);
        Console.WriteLine($"\nwrote {outPath} ({events.Count} events)");
        return 0;
    }

    private static volatile bool _stop;
}