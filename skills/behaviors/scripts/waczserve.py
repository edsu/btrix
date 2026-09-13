#!/usr/bin/env python3
"""Serve a directory over HTTP with Range + CORS support.

ReplayWeb.page loads a remote .wacz by reading the ZIP index with HTTP range
requests (including `Range: bytes=-N` suffix requests for the end-of-central-
directory), then fetching individual entries — so it never downloads the whole
file. Python's built-in http.server does NOT support ranges, hence this shim.

Usage:
    python3 waczserve.py <directory> <port>

Then open, e.g.:
    https://replayweb.page/?source=http://localhost:<port>/mycrawl.wacz

Note: browsers treat http://localhost as a secure context, so a page on
https://replayweb.page is allowed to fetch it (not blocked as mixed content).
"""
import http.server
import os
import re
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, directory=None, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Accept-Ranges", "bytes")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            self.send_error(404)
            return

        size = os.path.getsize(path)
        rng = self.headers.get("Range")
        ctype = "application/octet-stream"

        if not rng:
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.end_headers()
            with open(path, "rb") as f:
                self.copyfile(f, self.wfile)
            return

        m = re.match(r"bytes=(\d*)-(\d*)", rng)
        g1, g2 = m.group(1), m.group(2)
        if g1 == "":
            # Suffix range: bytes=-N means the LAST N bytes (used to read the
            # ZIP end-of-central-directory). Do not confuse with the first N.
            n = int(g2)
            start = max(0, size - n)
            end = size - 1
        else:
            start = int(g1)
            end = int(g2) if g2 else size - 1
        end = min(end, size - 1)
        length = end - start + 1

        self.send_response(206)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def log_message(self, *args):
        pass  # quiet


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    directory, port = sys.argv[1], int(sys.argv[2])

    def factory(*args, **kwargs):
        return Handler(*args, directory=directory, **kwargs)

    print(f"serving {directory} at http://127.0.0.1:{port}  (Ctrl-C to stop)")
    http.server.ThreadingHTTPServer(("127.0.0.1", port), factory).serve_forever()


if __name__ == "__main__":
    main()
