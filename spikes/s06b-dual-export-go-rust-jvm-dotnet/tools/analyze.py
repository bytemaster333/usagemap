"""Summarise what reached the APM and the UsageMap test collectors (stdlib only).

Usage: python3 -I tools/analyze.py out/ > evidence/report.md
Groups everything by resource service.name (each scenario uses its own service name).
"""
import collections
import json
import pathlib
import re
import sys

OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "out")
SENT = 44  # requests per scenario, see tools/traffic.sh
KIND = {0: "UNSPECIFIED", 1: "INTERNAL", 2: "SERVER", 3: "CLIENT", 4: "PRODUCER", 5: "CONSUMER"}
TEMP = {0: "unspecified", 1: "delta", 2: "cumulative"}
PII_KEYS = re.compile(
    r"^(client\.|network\.peer\.|network\.local\.|user_agent\.|http\.user_agent$|http\.client_ip$|http\.client\.address$"
    r"|net\.sock\.|url\.(full|query|original|fragment|path)$|http\.target$|http\.url$|http\.request\.header\.|"
    r"http\.response\.header\.|.*body\.content$|enduser\.|user\.|session\.|server\.address$|server\.port$|url\.domain$|"
    r"exception\.|host\.name$|host\.ip$|k8s\.pod\.ip$|process\.command_line$|process\.owner$|container\.|"
    r"process\.command_args$|process\.executable\.path$|process\.pid$)"
)
CANARY = re.compile(r"CANARY|canary|203\.0\.113\.7")
IP = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")


def val(v):
    for k in ("stringValue", "intValue", "doubleValue", "boolValue"):
        if k in v:
            return v[k]
    if "arrayValue" in v:
        return [val(x) for x in v["arrayValue"].get("values", [])]
    return json.dumps(v)


def attrs(lst):
    return {a["key"]: val(a.get("value", {})) for a in (lst or [])}


def show(v):
    s = str(v)
    if not CANARY.search(s):
        s = IP.sub("<docker-ip>", s)
    return s if len(s) <= 70 else s[:67] + "..."


def lines(name):
    p = OUT / name
    if not p.exists():
        return
    for ln in p.read_text().splitlines():
        if ln.strip():
            yield json.loads(ln)


def metrics(dest):
    res = collections.defaultdict(lambda: {"resource": {}, "metrics": {}})
    for doc in lines(f"{dest}-metrics.jsonl"):
        for rm in doc.get("resourceMetrics", []):
            ra = attrs(rm.get("resource", {}).get("attributes"))
            svc = ra.get("service.name", "?")
            res[svc]["resource"].update(ra)
            for sm in rm.get("scopeMetrics", []):
                scope = sm.get("scope", {}).get("name", "") + " " + sm.get("scope", {}).get("version", "")
                for m in sm.get("metrics", []):
                    typ = next((t for t in ("histogram", "exponentialHistogram", "sum", "gauge", "summary") if t in m), "?")
                    key = (scope.strip(), m["name"])
                    e = res[svc]["metrics"].setdefault(key, {"unit": m.get("unit", ""), "type": typ, "temp": set(),
                                                            "bounds": set(), "scales": set(), "keys": set(),
                                                            "routes": set(), "series": {}, "pii": {}})
                    body = m[typ]
                    e["temp"].add(TEMP.get(body.get("aggregationTemporality"), "n/a"))
                    for dp in body.get("dataPoints", []):
                        a = attrs(dp.get("attributes"))
                        e["keys"].update(a)
                        if "http.route" in a:
                            e["routes"].add(a["http.route"])
                        for k, v in a.items():
                            if PII_KEYS.match(k) or CANARY.search(str(v)):
                                e["pii"].setdefault(k, show(v))
                        if "explicitBounds" in dp:
                            e["bounds"].add(tuple(dp["explicitBounds"]))
                        if typ == "exponentialHistogram":
                            e["scales"].add(dp.get("scale"))
                        sk = tuple(sorted((k, str(v)) for k, v in a.items()))
                        cnt = int(dp.get("count", 0)) if "count" in dp else None
                        if cnt is not None:
                            if "cumulative" in e["temp"]:
                                e["series"][sk] = max(e["series"].get(sk, 0), cnt)
                            else:
                                e["series"][sk] = e["series"].get(sk, 0) + cnt
    return res


def spans(dest):
    res = collections.defaultdict(lambda: {"resource": {}, "kinds": collections.Counter(), "server_keys": set(),
                                           "routes": collections.Counter(), "names": collections.Counter(),
                                           "pii": {}, "status": collections.Counter()})
    for doc in lines(f"{dest}-traces.jsonl"):
        for rs in doc.get("resourceSpans", []):
            ra = attrs(rs.get("resource", {}).get("attributes"))
            svc = ra.get("service.name", "?")
            r = res[svc]
            r["resource"].update(ra)
            for ss in rs.get("scopeSpans", []):
                scope = ss.get("scope", {}).get("name", "")
                for sp in ss.get("spans", []):
                    kind = KIND.get(sp.get("kind", 0), sp.get("kind"))
                    r["kinds"][(scope, kind)] += 1
                    if kind != "SERVER":
                        continue
                    a = attrs(sp.get("attributes"))
                    r["server_keys"].update(a)
                    r["routes"][a.get("http.route", "(absent)")] += 1
                    r["names"][sp.get("name")] += 1
                    r["status"][(a.get("http.response.status_code"), sp.get("status", {}).get("code", 0))] += 1
                    for k, v in a.items():
                        if PII_KEYS.match(k) or CANARY.search(str(v)):
                            r["pii"].setdefault(k, show(v))
    return res


