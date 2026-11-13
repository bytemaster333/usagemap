#!/usr/bin/env python3
"""Summarise what the stand-in collectors received (OTLP JSON lines written by the file exporter).

Usage: analyze.py OUT_DIR  -> prints Markdown, writes OUT_DIR/summary.json
Groups everything by (destination, service.name)."""
import json, sys, os, collections

OUT = sys.argv[1]
PII_KEYS = {
    "client.address", "client.port", "http.client_ip", "net.sock.peer.addr", "net.peer.ip", "http.client.address",
    "network.peer.address", "network.peer.port", "network.local.address", "user_agent.original", "http.user_agent",
    "url.full", "url.query", "url.original", "http.url", "http.target", "url.path", "server.address", "server.port",
    "net.host.name", "net.host.port", "http.host", "http.server_name", "host.name", "host.id", "process.owner",
    "process.command_args", "process.command_line", "process.executable.path", "process.command", "enduser.id",
}
CANARIES = ["canary-cursor-91", "canary%40example.com", "canary@example.com", "canary-ua-7f3a",
            "unmatched-canary-path", "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"]


def val(v):
    if not v:
        return None
    k, x = next(iter(v.items()))
    if k == "arrayValue":
        return [val(i) for i in x.get("values", [])]
    if k == "intValue":
        return int(x)
    return x


def attrs(lst):
    return {a["key"]: val(a.get("value", {})) for a in lst or []}


def svc_of(res):
    return attrs(res.get("attributes")).get("service.name", "?")


def new_entry():
    return {"resource_keys": set(), "seen": collections.defaultdict(set), "metrics": {}, "spans": collections.Counter(),
            "server_span_keys": set(), "server_span_routes": collections.Counter(), "server_span_names": collections.Counter(),
            "server_target_samples": set(), "span_scopes": set(), "logs": 0, "pii_keys": set(), "canaries": set(),
            "span_schema": set()}


data = collections.defaultdict(new_entry)
TOKEN = os.environ.get("SCF_OTLP_TOKEN", "scfa_ing_spiketoken")


def note_resource(e, res):
    ra = attrs(res.get("attributes"))
    for k, v in ra.items():
        if k.startswith("spike.seen."):
            h = k[len("spike.seen."):]
            if h == "authorization":
                v = "Bearer <SCF token>" if v == f"Bearer {TOKEN}" else f"OTHER({str(v)[:12]}...)"
            e["seen"][h].add(str(v))
        else:
            e["resource_keys"].add(k)
            if k in PII_KEYS:
                e["pii_keys"].add(f"resource:{k}")


def note_canaries(e, line):
    for c in CANARIES:
        if c in line:
            e["canaries"].add(c)


