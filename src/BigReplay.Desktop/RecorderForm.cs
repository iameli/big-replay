using System.Text.Json;
using System.ComponentModel;
using System.Diagnostics;
using BigReplay.Live;
using BigReplay.Recorder;
using GameAccess;
using Replay.Format;

namespace BigReplay.Desktop;

internal sealed class RecorderForm : Form
{
    private static readonly Color WaitingColor = Color.FromArgb(100, 106, 116);
    private static readonly Color ConnectedColor = Color.FromArgb(28, 101, 187);
    private static readonly Color RecordingColor = Color.FromArgb(190, 45, 45);
    private static readonly Color LiveSplitConnectedColor = Color.FromArgb(21, 116, 70);

    private readonly Spinner _spinner = new() { Margin = new Padding(0, 6, 10, 0) };
    private readonly Label _status = new()
    {
        AutoSize = false, Text = "Waiting for Game", TextAlign = ContentAlignment.MiddleLeft,
    };
    private readonly Label _saveLine = new()
    {
        AutoSize = true, Text = "No replay saved yet.", AutoEllipsis = true,
    };
    private readonly CheckBox _sendSplits = new()
    {
        Text = "Send splits to LiveSplit", AutoSize = true, Margin = new Padding(0, 0, 0, 4),
    };
    private readonly Label _liveSplitState = new()
    {
        AutoSize = true, Visible = false, Margin = new Padding(10, 1, 0, 0),
        ForeColor = ConnectedColor,
    };
    private readonly ComboBox _startPlayers = new()
    {
        DropDownStyle = ComboBoxStyle.DropDownList, Width = 150, Margin = new Padding(10, 0, 0, 2),
    };
    private readonly Button _towerMenu = new()
    {
        AutoSize = true, Text = "Tower Splits ▾", Padding = new Padding(10, 4, 10, 4),
        Margin = new Padding(14, 0, 0, 0),
    };
    private readonly ContextMenuStrip _towerMenuItems = new();
    private readonly Button _openFolder = new()
    {
        AutoSize = true, Text = "Open recordings folder", Padding = new Padding(12, 6, 12, 6),
    };
    private readonly Button _copyLive = new()
    {
        AutoSize = true, Text = "Copy live link", Padding = new Padding(12, 6, 12, 6), Visible = false,
    };
    private readonly Label _liveLabel = new()
    {
        AutoSize = true, ForeColor = WaitingColor, Margin = new Padding(0, 10, 0, 0),
    };
    private readonly TextBox _folder = new() { ReadOnly = true, Dock = DockStyle.Fill, TabStop = true };
    private readonly Icon _appIcon = new(typeof(RecorderForm), "AppIcon.ico");
    private readonly bool _exitWithGame;
    private readonly int _graceSeconds;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly bool _liveEnabled;
    private readonly string? _liveError;
    private readonly TowerProgressTracker _towerTracker = new();
    private readonly EndgameTeleportTracker _endgameTracker = new();
    private readonly LiveSplitAutosplit _liveSplit;
    private readonly System.Windows.Forms.Timer _liveTimer = new() { Interval = 1000 };
    private readonly System.Windows.Forms.Timer _liveSplitTimer = new() { Interval = 500 };
    private CancellationTokenSource? _stop;
    private Task _runTask = Task.CompletedTask;
    private string? _outputDirectory;
    private string? _currentFileName;
    private bool _recordingActive;
    private string _lastSavedLine = "No replay saved yet.";
    private int? _gamePid;
    private bool _closing;
    private bool _allowClose;
    private LiveSession? _liveSession;
    private LiveWebSocketServer? _liveServer;
    private DateTime _copyNoticeUntil = DateTime.MinValue;

