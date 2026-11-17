#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Unit test of the managed-identity mode of bin/scf-azblob (lean profile, C-123, F10) inside the HA image, without
# Azure: a fake instance-metadata service and a fake blob endpoint (Python standard library, loopback only, no
# network) record what the client sends. Asserts: the token request carries `Metadata: true` and the storage
# resource; put/get/list/delete carry `Authorization: Bearer <token>` and x-ms-version, never a SAS query string;
# the token never appears in the client's output; no token → non-zero exit.
#
#   infra/compose/ha/tests/azblob-msi.sh [IMAGE]
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)" # infra/compose/ha
IMG=${1:-usagemap/postgres-ha:18.7-pgbr2.60.0-patroni4.1.5}
docker run --rm -i --network none --read-only --tmpfs /tmp:size=16m --cap-drop ALL \
  -v "$HERE/bin/scf-azblob:/t/scf-azblob:ro" --entrypoint bash "$IMG" -s <<'IN'
set -euo pipefail
cat >/tmp/fake.py <<'PY'
import http.server, json, sys
log = open("/tmp/requests.log", "a")
TOKEN = "tok-SECRET-0123456789"
blobs = {}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def rec(self):
        log.write(json.dumps({"m": self.command, "p": self.path, "h": {k.lower(): v for k, v in self.headers.items()}}) + "\n"); log.flush()
    def do_GET(self):
        self.rec()
        if self.path.startswith("/metadata/identity/oauth2/token"):
            if self.headers.get("Metadata") != "true" or "resource=https%3A%2F%2Fstorage.azure.com%2F" not in self.path:
                self.send_response(400); self.end_headers(); return
            if sys.argv[1] == "notoken":
                self.send_response(500); self.end_headers(); return
            b = json.dumps({"access_token": TOKEN, "token_type": "Bearer"}).encode()
            self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b); return
        if "comp=list" in self.path:
            b = ("<EnumerationResults><Blobs>" + "".join(f"<Blob><Name>{n}</Name></Blob>" for n in blobs) + "</Blobs><NextMarker/></EnumerationResults>").encode()
            self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b); return
        name = self.path.split("/", 3)[3]
        b = blobs.get(name, b"")
        self.send_response(200 if name in blobs else 404); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_PUT(self):
        self.rec()
        n = int(self.headers.get("Content-Length", 0)); data = self.rfile.read(n)
        blobs[self.path.split("/", 3)[3]] = data
        self.send_response(201); self.send_header("Content-Length", "0"); self.end_headers()
    def do_DELETE(self):
        self.rec(); blobs.pop(self.path.split("/", 3)[3], None)
        self.send_response(202); self.send_header("Content-Length", "0"); self.end_headers()
http.server.HTTPServer(("127.0.0.1", int(sys.argv[2])), H).serve_forever()
PY
python3 -I /tmp/fake.py ok 18080 & python3 -I /tmp/fake.py notoken 18081 &
sleep 1
export SCF_AZ_IMDS=http://127.0.0.1:18080
B=http://127.0.0.1:18080/acct
echo hello >/tmp/in
out=$( { /t/scf-azblob put "$B" pgbackrest msi dumps/x/dump.tar.age /tmp/in
         /t/scf-azblob list "$B" pgbackrest msi dumps/
         /t/scf-azblob get "$B" pgbackrest msi dumps/x/dump.tar.age /tmp/out
         /t/scf-azblob delete "$B" pgbackrest msi dumps/x/dump.tar.age; } 2>&1)
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
check "round trip" 'cmp -s /tmp/in /tmp/out && grep -qx "dumps/x/dump.tar.age" <<<"$out"'
check "token request has Metadata: true" 'python3 -I -c "import json,sys; r=[json.loads(l) for l in open(\"/tmp/requests.log\")]; t=[x for x in r if x[\"p\"].startswith(\"/metadata\")]; sys.exit(0 if t and all(x[\"h\"].get(\"metadata\")==\"true\" for x in t) else 1)"'
check "every blob request has the bearer token and x-ms-version, no SAS" 'python3 -I -c "import json,sys; r=[json.loads(l) for l in open(\"/tmp/requests.log\")]; b=[x for x in r if x[\"p\"].startswith(\"/acct\")]; sys.exit(0 if len(b)==4 and all(x[\"h\"].get(\"authorization\")==\"Bearer tok-SECRET-0123456789\" and x[\"h\"].get(\"x-ms-version\") and \"sig=\" not in x[\"p\"] and \"msi\" not in x[\"p\"] for x in b) else 1)"'
check "token not printed" '! grep -q "tok-SECRET" <<<"$out"'
check "no header file left behind" '! ls /tmp/tmp.* >/dev/null 2>&1'
if SCF_AZ_IMDS=http://127.0.0.1:18081 /t/scf-azblob put "$B" pgbackrest msi y /tmp/in >/tmp/err 2>&1; then echo "FAIL no token -> error"; fail=1; else echo "PASS no token -> error ($(tail -n1 /tmp/err))"; fi
exit $fail
IN
