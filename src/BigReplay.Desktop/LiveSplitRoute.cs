using System.Diagnostics;
using System.Xml.Linq;
using Replay.Format;

namespace BigReplay.Desktop;

/// <summary>
/// LiveSplit's current splits file. LiveSplit 1.8.37 does not expose split counts or arbitrary
/// split names over the pipe, so the route comes from the `.lss` named in the running
/// LiveSplit's settings.cfg. If that file is unavailable or stale, the coordinator falls back
/// to the current segment name returned by `getcurrentsplitname`.
///
/// The same files identify a configured AutoSplitter. Two producers advancing one timer is
/// never safe, and 1.8.37 has no pipe command that reports the active autosplitter.
/// </summary>
internal sealed class LiveSplitRoute
{
    public IReadOnlyList<string> Segments { get; }
    public string SourcePath { get; }
    public string? AutoSplitter { get; }

    private LiveSplitRoute(IReadOnlyList<string> segments, string sourcePath, string? autoSplitter)
    {
        Segments = segments;
        SourcePath = sourcePath;
        AutoSplitter = autoSplitter;
    }

    public static LiveSplitRoute? TryLoad()
    {
        foreach (string settingsPath in SettingsPaths())
        {
            string? splitsPath = Resolve(settingsPath, ReadRecentSplits(settingsPath));
            string? layoutPath = Resolve(settingsPath, ReadRecentLayout(settingsPath));
            IReadOnlyList<string> segments = splitsPath is null ? [] : ReadSegments(splitsPath);
            string? autoSplitter = (splitsPath is null ? null : ReadAutoSplitterFromSplits(splitsPath))
                ?? (layoutPath is null ? null : ReadAutoSplitterFromLayout(layoutPath));
            if (segments.Count > 0 || autoSplitter is not null)
            {
                return new LiveSplitRoute(segments, splitsPath ?? layoutPath ?? settingsPath, autoSplitter);
            }
        }
        return null;
    }

    /// <summary>Re-read the split and layout files for a configured autosplitter.</summary>
    public static string? FindAutoSplitter()
    {
        foreach (string settingsPath in SettingsPaths())
        {
            string? splitsPath = Resolve(settingsPath, ReadRecentSplits(settingsPath));
            if (splitsPath is not null)
            {
                string? fromSplits = ReadAutoSplitterFromSplits(splitsPath);
                if (fromSplits is not null)
                {
                    return fromSplits;
                }
            }
            string? layoutPath = Resolve(settingsPath, ReadRecentLayout(settingsPath));
            if (layoutPath is not null)
            {
                string? fromLayout = ReadAutoSplitterFromLayout(layoutPath);
                if (fromLayout is not null)
                {
                    return fromLayout;
                }
            }
        }
        return null;
    }

    private static IReadOnlyList<string> SettingsPaths()
    {
        var paths = new List<string>();
        foreach (var process in Process.GetProcessesByName("LiveSplit"))
        {
            try
            {
                string? executable;
                try
                {
                    executable = process.MainModule?.FileName;
                }
                catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
                {
                    continue;
                }
                string? directory = Path.GetDirectoryName(executable);
                if (directory is not null)
                {
                    string settingsPath = Path.Combine(directory, "settings.cfg");
                    if (File.Exists(settingsPath) &&
                        !paths.Any(path => string.Equals(path, settingsPath,
                            StringComparison.OrdinalIgnoreCase)))
                    {
                        paths.Add(settingsPath);
                    }
                }
            }
            finally
            {
                process.Dispose();
            }
        }
        return paths;
    }

    private static string? Resolve(string settingsPath, string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return null;
        }
        path = path.Trim();
        if (!Path.IsPathRooted(path))
        {
            path = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(settingsPath) ?? "", path));
        }
        return File.Exists(path) ? path : null;
    }

    private static string? ReadRecentSplits(string settingsPath)
    {
        try
        {
            var document = XDocument.Load(settingsPath);
            return document.Descendants("SplitsFile")
                .Select(element => element.Value.Trim())
                .LastOrDefault(path => path.Length > 0);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException)
        {
            return null;
        }
    }

    private static string? ReadRecentLayout(string settingsPath)
    {
        try
        {
            var document = XDocument.Load(settingsPath);
            return document.Descendants("LayoutPath")
                .Select(element => element.Value.Trim())
                .LastOrDefault(path => path.Length > 0);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException)
        {
            return null;
        }
    }

    private static IReadOnlyList<string> ReadSegments(string splitsPath)
    {
        try
        {
            var document = XDocument.Load(splitsPath);
            return document.Descendants("Segment")
                .Select(segment => segment.Element("Name")?.Value.Trim() ?? string.Empty)
                .ToArray();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException)
        {
            return [];
        }
    }

    private static string? ReadAutoSplitterFromSplits(string splitsPath)
    {
        try
        {
            var document = XDocument.Load(splitsPath);
            XElement? settings = document.Descendants("AutoSplitterSettings").FirstOrDefault();
            string? scriptPath = settings?.Element("ScriptPath")?.Value.Trim();
            if (string.IsNullOrEmpty(scriptPath))
            {
                return null;
            }
            bool start = bool.TryParse(settings?.Element("Start")?.Value, out bool startValue) && startValue;
            bool split = bool.TryParse(settings?.Element("Split")?.Value, out bool splitValue) && splitValue;
            string state = start || split ? "active" : "configured";
            return $"{Path.GetFileName(scriptPath)} ({state} in the splits file)";
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException)
        {
            return null;
        }
    }

    private static string? ReadAutoSplitterFromLayout(string layoutPath)
    {
        try
        {
            var document = XDocument.Load(layoutPath);
            foreach (var component in document.Descendants("Component"))
            {
                string path = component.Element("Path")?.Value.Trim() ?? "";
                if (path.Contains("AutoSplit", StringComparison.OrdinalIgnoreCase) ||
                    path.Contains("ScriptableAutoSplit", StringComparison.OrdinalIgnoreCase))
                {
                    return $"the LiveSplit layout includes {Path.GetFileName(path)}";
                }
            }
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Xml.XmlException)
        {
            return null;
        }
    }

    /// <summary>First segment at or after <paramref name="from"/> whose name accepts the tower.</summary>
    public int FindAccepting(int from, string tower)
    {
        for (int i = Math.Max(0, from); i < Segments.Count; i++)
        {
            if (TowerSegmentRoute.Accepts(Segments[i], tower))
            {
                return i;
            }
        }
        return -1;
    }

    public bool Matches(int index, string currentName)
    {
        if (index < 0 || index >= Segments.Count)
        {
            return false;
        }
        return string.Equals(Segments[index].Trim(), currentName.Trim(), StringComparison.OrdinalIgnoreCase);
    }
}
