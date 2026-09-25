namespace BigReplay.Desktop;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        using var instance = new Mutex(true, @"Local\BigReplay.Desktop", out bool firstInstance);
        if (!firstInstance)
        {
            MessageBox.Show("Big Replay is already running. Check its window on the taskbar.",
                "Big Replay", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        Application.Run(new RecorderForm());
    }
}
