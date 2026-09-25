using GameAccess;
using Replay.Format;

namespace BigReplay.Recorder;

/// <summary>
/// Big Replay recorder for Big Walk. Pure reads from attach to exit: no allocations in the game,
/// no writes, no threads, no injection. Field layout comes from the offline manifest.
///
///   probe   — attach, load manifest, print one live sample (validation)
///   record  — attach, sample at N Hz, write a replay file (Ctrl+C to stop)
///
/// Run this on the HOST machine during a lobby.
/// </summary>
internal static class Program
{

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
        Console.WriteLine("waiting for static blocks (klass discovery, classes initialize in-world)...");
        for (int attempt = 0; attempt < 600; attempt++)
        {
            int done = entries.Count(e => e.Value.Resolved);
            foreach (var (_, cls) in entries)
            {
                layout.TryResolveStatics(cls);
            }
            if (entries.All(e => e.Value.Resolved))
            {
                break;
            }
            if (attempt % 10 == 9)
            {
                Console.WriteLine($"  resolved {entries.Count(e => e.Value.Resolved)}/{entries.Length}…");
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
        double duration = 0; // 0 = until Ctrl+C
        string? outPath = null;
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "-r" or "--rate" when i + 1 < args.Length:
                    rate = double.Parse(args[++i], System.Globalization.CultureInfo.InvariantCulture);
                    break;
                case "-d" or "--duration" when i + 1 < args.Length:
                    duration = double.Parse(args[++i], System.Globalization.CultureInfo.InvariantCulture);
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
        }
        rate = Math.Clamp(rate, 1, 60);

        outPath ??= $"bigreplay-{DateTime.UtcNow:yyyyMMdd-HHmmss}.replay.json.gz";

        using var game = GameProcess.Attach();
        Console.WriteLine($"attached: GameAssembly.dll base=0x{game.GameAssemblyBase:X}");

        var layout = GameLayout.Attach(game, manifestPath);
        var reader = new GameStateReader(game, layout);
        Console.WriteLine($"manifest OK; recording at {rate} Hz (Ctrl+C to stop)");

        using var stop = new CancellationTokenSource();
        ConsoleCancelEventHandler cancel = (_, e) =>
        {
            e.Cancel = true;
            stop.Cancel();
        };
        Console.CancelKeyPress += cancel;
        try
        {
            var result = RecordingSession.Record(reader, outPath, rate, duration, stop.Token,
                status => Console.WriteLine($"  t={status.ElapsedSeconds,5:F1}s  players={status.Players}  frames={status.Frames}"));
            Console.WriteLine(result.Path is null
                ? "No live walk was detected; no replay saved."
                : $"\nwrote {result.Path} ({result.Frames} frames)");
        }
        finally
        {
            Console.CancelKeyPress -= cancel;
        }
        return 0;
    }

}