using System.ComponentModel;
using System.Diagnostics;
using BigWalkReplay.Recorder;
using GameAccess;

namespace BigWalkReplay.Desktop;

internal sealed class RecorderForm : Form
{
    private readonly Label _status = new() { AutoSize = true, Text = "Waiting for Big Walk" };
    private readonly Label _detail = new() { AutoSize = true, Text = "Launch the game whenever you're ready." };
    private readonly Label _file = new() { AutoSize = true, Text = "No recording in progress." };
    private readonly Label _lastSaved = new() { AutoSize = true, Text = "No replays saved this time yet." };
    private readonly Button _pause = new() { AutoSize = true, Text = "Pause recording", Padding = new Padding(12, 6, 12, 6) };
    private readonly Button _openFolder = new() { AutoSize = true, Text = "Open recordings folder", Padding = new Padding(12, 6, 12, 6) };
    private readonly TextBox _folder = new() { ReadOnly = true, Dock = DockStyle.Fill, TabStop = true };
    private CancellationTokenSource? _stop;
    private Task _runTask = Task.CompletedTask;
    private string? _outputDirectory;
    private bool _closing;
    private bool _allowClose;

    public RecorderForm()
    {
        Text = "BigReplay";
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleDimensions = new SizeF(96, 96);
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(700, 560);
        MinimumSize = new Size(600, 500);
        BackColor = Color.FromArgb(247, 248, 250);
        Font = new Font("Segoe UI", 10);

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill, AutoScroll = true, Padding = new Padding(28), ColumnCount = 1, RowCount = 10,
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        var title = new Label { Text = "BigReplay", AutoSize = true, Font = new Font(Font.FontFamily, 24, FontStyle.Bold) };
        var subtitle = new Label { Text = "Automatic Big Walk replay recorder", AutoSize = true, Margin = new Padding(0, 0, 0, 24) };
        _status.Font = new Font(Font.FontFamily, 16, FontStyle.Bold);
        _detail.Margin = new Padding(0, 8, 0, 16);
        _file.Margin = new Padding(0, 0, 0, 8);
        _lastSaved.Margin = new Padding(0, 0, 0, 20);
        var folderTitle = new Label { Text = "Save replays to", AutoSize = true };
        var buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0, 12, 0, 12) };
        buttons.Controls.Add(_pause);
        buttons.Controls.Add(_openFolder);
        var hint = new Label
        {
            Text = "Run this on the host's PC to capture all players.\nClosing this window finishes and saves the current replay.",
            AutoSize = true, ForeColor = Color.FromArgb(85, 92, 104),
        };
        layout.Controls.Add(title);
        layout.Controls.Add(subtitle);
        layout.Controls.Add(_status);
        layout.Controls.Add(_detail);
        layout.Controls.Add(_file);
        layout.Controls.Add(_lastSaved);
        layout.Controls.Add(folderTitle);
        layout.Controls.Add(_folder);
        layout.Controls.Add(buttons);
        layout.Controls.Add(hint);
        Controls.Add(layout);
        layout.SizeChanged += (_, _) =>
        {
            int width = Math.Max(100, layout.ClientSize.Width - layout.Padding.Horizontal - 6);
            foreach (var label in new[] { _status, _detail, _file, _lastSaved, hint })
            {
                label.MaximumSize = new Size(width, 0);
            }
        };
        _pause.Click += async (_, _) =>
        {
            if (_runTask.IsCompleted)
            {
                StartMonitoring();
            }
            else
            {
                _pause.Enabled = false;
                SetStatus("Finishing recording", "Please wait while the replay is saved.");
                _stop!.Cancel();
                await _runTask;
                if (!_closing)
                {
                    _pause.Enabled = true;
                }
            }
        };
        _openFolder.Click += (_, _) => OpenFolder();
        Shown += (_, _) => StartMonitoring();
    }

    private void StartMonitoring()
    {
        _stop?.Dispose();
        _stop = new CancellationTokenSource();
        _pause.Text = "Pause recording";
        _runTask = MonitorAsync(_stop.Token);
    }

    private async Task MonitorAsync(CancellationToken token)
    {
        try
        {
            string documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            if (string.IsNullOrWhiteSpace(documents))
            {
                throw new IOException("Windows did not provide a Documents folder.");
            }
            _outputDirectory = Path.Combine(documents, "BigReplay");
            _folder.Text = _outputDirectory;
            Directory.CreateDirectory(_outputDirectory);
            string manifest = Path.Combine(AppContext.BaseDirectory, "manifest.json");
            // Fail visibly for a missing/corrupt bundled manifest, even before the game starts.
            ManifestLoader.Load(manifest);
            var progress = new Progress<RecordingStatus>(sample =>
            {
                if (token.IsCancellationRequested) return;
                SetStatus(sample.Frames == 0 ? "Waiting for players" : "Recording",
                    sample.Frames == 0
                        ? "Big Walk is connected. Enter a walk to begin capturing players."
                        : $"{TimeSpan.FromSeconds(sample.ElapsedSeconds):hh\\:mm\\:ss} recorded  ·  {sample.Players} players  ·  {sample.Frames:N0} frames",
                    sample.Frames > 0);
            });
            while (!token.IsCancellationRequested)
            {
                SetStatus("Waiting for Big Walk", "Launch the game whenever you're ready. Checking every 2 seconds.");
                GameProcess? game = null;
                var processes = Process.GetProcessesByName(GameProcess.ProcessName);
                bool running = processes.Length > 0;
                foreach (var process in processes) process.Dispose();
                if (running)
                {
                    SetStatus("Connecting to Big Walk", "Preparing read-only capture…");
                    try
                    {
                        game = await Task.Run(() => GameProcess.Attach(), token);
                    }
                    catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
                    {
                        SetStatus("Waiting for game access", $"{ex.Message} Retrying in 2 seconds.");
                    }
                }
                if (game is not null)
                {
                    using (game)
                    {
                        string path = Path.Combine(_outputDirectory,
                            $"bigwalk-{DateTime.Now:yyyyMMdd-HHmmss-fff}-{Guid.NewGuid().ToString("N")[..8]}.replay.json.gz");
                        _file.Text = $"Current: {Path.GetFileName(path)}";
                        try
                        {
                            var result = await Task.Run(() =>
                            {
                                var layout = GameLayout.Attach(game, manifest);
                                return RecordingSession.Record(new GameStateReader(game, layout), path, 10, 0, token,
                                    sample => ((IProgress<RecordingStatus>)progress).Report(sample));
                            }, token);
                            if (result.Path is not null)
                            {
                                _lastSaved.Text = $"Saved: {Path.GetFileName(result.Path)}";
                            }
                        }
                        catch
                        {
                            _file.Text = File.Exists(path + ".partial")
                                ? $"Unfinished capture kept: {Path.GetFileName(path)}.partial"
                                : "No recording in progress.";
                            throw;
                        }
                        _file.Text = "No recording in progress.";
                    }
                }
                await Task.Delay(2000, token);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception ex)
        {
            SetStatus("Recording stopped", $"{ex.Message} Fix the problem, then click Resume recording.");
            if (_closing)
            {
                MessageBox.Show(this, ex.Message + "\nAny unfinished capture is kept with a .partial extension.",
                    "Replay could not be saved", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            return;
        }
        finally
        {
            _pause.Text = "Resume recording";
        }
        SetStatus("Paused", "Click Resume recording to watch for Big Walk again.");
    }

    private void SetStatus(string title, string detail, bool recording = false)
    {
        _status.Text = title;
        _status.ForeColor = recording ? Color.FromArgb(21, 116, 70) : Color.FromArgb(35, 45, 65);
        _detail.Text = detail;
    }

    private void OpenFolder()
    {
        try
        {
            if (_outputDirectory is null) throw new IOException("The Documents folder is unavailable.");
            Directory.CreateDirectory(_outputDirectory);
            Process.Start(new ProcessStartInfo(_outputDirectory) { UseShellExecute = true })?.Dispose();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "Cannot open recordings folder", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    protected override async void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_allowClose)
        {
            e.Cancel = true;
            base.OnFormClosing(e);
            if (_closing) return;
            _closing = true;
            _pause.Enabled = false;
            SetStatus("Finishing recording", "Please wait while the replay is saved.");
            _stop?.Cancel();
            await _runTask;
            _stop?.Dispose();
            _allowClose = true;
            Close();
            return;
        }
        base.OnFormClosing(e);
    }
}