def logs(dest):
    c = collections.Counter()
    for doc in lines(f"{dest}-logs.jsonl"):
        for rl in doc.get("resourceLogs", []):
            svc = attrs(rl.get("resource", {}).get("attributes")).get("service.name", "?")
            c[svc] += sum(len(sl.get("logRecords", [])) for sl in rl.get("scopeLogs", []))
    return c


def main():
    out = ["# S-06b raw evidence report (generated by tools/analyze.py)", ""]
    M = {d: metrics(d) for d in ("apm", "scf")}
    S = {d: spans(d) for d in ("apm", "scf")}
    L = {d: logs(d) for d in ("apm",)}
    ran = {p.stem for p in OUT.glob("s06b-*.log")}  # one log per scenario written by run.sh
    services = sorted(set(M["apm"]) | set(M["scf"]) | set(S["apm"]) | set(S["scf"]) | ran)
    for svc in services:
        out += [f"## service.name = `{svc}`", ""]
        for d in ("scf", "apm"):
            m, s = M[d].get(svc), S[d].get(svc)
            nlogs = L.get(d, {}).get(svc, 0)
            sig = [x for x, ok in (("metrics", m), ("spans", s), ("logs", nlogs)) if ok]
            out.append(f"### {d.upper()}: signals = {', '.join(sig) or 'NOTHING'}")
            if not (m or s):
                out.append("")
                continue
            ra = (m or s)["resource"]
            out.append("- resource keys: " + ", ".join(f"`{k}`" for k in sorted(ra)))
            out.append("- telemetry.sdk: " + " ".join(str(ra.get(k, "")) for k in
                                                     ("telemetry.sdk.language", "telemetry.sdk.name", "telemetry.sdk.version", "telemetry.distro.name", "telemetry.distro.version")).strip())
            pii_res = sorted(k for k in ra if PII_KEYS.match(k))
            if pii_res:
                out.append("- resource keys on the drop list: " + ", ".join(f"`{k}`" for k in pii_res))
            if m:
                out.append("- metrics:")
                for (scope, name), e in sorted(m["metrics"].items()):
                    line = f"  - `{name}` [{e['unit']}] {e['type']} {'/'.join(sorted(e['temp']))} scope=`{scope}`"
                    if e["bounds"]:
                        line += " bounds=" + " | ".join(str(list(b)) for b in sorted(e["bounds"]))
                    if e["scales"]:
                        line += f" scales={sorted(e['scales'])}"
                    out.append(line)
                    if name in ("http.server.request.duration", "http.server.duration"):
                        out.append("    - point attrs: " + ", ".join(f"`{k}`" for k in sorted(e["keys"])))
                        out.append("    - http.route values: " + (", ".join(f"`{r}`" for r in sorted(e["routes"])) or "(none)"))
                        tot = sum(e["series"].values())
                        noroute = sum(v for k, v in e["series"].items() if "http.route" not in dict(k))
                        out.append(f"    - requests counted: {tot} (sent {SENT}); without http.route: {noroute}")
                        for sk, v in sorted(e["series"].items(), key=lambda x: str(x[0])):
                            dk = dict(sk)
                            out.append(f"      - route={dk.get('http.route', '(absent)')} method={dk.get('http.request.method', dk.get('http.method'))} "
                                       f"status={dk.get('http.response.status_code', dk.get('http.status_code'))} error.type={dk.get('error.type', '-')} count={v}")
                    if e["pii"]:
                        out.append("    - drop-list/canary attrs: " + ", ".join(f"`{k}`=`{v}`" for k, v in sorted(e["pii"].items())))
            if s:
                out.append("- spans by (scope, kind): " + ", ".join(f"{k[0] or '?'}/{k[1]}={v}" for k, v in sorted(s["kinds"].items())))
                out.append("- SERVER span attr keys: " + ", ".join(f"`{k}`" for k in sorted(s["server_keys"])))
                out.append("- SERVER span http.route: " + ", ".join(f"`{k}`×{v}" for k, v in sorted(s["routes"].items(), key=str)))
                out.append("- SERVER span names: " + ", ".join(f"`{k}`×{v}" for k, v in sorted(s["names"].items(), key=str)))
                out.append("- SERVER (status_code, span status): " + ", ".join(f"{k}×{v}" for k, v in sorted(s["status"].items(), key=str)))
                if s["pii"]:
                    out.append("- SERVER span drop-list/canary attrs: " + ", ".join(f"`{k}`=`{v}`" for k, v in sorted(s["pii"].items())))
            out.append("")
    # proxy header log
    out += ["## Requests seen at the UsageMap endpoint (scf_proxy)", "",
            "| scenario | path | status | Authorization | api-key hdr | User-Agent | Content-Encoding | TLS | n |", "|---|---|---|---|---|---|---|---|---|"]
    c = collections.Counter()
    for r in lines("scf-proxy.jsonl"):
        if r["scenario"] == "unset":
            continue
        c[(r["scenario"], r["path"], r["status"], r["authorization"], r["api_key_header_present"], r["user_agent"], r["content_encoding"], r.get("tls", False))] += 1
    for k, v in sorted(c.items(), key=lambda x: (x[0][0], x[0][1], str(x[0][2]))):
        out.append("| " + " | ".join(str(x) for x in k) + f" | {v} |")
    print("\n".join(out))


if __name__ == "__main__":
    main()
