#!/usr/bin/env python3
"""Local viewer server that mimics the GitHub Pages deployment.

Serves the repository root at http://127.0.0.1:8080/ and answers unknown paths
(such as /did:plc:.../<rkey>) with index.html plus <base href="/">, like the
404.html the release workflow publishes. Use 127.0.0.1 rather than localhost so
the loopback OAuth client can sign in.
"""
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if os.path.exists(self.translate_path(self.path)):
            return super().do_GET()
        with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
            body = f.read().replace('<meta charset="utf-8">', '<meta charset="utf-8"><base href="/">', 1)
        data = body.encode("utf-8")
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f"Big Replay viewer at http://127.0.0.1:{port}/")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