for dest in ("scf", "apm"):
    d = os.path.join(OUT, dest)
    # metrics
    p = os.path.join(d, "metrics.jsonl")
    if os.path.exists(p):
        for line in open(p):
            for rm in json.loads(line).get("resourceMetrics", []):
                e = data[(dest, svc_of(rm["resource"]))]
                note_resource(e, rm["resource"])
                note_canaries(e, json.dumps(rm))
                for sm in rm.get("scopeMetrics", []):
                    scope = f'{sm["scope"].get("name")}@{sm["scope"].get("version", "")}'
                    for m in sm.get("metrics", []):
                        kind = next(k for k in m if k in ("histogram", "exponentialHistogram", "sum", "gauge", "summary"))
                        me = e["metrics"].setdefault(m["name"], {"unit": m.get("unit"), "type": kind, "scopes": set(),
                                                                "schema": set(), "temporality": set(), "keys": set(),
                                                                "routes": collections.Counter(), "streams": {},
                                                                "bounds": None})
                        me["scopes"].add(scope)
                        me["schema"].add(sm.get("schemaUrl") or rm.get("schemaUrl") or "-")
                        body = m[kind]
                        if "aggregationTemporality" in body:
                            me["temporality"].add({1: "DELTA", 2: "CUMULATIVE"}.get(body["aggregationTemporality"], body["aggregationTemporality"]))
                        for dp in body.get("dataPoints", []):
                            a = attrs(dp.get("attributes"))
                            me["keys"].update(a)
                            for k in a:
                                if k in PII_KEYS:
                                    e["pii_keys"].add(f"metric:{m['name']}:{k}")
                            if kind in ("histogram", "exponentialHistogram"):
                                me["bounds"] = dp.get("explicitBounds", me["bounds"])
                                sk = (json.dumps(a, sort_keys=True), dp.get("startTimeUnixNano"))
                                # cumulative: keep the latest; delta: sum
                                cnt = int(dp.get("count", 0))
                                if body.get("aggregationTemporality") == 1:
                                    me["streams"][sk] = me["streams"].get(sk, 0) + cnt
                                else:
                                    me["streams"][sk] = max(me["streams"].get(sk, 0), cnt)
                                route = a.get("http.route", a.get("http.target", "<none>"))
                                rk = f'{a.get("http.request.method", a.get("http.method"))} {route} {a.get("http.response.status_code", a.get("http.status_code"))}'
                                me["routes"][rk] = max(me["routes"][rk], cnt)
    # traces
    p = os.path.join(d, "traces.jsonl")
    if os.path.exists(p):
        for line in open(p):
            for rs in json.loads(line).get("resourceSpans", []):
                e = data[(dest, svc_of(rs["resource"]))]
                note_resource(e, rs["resource"])
                note_canaries(e, json.dumps(rs))
                for ss in rs.get("scopeSpans", []):
                    e["span_scopes"].add(f'{ss["scope"].get("name")}@{ss["scope"].get("version", "")}')
                    e["span_schema"].add(ss.get("schemaUrl") or rs.get("schemaUrl") or "-")
                    for s in ss.get("spans", []):
                        kind = {1: "INTERNAL", 2: "SERVER", 3: "CLIENT", 4: "PRODUCER", 5: "CONSUMER"}.get(s.get("kind"), "UNSPECIFIED")
                        e["spans"][kind] += 1
                        a = attrs(s.get("attributes"))
                        for k in a:
                            if k in PII_KEYS:
                                e["pii_keys"].add(f"span:{kind}:{k}")
                        if kind == "SERVER":
                            e["server_span_keys"].update(a)
                            e["server_span_names"][s["name"]] += 1
                            e["server_span_routes"][str(a.get("http.route", "<none>"))] += 1
                            for k in ("http.target", "url.path", "url.query", "url.full", "http.url"):
                                if k in a:
                                    e["server_target_samples"].add(f"{k}={a[k]}")
    p = os.path.join(d, "logs.jsonl")
    if os.path.exists(p):
        for line in open(p):
            for rl in json.loads(line).get("resourceLogs", []):
                e = data[(dest, svc_of(rl["resource"]))]
                note_resource(e, rl["resource"])
                e["logs"] += sum(len(sl.get("logRecords", [])) for sl in rl.get("scopeLogs", []))

out_json = {}
for (dest, svc), e in sorted(data.items(), key=lambda kv: (kv[0][1], kv[0][0])):
    print(f"\n### {svc} -> {dest.upper()}\n")
    print(f"- headers seen by collector: {dict((k, sorted(v)) for k, v in e['seen'].items())}")
    print(f"- resource keys: {sorted(e['resource_keys'])}")
    print(f"- signals: metrics={len(e['metrics'])} names, spans={dict(e['spans'])}, log records={e['logs']}")
    for name, me in sorted(e["metrics"].items()):
        total = sum(me["streams"].values()) if me["streams"] else None
        print(f"- metric `{name}` unit={me['unit']} type={me['type']} temporality={sorted(me['temporality'])} "
              f"scope={sorted(me['scopes'])} schema={sorted(me['schema'])}")
        if me["type"] in ("histogram", "exponentialHistogram"):
            print(f"  - datapoint keys: {sorted(me['keys'])}")
            print(f"  - bounds: {me['bounds']}")
            print(f"  - total count: {total}; per method/route/status: {dict(sorted(me['routes'].items()))}")
    if e["spans"]:
        print(f"- span scopes: {sorted(e['span_scopes'])} schema={sorted(e['span_schema'])}")
        print(f"- SERVER span names: {dict(e['server_span_names'])}")
        print(f"- SERVER span http.route: {dict(e['server_span_routes'])}")
        print(f"- SERVER span keys: {sorted(e['server_span_keys'])}")
        print(f"- SERVER span path samples: {sorted(e['server_target_samples'])[:8]}")
    print(f"- personal-data-capable keys present: {sorted(e['pii_keys'])}")
    print(f"- canary values found in payload: {sorted(e['canaries'])}")
    out_json[f"{svc}->{dest}"] = {k: (sorted(v) if isinstance(v, set) else v) for k, v in e.items()
                                 if k not in ("metrics", "seen", "spans", "server_span_routes", "server_span_names")}
    out_json[f"{svc}->{dest}"]["metrics"] = {n: {"unit": m["unit"], "type": m["type"], "temporality": sorted(m["temporality"]),
                                                 "keys": sorted(m["keys"]), "total": sum(m["streams"].values()) if m["streams"] else None}
                                             for n, m in e["metrics"].items()}
    out_json[f"{svc}->{dest}"]["spans"] = dict(e["spans"])
    out_json[f"{svc}->{dest}"]["seen"] = {k: sorted(v) for k, v in e["seen"].items()}
json.dump(out_json, open(os.path.join(OUT, "summary.json"), "w"), indent=1)
