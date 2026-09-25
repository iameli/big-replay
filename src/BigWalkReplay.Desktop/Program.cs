namespace BigWalkReplay.Desktop;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        using var instance = new Mutex(true, @"Local\BigWalkReplay.Desktop", out bool firstInstance);
        if (!firstInstance)
        {
            MessageBox.Show("BigReplay is already running. Check its window on the taskbar.",
                "BigReplay", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        Application.Run(new RecorderForm());
    }
}