    public RecorderForm(bool exitWithGame = false, int? gamePid = null, int graceSeconds = 25,
        bool liveEnabled = true, int livePort = 8787, string liveBind = "127.0.0.1",
        string? liveSplitMode = null)
    {
        string? requestedMode = liveSplitMode?.Trim().ToLowerInvariant();
        bool? requestedSend = requestedMode switch
        {
            "split" or "send" or "send-splits" => true,
            "log" or "log-only" or "logonly" or "off" => false,
            _ => null,
        };
        DesktopSettings saved = LoadSettings();
        bool sendSplits = requestedSend ?? saved.SendSplits;
        int startPlayers = Math.Clamp(saved.AutoStartPlayers, 0, 12);
        _liveSplit = new LiveSplitAutosplit(_towerTracker);
        _sendSplits.Checked = sendSplits;
        _liveSplit.Mode = sendSplits ? LiveSplitMode.Split : LiveSplitMode.LogOnly;
        _startPlayers.DrawMode = DrawMode.OwnerDrawFixed;
        _startPlayers.ItemHeight = 40;
        _startPlayers.DrawItem += DrawStartPlayerItem;
        _startPlayers.Items.Add("Off");
        for (int i = 1; i <= 12; i++)
        {
            _startPlayers.Items.Add(i == 1 ? "1 player" : $"{i} players");
        }
        _startPlayers.SelectedIndex = startPlayers;
        _liveSplit.StartAtPlayers = startPlayers;
        _sendSplits.CheckedChanged += (_, _) =>
        {
            _liveSplit.Mode = _sendSplits.Checked ? LiveSplitMode.Split : LiveSplitMode.LogOnly;
            SaveSettings();
            UpdateLiveSplitIndicator();
        };
        _startPlayers.SelectedIndexChanged += (_, _) =>
        {
            _liveSplit.StartAtPlayers = _startPlayers.SelectedIndex;
            SaveSettings();
        };
        _exitWithGame = exitWithGame;
        _gamePid = gamePid;
        _graceSeconds = graceSeconds;
        _liveEnabled = liveEnabled;
        if (liveEnabled)
        {
            try
            {
                _liveSession = new LiveSession("Big Replay");
                _liveServer = LiveWebSocketServer.Start(liveBind, livePort, _liveSession);
            }
            catch (Exception ex)
            {
                _liveError = ex.Message;
                _liveSession = null;
                _liveServer = null;
            }
        }
        _liveTimer.Tick += (_, _) => UpdateLiveStatus();
        Text = "Big Replay";
        Icon = _appIcon;
        Disposed += (_, _) =>
        {
            _liveTimer.Stop();
            _liveTimer.Dispose();
            _liveSplitTimer.Stop();
            _liveSplitTimer.Dispose();
            _lifetime.Cancel();
            _lifetime.Dispose();
            _towerMenuItems.Dispose();
            _appIcon.Dispose();
        };
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.None;
        ClientSize = new Size(760, 540);
        MinimumSize = new Size(760, 540);
        BackColor = Color.FromArgb(247, 248, 250);
        Font = new Font("Segoe UI", 10);

        _status.Font = new Font(Font.FontFamily, 18, FontStyle.Bold);
        _status.ForeColor = WaitingColor;
        _saveLine.ForeColor = WaitingColor;
        _liveLabel.Font = new Font(Font.FontFamily, 9);
        _spinner.SpinnerColor = WaitingColor;
        _spinner.Active = true;

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill, Padding = new Padding(28, 24, 28, 24),
            ColumnCount = 1, RowCount = 2,
        };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));

        var content = new TableLayoutPanel
        {
            Dock = DockStyle.Fill, AutoScroll = false, ColumnCount = 1, RowCount = 4, Margin = Padding.Empty,
        };
        content.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (int i = 0; i < content.RowCount; i++)
        {
            content.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        }


        var statusRow = new TableLayoutPanel
        {
            AutoSize = false, Height = 100, Dock = DockStyle.Fill,
            ColumnCount = 2, RowCount = 1, Margin = new Padding(0, 0, 0, 6),
        };
        statusRow.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        statusRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        statusRow.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        _spinner.Anchor = AnchorStyles.Left;
        _spinner.Margin = new Padding(0, 0, 12, 0);
        _status.Dock = DockStyle.Fill;
        statusRow.Controls.Add(_spinner, 0, 0);
        statusRow.Controls.Add(_status, 1, 0);

        _saveLine.Margin = new Padding(0, 0, 0, 20);
        _sendSplits.Margin = new Padding(0, 0, 0, 4);

        var liveSplitRow = new FlowLayoutPanel
        {
            AutoSize = true, WrapContents = false, Dock = DockStyle.Fill,
            Margin = new Padding(0, 0, 0, 10),
        };
        _liveSplitState.Font = new Font(Font.FontFamily, 10);
        liveSplitRow.Controls.Add(_sendSplits);
        liveSplitRow.Controls.Add(_liveSplitState);

        var autoStartRow = new FlowLayoutPanel
        {
            AutoSize = true, WrapContents = false, Dock = DockStyle.Fill,
            Margin = new Padding(0, 0, 0, 8),
        };
        autoStartRow.Controls.Add(new Label
        {
            Text = "Auto-start at", AutoSize = true, Margin = new Padding(0, 5, 0, 0),
        });
        autoStartRow.Controls.Add(_startPlayers);
        autoStartRow.Controls.Add(_towerMenu);

        _towerMenuItems.Items.Add(new ToolStripMenuItem("Split on") { Enabled = false });
        foreach (var group in GourdReceptacles.Groups)
        {
            string tower = group.Name;
            string label = tower switch
            {
                "Black" => "Final (Black)",
                "Storage" => "Storage/Overflow",
                _ => tower,
            };
            var item = new ToolStripMenuItem(label) { CheckOnClick = true, Checked = true };
            item.CheckedChanged += (_, _) => _liveSplit.SetTowerEnabled(tower, item.Checked);
            _towerMenuItems.Items.Add(item);
        }
        _towerMenuItems.Items.Add(new ToolStripSeparator());
        var finishItem = new ToolStripMenuItem("Finish on endgame teleport")
        {
            CheckOnClick = true, Checked = true,
        };
        finishItem.CheckedChanged += (_, _) => _liveSplit.FinishOnEndgameTeleport = finishItem.Checked;
        _towerMenuItems.Items.Add(finishItem);
        _towerMenu.Click += (_, _) =>
            _towerMenuItems.Show(_towerMenu, new Point(0, _towerMenu.Height));
        Resize += (_, _) => _towerMenuItems.Close();

        content.Controls.Add(statusRow);
        content.Controls.Add(_saveLine);
        content.Controls.Add(liveSplitRow);
        content.Controls.Add(autoStartRow);

        var folderTitle = new Label
        {
            Text = "Save replays to", AutoSize = true, Font = new Font(Font.FontFamily, 10, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, 4),
        };
        _folder.Margin = Padding.Empty;
        var buttons = new FlowLayoutPanel
        {
            AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0, 12, 0, 0),
        };
        buttons.Controls.Add(_openFolder);
        _copyLive.Visible = _liveServer is not null;
        buttons.Controls.Add(_copyLive);

        var footer = new TableLayoutPanel
        {
            Dock = DockStyle.None, Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom,
            AutoSize = false, Height = 190, ColumnCount = 1, RowCount = 4, Margin = Padding.Empty,
        };
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (int i = 0; i < footer.RowCount; i++)
        {
            footer.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        }
        footer.Controls.Add(folderTitle);
        footer.Controls.Add(_folder);
        footer.Controls.Add(buttons);
        footer.Controls.Add(_liveLabel);

        root.Controls.Add(content, 0, 0);
        root.Controls.Add(footer, 0, 1);
        Controls.Add(root);
        content.SizeChanged += (_, _) =>
        {
            int width = Math.Max(160, content.ClientSize.Width - 8);
            foreach (var label in new[] { _status, _saveLine, _liveLabel })
            {
                label.MaximumSize = new Size(width, 0);
            }
        };
        _copyLive.Click += (_, _) => CopyLiveLink();
        _openFolder.Click += (_, _) => OpenFolder();
        Shown += (_, _) =>
        {
            _startPlayers.SelectedIndex = -1;
            _startPlayers.SelectedIndex = startPlayers;
            _startPlayers.Refresh();
            StartMonitoring();
            UpdateLiveStatus();
            _liveTimer.Start();
            _liveSplitTimer.Tick += (_, _) => UpdateLiveSplitIndicator();
            _liveSplitTimer.Start();
            _liveSplit.Start();
            UpdateLiveSplitIndicator();
            if (_exitWithGame)
            {
                _ = ExitWatcherAsync(_lifetime.Token);
            }
        };
    }

    private void UpdateLiveStatus()
    {
        if (_copyNoticeUntil != default && DateTime.UtcNow >= _copyNoticeUntil)
        {
            _copyNoticeUntil = default;
            _copyLive.Text = "Copy live link";
        }
        if (_liveServer is null || _liveSession is null)
        {
            _liveLabel.Text = !_liveEnabled
                ? "Live sharing is off."
                : _liveError is null
                    ? "Live sharing is unavailable."
                    : $"Live sharing unavailable: {_liveError}";
            return;
        }
        string state = _liveSession.IsRunning
            ? $"{_liveSession.FrameCount:N0} frames"
            : "waiting for a walk";
        int viewers = _liveServer.ClientCount;
        _liveLabel.Text =
            $"Live: {state} · {(viewers == 1 ? "1 viewer" : $"{viewers} viewers")}";
    }

    private void UpdateLiveSplitIndicator()
    {
        if (!_sendSplits.Checked)
        {
            _liveSplitState.Visible = false;
            return;
        }
        _liveSplitState.Visible = true;
        if (_liveSplit.IsCountingDown)
        {
            _liveSplitState.Text = $"Starting in {_liveSplit.CountdownSecondsRemaining}";
            _liveSplitState.ForeColor = ConnectedColor;
            return;
        }
        bool connected = _liveSplit.IsConnected;
        _liveSplitState.Text = connected ? "Connected" : "Checking for LiveSplit";
        _liveSplitState.ForeColor = connected ? LiveSplitConnectedColor : ConnectedColor;
    }

    private void DrawStartPlayerItem(object? sender, DrawItemEventArgs e)
    {
        int index = e.Index >= 0 ? e.Index : _startPlayers.SelectedIndex;
        if (index < 0 || index >= _startPlayers.Items.Count)
        {
            return;
        }
        e.DrawBackground();
        string text = _startPlayers.GetItemText(_startPlayers.Items[index]) ?? string.Empty;
        Color color = (e.State & DrawItemState.Selected) != 0
            ? SystemColors.HighlightText
            : e.ForeColor;
        TextRenderer.DrawText(e.Graphics, text, _startPlayers.Font, e.Bounds, color,
            TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        if ((e.State & DrawItemState.Focus) != 0)
        {
            e.DrawFocusRectangle();
        }
    }

    private static string SettingsPath()
    {
        string root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(root))
        {
            root = AppContext.BaseDirectory;
        }
        return Path.Combine(root, "BigReplay", "settings.json");
    }

    private static DesktopSettings LoadSettings()
    {
        try
        {
            string path = SettingsPath();
            if (!File.Exists(path))
            {
                return new DesktopSettings();
            }
            return JsonSerializer.Deserialize<DesktopSettings>(File.ReadAllText(path))
                ?? new DesktopSettings();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return new DesktopSettings();
        }
    }

    private void SaveSettings()
    {
        try
        {
            string path = SettingsPath();
            string? directory = Path.GetDirectoryName(path);
            if (directory is not null)
            {
                Directory.CreateDirectory(directory);
            }
            var settings = new DesktopSettings
            {
                SendSplits = _sendSplits.Checked,
                AutoStartPlayers = Math.Clamp(_startPlayers.SelectedIndex, 0, 12),
            };
            File.WriteAllText(path, JsonSerializer.Serialize(settings));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            // A settings write must never affect recording.
        }
    }

    private sealed class DesktopSettings
    {
        public bool SendSplits { get; set; }
        public int AutoStartPlayers { get; set; } = 12;
    }

    private void CopyLiveLink()
    {
        if (_liveServer is null)
        {
            return;
        }
        try
        {
            Clipboard.SetText(LiveViewerLink.For(_liveServer.Url));
            _copyLive.Text = "Copied";
            _copyNoticeUntil = DateTime.UtcNow.AddSeconds(3);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "Could not copy the link", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private void StartMonitoring()
    {
        _stop?.Dispose();
        _stop = new CancellationTokenSource();
        _runTask = MonitorAsync(_stop.Token);
    }

    private async Task ExitWatcherAsync(CancellationToken token)
    {
        bool seen = false;
        try
        {
            while (!token.IsCancellationRequested)
            {
                bool alive = IsGameAlive();
                if (alive)
                {
                    seen = true;
                }
                else if (!seen && _gamePid is not null)
                {
                    _gamePid = null;
                    seen = AnyBigWalkRunning();
                }
                else if (seen)
                {
                    if (await GraceElapsedAsync(token))
                    {
                        RequestClose();
                        return;
                    }
                    continue;
                }

                await Task.Delay(2000, token);
            }
        }
        catch (OperationCanceledException)
        {
        }
    }

    private async Task<bool> GraceElapsedAsync(CancellationToken token)
    {
        for (int i = 0; i < _graceSeconds; i++)
        {
            await Task.Delay(1000, token);
            if (IsGameAlive())
            {
                return false;
            }
        }
        return true;
    }

    private bool IsGameAlive()
    {
        if (_gamePid is int pid)
        {
            try
            {
                using var process = Process.GetProcessById(pid);
                return !process.HasExited;
            }
            catch (ArgumentException)
            {
                return false;
            }
        }
        return AnyBigWalkRunning();
    }

    private static bool AnyBigWalkRunning()
    {
        var processes = Process.GetProcessesByName(GameProcess.ProcessName);
        try
        {
            return processes.Length > 0;
        }
        finally
        {
            foreach (var process in processes)
            {
                process.Dispose();
            }
        }
    }

    private void RequestClose()
    {
        if (_closing || IsDisposed)
        {
            return;
        }
        try
        {
            BeginInvoke(new Action(Close));
        }
        catch (InvalidOperationException)
        {
        }
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
            ManifestLoader.Load(manifest);
            var progress = new Progress<RecordingStatus>(sample =>
            {
                if (token.IsCancellationRequested || !_recordingActive)
                {
                    return;
                }
                _liveSplit.ObservePlayers(sample.Players);
                if (sample.Frames == 0)
                {
                    SetStatus("Waiting for Walk", ConnectedColor, spinning: true);
                }
                else
                {
                    SetStatus("Recording", RecordingColor, spinning: true);
                    if (_currentFileName is not null)
                    {
                        _saveLine.Text = $"Current: {_currentFileName}";
                    }
                }
            });
            while (!token.IsCancellationRequested)
            {
                try
                {
                _liveSplit.ObservePlayers(0);
                SetStatus("Waiting for Game", WaitingColor, spinning: true);
                GameProcess? game = null;
                var processes = Process.GetProcessesByName(GameProcess.ProcessName);
                bool running = processes.Length > 0;
                foreach (var process in processes) process.Dispose();
                if (running)
                {
                    try
                    {
                        game = await Task.Run(() => GameProcess.Attach(), token);
                        SetStatus("Waiting for Walk", ConnectedColor, spinning: true);
                    }
                    catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
                    {
                        SetStatus("Waiting for Game", WaitingColor, spinning: true);
                        _saveLine.Text = ex.Message;
                    }
                }
                if (game is not null)
                {
                    using (game)
                    {
                        string path = Path.Combine(_outputDirectory,
                            $"bigreplay-{DateTime.Now:yyyyMMdd-HHmmss-fff}-{Guid.NewGuid().ToString("N")[..8]}{ReplayFile.Extension}");
                        _currentFileName = Path.GetFileName(path);
                        _saveLine.Text = $"Current: {_currentFileName}";
                        _recordingActive = true;
                        try
                        {
                            var result = await Task.Run(() =>
                            {
                                var layout = GameLayout.Attach(game, manifest);
                                return RecordingSession.Record(new GameStateReader(game, layout), path, 10, 0, token,
                                    sample => ((IProgress<RecordingStatus>)progress).Report(sample), _liveSession,
                                    _towerTracker, _liveSplit.Observe,
                                    _endgameTracker, _liveSplit.ObserveEndgame);
                            }, token);
                            if (result.Path is not null)
                            {
                                _lastSavedLine = $"Last saved: {Path.GetFileName(result.Path)}";
                            }
                            _saveLine.Text = _lastSavedLine;
                        }
                        catch
                        {
                            _saveLine.Text = File.Exists(path + ".partial")
                                ? $"Unfinished capture: {Path.GetFileName(path)}.partial"
                                : _lastSavedLine;
                            throw;
                        }
                        finally
                        {
                            _currentFileName = null;
                            _recordingActive = false;
                        }
                    }
                }
                await Task.Delay(2000, token);
                }
                catch (Exception ex) when (!token.IsCancellationRequested)
                {
                    SetStatus("Recording stopped", RecordingColor, spinning: false);
                    _saveLine.Text = ex.Message;
                    await Task.Delay(2000, token);
                }
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception ex)
        {
            SetStatus("Recording stopped", RecordingColor, spinning: false);
            _saveLine.Text = ex.Message;
            if (_closing)
            {
                MessageBox.Show(this, ex.Message + "\nAny unfinished capture is kept with a .partial extension.",
                    "Replay could not be saved", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            return;
        }
    }

    private void SetStatus(string title, Color color, bool spinning)
    {
        _status.Text = title;
        _status.ForeColor = color;
        _spinner.SpinnerColor = color;
        _spinner.Active = spinning;
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
            SetStatus("Finishing recording", WaitingColor, spinning: true);
            _stop?.Cancel();
            await _runTask;
            _stop?.Dispose();
            _liveSplitTimer.Stop();
            await _liveSplit.DisposeAsync();
            if (_liveServer is not null)
            {
                _liveTimer.Stop();
                _liveServer.DisposeAsync().AsTask().GetAwaiter().GetResult();
                _liveServer = null;
                _liveSession = null;
            }
            _spinner.Active = false;
            _allowClose = true;
            Close();
            return;
        }
        base.OnFormClosing(e);
    }
}
