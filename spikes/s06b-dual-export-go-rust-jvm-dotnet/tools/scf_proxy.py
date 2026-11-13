"""Header-recording reverse proxy in front of the UsageMap test Collector (stdlib only).

Every request is forwarded unchanged to UPSTREAM; one JSON line per request is appended to LOG with the
current scenario name, path, upstream status, the Authorization value classified (the spike uses fake
test tokens only) and the names of all other headers. `POST /__scenario/<name>` sets the scenario label.
"""
import json
import ssl
import threading
import os
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ.get("UPSTREAM", "http://scf:4318")
LOG = os.environ.get("LOG", "/out/scf-proxy.jsonl")
GOOD = os.environ["SCF_OTLP_TOKEN"]
HOP = {"host", "content-length", "connection", "transfer-encoding", "keep-alive"}
state = {"scenario": "unset"}


def classify(auth):
    if auth is None:
        return "absent"
    if auth == f"Bearer {GOOD}":
        return "Bearer <SCF token>"
    return auth  # test values only (e.g. "Bearer WRONG")


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _reply(self, code, body=b"", ctype="text/plain", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        if self.path.startswith("/__scenario/"):
            state["scenario"] = self.path.split("/", 2)[2]
            return self._reply(200, b"ok")
        fwd = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        req = urllib.request.Request(UPSTREAM + self.path, data=body, headers=fwd, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                code, rbody, rtype = r.status, r.read(), r.headers.get("Content-Type", "application/x-protobuf")
        except urllib.error.HTTPError as e:
            code, rbody, rtype = e.code, e.read(), e.headers.get("Content-Type", "text/plain")
        except Exception as e:  # upstream down
            code, rbody, rtype = 503, str(e).encode(), "text/plain"
        rec = {
            "ts": round(time.time(), 3),
            "scenario": state["scenario"],
            "path": self.path,
            "status": code,
            "authorization": classify(self.headers.get("Authorization")),
            "api_key_header_present": self.headers.get("api-key") is not None,
            "user_agent": self.headers.get("User-Agent"),
            "content_type": self.headers.get("Content-Type"),
            "content_encoding": self.headers.get("Content-Encoding"),
            "header_names": sorted(k.lower() for k in self.headers.keys()),
            "bytes": len(body),
            "tls": isinstance(self.connection, ssl.SSLSocket),
        }
        with open(LOG, "a") as f:
            f.write(json.dumps(rec) + "\n")
        self._reply(code, rbody, rtype)


if __name__ == "__main__":
    print(f"scf_proxy -> {UPSTREAM}", file=sys.stderr, flush=True)
    if os.environ.get("TLS_CERT") and os.path.exists(os.environ["TLS_CERT"]):
        # Optional second listener on :4443 with TLS (self-signed cert for "scf-proxy", made by run.sh).
        tls = ThreadingHTTPServer(("0.0.0.0", 4443), H)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(os.environ["TLS_CERT"], os.environ["TLS_KEY"])
        tls.socket = ctx.wrap_socket(tls.socket, server_side=True)
        threading.Thread(target=tls.serve_forever, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 4318), H).serve_forever()
