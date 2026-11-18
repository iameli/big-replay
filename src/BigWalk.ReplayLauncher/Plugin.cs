using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Unity.IL2CPP;

namespace BigWalk.ReplayLauncher;

/// <summary>
/// Starts the standalone Big Replay recorder next to a modded launch. Launcher-only:
/// no patches and no game reads. The recorder exits on its own after the game process
/// ends (--exit-with-game), so this plugin has nothing to clean up.
/// </summary>
[BepInPlugin(Guid, "Big Walk - Replay Launcher", "0.1.1")]
public class Plugin : BasePlugin
{
    public const string Guid = "com.bigwalk.replaylauncher";

    private const string ReplayMutexName = "Local\\BigReplay.Desktop";
    private const string ReplayProcessName = "BigReplay";

    private static ConfigEntry<bool> Enabled = null!;
    private static ConfigEntry<int> GraceSeconds = null!;

    public override void Load()
    {
        Enabled = Config.Bind("Launcher", "Enabled", true,
            "Start Big Replay automatically alongside this modded launch.");
        GraceSeconds = Config.Bind("Launcher", "GraceSeconds", 25,
            new ConfigDescription(
                "Seconds to wait after the game exits before Big Replay closes itself (covers quick relaunches).",
                new AcceptableValueRange<int>(0, 600)));

        if (!Enabled.Value)
        {
            Log.LogInfo("Disabled in config; not starting Big Replay.");
            return;
        }

        try
        {
            string? exe = ResolveExePath();
            if (exe == null)
            {
                Log.LogWarning("BigReplay.exe was not found at <profile>/BigReplay/BigReplay.exe; " +
                               "the package payload appears to be missing, so nothing was started.");
                return;
            }

            if (IsReplayRunning())
            {
                Log.LogInfo("Big Replay is already running; leaving it alone.");
                return;
            }

            int gamePid = Process.GetCurrentProcess().Id;

            using Process? process = Process.Start(new ProcessStartInfo(exe)
            {
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(exe)!,
                ArgumentList =
                {
                    "--exit-with-game",
                    gamePid.ToString(),
                    "--grace",
                    GraceSeconds.Value.ToString(),
                },
            });

            Log.LogInfo($"Started Big Replay (pid {process?.Id}) for game pid {gamePid}: {exe}");
        }
        catch (Exception ex)
        {
            Log.LogError($"Could not start Big Replay: {ex.Message}");
        }
    }

    private static string? ResolveExePath()
    {
        // Paths.PluginPath is <profile>/BepInEx/plugins; the payload lands beside BepInEx.
        string exe = Path.Combine(
            Path.GetFullPath(Path.Combine(Paths.PluginPath, "..", "..")),
            "BigReplay",
            "BigReplay.exe");

        return File.Exists(exe) ? exe : null;
    }

    private static bool IsReplayRunning()
    {
        try
        {
            if (Mutex.TryOpenExisting(ReplayMutexName, out Mutex? mutex))
            {
                mutex?.Dispose();
                return true;
            }
        }
        catch (Exception)
        {
            // A mutex that cannot be opened is not proof of a running recorder; fall back
            // to the process-name check below.
        }

        try
        {
            Process[] processes = Process.GetProcessesByName(ReplayProcessName);
            try
            {
                return processes.Length != 0;
            }
            finally
            {
                foreach (Process process in processes)
                {
                    process.Dispose();
                }
            }
        }
        catch (Exception)
        {
            return false;
        }
    }
}
