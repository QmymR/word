"""Patched HTTP server for 甬上四季 that fixes Python's missing .mjs MIME.

Run: python _server.py
Then open: http://localhost:8000/
"""
import sys
import os
import mimetypes
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

# Force MIME extensions — must be set BEFORE SimpleHTTPRequestHandler loads,
# because it snapshots mimetypes.types_map at module import time on some
# platforms. On Windows the system registry can also override, so we also
# patch guess_type directly below.
mimetypes.init()
mimetypes.types_map[".mjs"]    = "application/javascript"
mimetypes.types_map[".js"]     = "application/javascript"
mimetypes.types_map[".wasm"]   = "application/wasm"
mimetypes.types_map[".task"]   = "application/octet-stream"
mimetypes.add_type("application/javascript", ".mjs", strict=False)
mimetypes.add_type("application/wasm",       ".wasm", strict=False)

# Verify:
# print("debug mjs ->", mimetypes.guess_type("x.mjs"))
# print("debug wasm ->", mimetypes.guess_type("x.wasm"))

PORT = 8000
BIND = "127.0.0.1"

class Handler(SimpleHTTPRequestHandler):
    server_version = "YongShangSiJi/1.0"

    # Override guess_type so Windows registry can't override our mapping
    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in (".mjs", ".js"):
            return "application/javascript", None
        if ext == ".wasm":
            return "application/wasm", None
        if ext in (".task", ".bin", ".model"):
            return "application/octet-stream", None
        return SimpleHTTPRequestHandler.guess_type(self, path)

    def end_headers(self):
        # Prevent stale MIME / JS being cached
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

if __name__ == "__main__":
    try:
        httpd = ThreadingHTTPServer((BIND, PORT), Handler)
    except OSError as e:
        print(f"Port {PORT} in use: {e}")
        sys.exit(1)
    print(f"Serving on http://{BIND}:{PORT}/  (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        httpd.shutdown()
