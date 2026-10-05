#!/usr/bin/env python3
"""Minimal hook receiver for the spike. Modes: ok | slow:<secs> | status:<code>."""
import json, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
port, mode, out = int(sys.argv[1]), sys.argv[2], sys.argv[3]
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0)); body = self.rfile.read(n)
        rec = {"recv_monotonic": time.monotonic(), "recv_wall": time.time(), "path": self.path,
               "headers": dict(self.headers), "body": json.loads(body or b'null')}
        with open(out, 'a') as f: f.write(json.dumps(rec) + "\n")
        if mode.startswith('slow:'): time.sleep(float(mode[5:]))
        code = int(mode[7:]) if mode.startswith('status:') else 200
        self.send_response(code); self.send_header('Content-Type','application/json'); self.end_headers()
        self.wfile.write(b'{}')
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', port), H).serve_forever()
