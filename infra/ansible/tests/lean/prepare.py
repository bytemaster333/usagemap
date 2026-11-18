# SPDX-License-Identifier: Apache-2.0
# Inputs of the lean-profile role test (run.sh, inside the tool container; /repo read-only, work dir /tmp/scf-lean-test):
#   1. the operating team's Alertmanager channels in the test secrets (URLs that never resolve) — the role refuses a
#      deploy without them;
#   2. tracker release directories in the release workflow's layout (lib/<v>/…, SHA256SUMS, release.json) from
#      tracker/dist — the bytes the gateway image built from this tree embeds — and a tampered copy for the negative run.
import hashlib
import json
import os
import shutil

WORK = "/tmp/scf-lean-test"
sec = os.path.join(WORK, "secrets.yml")
text = open(sec).read()
if "\n  alert_webhooks: {" not in text:
    hooks = ", ".join(f'{r}: "https://alerts.lean.test/{r}"'
                      for r in ("maintainers-critical", "maintainers-warning", "security-responders"))
    text = text.replace("scf_stack_secrets:\n", "scf_stack_secrets:\n  alert_webhooks: { " + hooks + " }\n", 1)
    with open(sec, "w") as fh:
        fh.write(text)

src, out = "/repo/tracker/dist", os.path.join(WORK, "tracker-release")
shutil.rmtree(out, ignore_errors=True)
for v in sorted(d for d in os.listdir(src) if d[0].isdigit()):
    base = os.path.join(out, v)
    shutil.copytree(os.path.join(src, v), os.path.join(base, "lib", v))
    files = sorted(os.path.relpath(os.path.join(r, f), base) for r, _, fs in os.walk(base) for f in fs)
    with open(os.path.join(base, "SHA256SUMS"), "w") as fh:
        for f in files:
            fh.write(hashlib.sha256(open(os.path.join(base, f), "rb").read()).hexdigest() + "  " + f + "\n")
    with open(os.path.join(base, "release.json"), "w") as fh:
        json.dump({"name": "@usagemap/tracker", "version": v, "dirty": False, "files": files}, fh)
tampered = os.path.join(WORK, "tracker-tampered")
shutil.rmtree(tampered, ignore_errors=True)
shutil.copytree(out, tampered)
v = sorted(os.listdir(tampered))[-1]
with open(os.path.join(tampered, v, "lib", v, "standard.js"), "a") as fh:
    fh.write("/* tampered */")
print("prepared:", sorted(os.listdir(out)))
