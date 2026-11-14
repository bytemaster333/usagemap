#!/usr/bin/env python3
"""Extract real-SDK OTLP payloads from the S-06a/S-06b spike outputs into small test fixtures.

Run from the repository root (the spike outputs are git-ignored and exist only where the spikes ran):

    python3 -I collector/processor/scfsanitizeprocessor/testdata/gen/extract_sdk_fixtures.py

Input: what each SDK sent to the spike's "APM" sink (raw OTLP JSON, one ExportRequest per line).
Output: testdata/sdk/<fixture>.{metrics,traces}.json — one OTLP JSON ExportRequest each.

Changes made to the payloads (and only these):
- values of resource attributes outside the §f.5 resource allow-list are replaced by "CANARY-RES-<key>", so the
  fixtures carry no detail of the machine the spikes ran on and every such value is a detectable canary;
- spans are thinned to at most 3 per (scope, kind, route/target/path, status) to keep the files small;
- local file-system paths of the machine the spikes ran on (in exception stack traces of span events) are replaced
  by "/CANARY-PATH".
Everything else (attribute keys, value types, span flags, parent ids, histogram layout, exemplars, units) is as the
SDK sent it.
"""
import json
import os
import sys

ROOT = os.getcwd()
S06A = os.path.join(ROOT, "spikes/s06a-dual-export-node-python/out/apm")
S06B = os.path.join(ROOT, "spikes/s06b-dual-export-go-rust-jvm-dotnet/out")
OUT = os.path.join(ROOT, "collector/processor/scfsanitizeprocessor/testdata/sdk")

RESOURCE_KEEP = {"service.name", "service.instance.id", "service.namespace", "deployment.environment.name",
                 "deployment.environment", "telemetry.sdk.language", "telemetry.sdk.name", "telemetry.sdk.version"}

# fixture name -> (service.name, metrics file or None, traces file or None)
FIXTURES = {
    "node-express": ("s06a-express-sdk", f"{S06A}/metrics.jsonl", f"{S06A}/traces.jsonl"),
    "node-express-envauth": ("s06a-express-sdk-envauth", f"{S06A}/metrics.jsonl", f"{S06A}/traces.jsonl"),
    "node-legacy-0.220": ("s06a-node-0.220.0", f"{S06A}/metrics.jsonl", f"{S06A}/traces.jsonl"),
    "nextjs": ("s06a-next-sdk", None, f"{S06A}/traces.jsonl"),
    "python-default": ("s06a-fastapi-default", f"{S06A}/metrics.jsonl", f"{S06A}/traces.jsonl"),
    "python-stable": ("s06a-fastapi-stable", f"{S06A}/metrics.jsonl", f"{S06A}/traces.jsonl"),
    "go-otelhttp": ("s06b-go-code", f"{S06B}/apm-metrics.jsonl", f"{S06B}/apm-traces.jsonl"),
    "rust-tower": ("s06b-rust-tower", f"{S06B}/apm-metrics.jsonl", f"{S06B}/apm-traces.jsonl"),
    "rust-tracing": ("s06b-rust-tracing", None, f"{S06B}/apm-traces.jsonl"),
    "java-agent": ("s06b-java-otelconf", f"{S06B}/apm-metrics.jsonl", f"{S06B}/apm-traces.jsonl"),
    "dotnet": ("s06b-dotnet", f"{S06B}/apm-metrics.jsonl", f"{S06B}/apm-traces.jsonl"),
}


def attr_map(attrs):
    return {a["key"]: a["value"] for a in attrs or []}


def service_of(resource):
    v = attr_map(resource.get("attributes")).get("service.name", {})
    return v.get("stringValue")


def scrub_resource(resource):
    for a in resource.get("attributes", []):
        if a["key"] not in RESOURCE_KEEP:
            a["value"] = {"stringValue": "CANARY-RES-" + a["key"]}


def has_server_duration(rm):
    return any(m.get("name") in ("http.server.request.duration", "http.server.duration")
               for sm in rm.get("scopeMetrics", []) for m in sm.get("metrics", []))


def first_metrics(path, service):
    """The service's first export that carries a server duration metric (else its first export)."""
    first = None
    with open(path) as fh:
        for line in fh:
            req = json.loads(line)
            for rm in req.get("resourceMetrics", []):
                if service_of(rm["resource"]) != service:
                    continue
                if has_server_duration(rm):
                    scrub_resource(rm["resource"])
                    return {"resourceMetrics": [rm]}
                if first is None:
                    first = rm
    if first is None:
        return None
    scrub_resource(first["resource"])
    return {"resourceMetrics": [first]}


def thinned_traces(path, service):
    resource = None
    scopes = {}
    seen = {}
    with open(path) as fh:
        for line in fh:
            req = json.loads(line)
            for rs in req.get("resourceSpans", []):
                if service_of(rs["resource"]) != service:
                    continue
                if resource is None:
                    resource = rs["resource"]
                for ss in rs.get("scopeSpans", []):
                    sk = json.dumps(ss.get("scope", {}), sort_keys=True)
                    bucket = scopes.setdefault(sk, {"scope": ss.get("scope", {}), "spans": []})
                    for sp in ss.get("spans", []):
                        a = attr_map(sp.get("attributes"))
                        pathish = next((json.dumps(a[k]) for k in ("http.route", "url.path", "http.target", "url.full", "http.url") if k in a), "")
                        status = json.dumps(a.get("http.response.status_code", a.get("http.status_code", "")))
                        key = (sk, sp.get("kind"), pathish, status)
                        if seen.get(key, 0) >= 3:
                            continue
                        seen[key] = seen.get(key, 0) + 1
                        bucket["spans"].append(sp)
    if resource is None:
        return None
    scrub_resource(resource)
    return {"resourceSpans": [{"resource": resource, "scopeSpans": list(scopes.values())}]}


def write(path, obj):
    text = json.dumps(obj, sort_keys=True, separators=(",", ":"))
    for local in sorted({ROOT, os.path.expanduser("~")}, key=len, reverse=True):
        text = text.replace(local, "/CANARY-PATH")
    with open(path, "w") as fh:
        fh.write(text)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, (service, mpath, tpath) in FIXTURES.items():
        if mpath:
            m = first_metrics(mpath, service)
            if m is None:
                sys.exit(f"no metrics for {service}")
            write(f"{OUT}/{name}.metrics.json", m)
        if tpath:
            t = thinned_traces(tpath, service)
            if t is None:
                sys.exit(f"no traces for {service}")
            write(f"{OUT}/{name}.traces.json", t)


if __name__ == "__main__":
    main()
