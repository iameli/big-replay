using System.Reflection;

namespace BigReplay.Live;

/// <summary>
/// The web viewer, bundled inside the app so the recorder can serve it from its own port.
///
/// This is what makes live playback work everywhere: a browser refuses ws:// from a page served
/// over https (mixed content), so the published https viewer can never open a live stream. Served
/// from http://127.0.0.1:PORT/ by the recorder itself, the page and the stream share an origin and
/// nothing has to be installed to watch.
/// </summary>
public static class ViewerAssets
{
    public const string DefaultPath = "index.html";

    private static readonly Assembly Assembly = typeof(ViewerAssets).Assembly;
    private static readonly Dictionary<string, byte[]> Cache = new(StringComparer.Ordinal);
    private static readonly Dictionary<string, string> Types = new(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html; charset=utf-8",
        [".js"] = "text/javascript; charset=utf-8",
        [".json"] = "application/json; charset=utf-8",
        [".webmanifest"] = "application/manifest+json; charset=utf-8",
        [".svg"] = "image/svg+xml",
        [".png"] = "image/png",
        [".ico"] = "image/x-icon",
        [".jpeg"] = "image/jpeg",
        [".jpg"] = "image/jpeg",
        [".gz"] = "application/gzip",
    };

    /// <summary>True when the build actually carries the viewer (a missing resource list is a bug).</summary>
    public static bool Available => Assembly.GetManifestResourceNames().Any(IsViewerResource);

    /// <summary>
    /// Resolves a request path to viewer content. Rejects traversal and anything not bundled.
    /// </summary>
    public static bool TryGet(string requestPath, out string contentType, out byte[] body)
    {
        contentType = "application/octet-stream";
        body = [];
        string path = requestPath.Split('?')[0].Split('#')[0].Replace('\\', '/').TrimStart('/');
        if (path.Length == 0)
        {
            path = DefaultPath;
        }
        if (path.Contains("..", StringComparison.Ordinal))
        {
            return false;
        }
        string resource = "viewer/" + path;
        if (!Assembly.GetManifestResourceNames().Any(name => name == resource))
        {
            return false;
        }
        contentType = Types.TryGetValue(Path.GetExtension(path), out string? type)
            ? type
            : "application/octet-stream";
        lock (Cache)
        {
            if (!Cache.TryGetValue(resource, out byte[]? cached))
            {
                using Stream stream = Assembly.GetManifestResourceStream(resource)!;
                using var buffer = new MemoryStream();
                stream.CopyTo(buffer);
                cached = buffer.ToArray();
                Cache[resource] = cached;
            }
            body = cached;
        }
        return true;
    }

    private static bool IsViewerResource(string name) => name.StartsWith("viewer/", StringComparison.Ordinal);
}