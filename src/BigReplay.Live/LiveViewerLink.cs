namespace BigReplay.Live;

/// <summary>
/// The link people actually open to watch a live run. The recorder serves the viewer itself on the
/// same port as the stream, so this is a plain http:// URL — which is also the only kind that
/// works: a browser refuses ws:// from a page served over https (mixed content).
/// </summary>
public static class LiveViewerLink
{
    public static string For(Uri endpoint)
    {
        ArgumentNullException.ThrowIfNull(endpoint);
        var viewer = new UriBuilder("http", endpoint.Host, endpoint.Port, "/").Uri;
        return $"{viewer}?live={Uri.EscapeDataString(endpoint.ToString())}";
    }
}