"""Serve Chalkside on http://localhost:8790 with browser caching turned off.

For development: `py -3 dev/serve.py [port]` from the tutor folder.
"""

import functools
import http.server
import sys
from pathlib import Path


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
    root = Path(__file__).resolve().parent.parent
    handler = functools.partial(NoCacheHandler, directory=str(root))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
        print(f"Chalkside on http://localhost:{port}  (add ?mock for the fake tutor)")
        server.serve_forever()


if __name__ == "__main__":
    main()
