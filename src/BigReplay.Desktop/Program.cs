namespace BigReplay.Desktop;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // --exit-with-game [pid] [--grace seconds]
        //   With a pid: the launcher plugin passes the game's process id; when that process ends
        //   (including a crash), Big Replay saves and exits after the grace period.
        //   Without a pid: watch all "Big Walk" processes by name (same behaviour).
        //
        // --live-port N / --live-bind ADDRESS / --no-live
        //   Live replay sharing is on by default on ws://127.0.0.1:8787/ for the viewer's Live
        //   section. Binding anything but loopback lets other people watch.
        bool exitWithGame = false;
        int? gamePid = null;
        int graceSeconds = 25;
        bool liveEnabled = true;
        int livePort = 8787;
        string liveBind = "127.0.0.1";
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--exit-with-game":
                    exitWithGame = true;
                    if (i + 1 < args.Length && int.TryParse(args[i + 1], out int pid))
                    {
                        gamePid = pid;
                        i++;
                    }
                    break;
                case "--grace" when i + 1 < args.Length:
                    if (int.TryParse(args[++i], out int grace))
                    {
                        graceSeconds = Math.Max(0, grace);
                    }
                    break;
                case "--no-live":
                    liveEnabled = false;
                    break;
                case "--live-port" when i + 1 < args.Length:
                    if (int.TryParse(args[++i], out int port))
                    {
                        livePort = Math.Clamp(port, 0, 65535);
                    }
                    break;
                case "--live-bind" when i + 1 < args.Length:
                    liveBind = args[++i];
                    break;
            }
        }

        ApplicationConfiguration.Initialize();
        using var instance = new Mutex(true, @"Local\BigReplay.Desktop", out bool firstInstance);
        if (!firstInstance)
        {
            MessageBox.Show("Big Replay is already running. Check its window on the taskbar.",
                "Big Replay", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        Application.Run(new RecorderForm(exitWithGame, gamePid, graceSeconds, liveEnabled, livePort, liveBind));
    }
}