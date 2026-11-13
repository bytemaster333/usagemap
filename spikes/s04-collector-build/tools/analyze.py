"""Read sink JSONL capture files and print what the S-04 README quotes.

  analyze.py dump    FILE...            one line per request + body excerpt
  analyze.py spans   FILE               spans captured straight from the SDK (flags)
  analyze.py routes  PREFIX FILE...     per-prefix delivery count, duplicates, hash identity
  analyze.py sinks   FILE...            delivered /dur/ points per (prefix, sink)
  analyze.py batches PREFIX FILE        request-by-request route composition
"""
import collections
import json
import sys


def recs(files):
    for f in files:
        try:
            with open(f) as fh:
                for line in fh:
                    yield json.loads(line)
        except FileNotFoundError:
            pass


def hist_points(r):
    for rm in r.get("body", {}).get("resourceMetrics", []):
        for sm in rm["scopeMetrics"]:
            for m in sm["metrics"]:
                for dp in (m.get("histogram") or {}).get("dataPoints", []):
                    attrs = {a["key"]: a["value"] for a in dp.get("attributes", [])}
                    yield attrs.get("http.route", {}).get("stringValue", "")


def dump(files):
    for r in recs(files):
        hdr = {k: v for k, v in r["headers"].items() if k.lower().startswith("x-scf") or k in ("Content-Encoding", "Content-Type")}
        print(f'#{r["seq"]} {r["sink"]} {r["path"]} status={r["status"]} points={r.get("data_points")} spans={r.get("spans")} sha256={r["sha256_decompressed"][:16]} headers={hdr}')
        print("   ", json.dumps(r.get("body"))[:1800])


def spans(files):
    for r in recs(files):
        if r["path"] != "/v1/traces":
            continue
        for rs in r["body"]["resourceSpans"]:
            sn = [a["value"]["stringValue"] for a in rs["resource"]["attributes"] if a["key"] == "service.name"]
            for ss in rs["scopeSpans"]:
                for s in ss["spans"]:
                    f = s.get("flags", 0)
                    print(f'  {sn[0]:14} {s["name"]:22} kind={s.get("kind")} parent={s.get("parentSpanId", "") or "-":16} flags={f:#06x} tracestate={s.get("traceState", "") or "-"}')


def routes(prefix, files):
    delivered = collections.Counter()
    hashes = collections.defaultdict(set)
    n = 0
    for r in recs(files):
        mine = [rt for rt in hist_points(r) if rt.startswith(f"/dur/{prefix}/")]
        if not mine:
            continue
        n += 1
        for rt in mine:
            hashes[rt].add(r["sha256_decompressed"])
            if r["status"] == 200:
                delivered[rt] += 1
    dups = sorted(k for k, v in delivered.items() if v > 1)
    print(f"  prefix={prefix}: requests_seen={n} distinct_points_delivered={len(delivered)} "
          f"duplicate_deliveries={sum(v - 1 for v in delivered.values())} "
          f"points_seen_in_more_than_one_distinct_body={sum(1 for v in hashes.values() if len(v) > 1)}")
    if dups:
        print(f"  duplicated: {dups[:8]}{' …' if len(dups) > 8 else ''}")


def sinks(files):
    c = collections.Counter()
    for r in recs(files):
        if r["status"] != 200:
            continue
        for rt in hist_points(r):
            if rt.startswith("/dur/"):
                c[(rt.split("/")[2], r["sink"])] += 1
    for (p, s), v in sorted(c.items()):
        print(f"  prefix={p} sink={s} points={v}")


def batches(prefix, files):
    for r in recs(files):
        ids = sorted(int(rt.split("/")[-1]) for rt in hist_points(r) if rt.startswith(f"/dur/{prefix}/"))
        if ids:
            print(f'  #{r["seq"]} status={r["status"]} sha256={r["sha256_decompressed"][:12]} points={len(ids)} routes={ids}')


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    {"dump": lambda: dump(args), "spans": lambda: spans(args), "routes": lambda: routes(args[0], args[1:]),
     "sinks": lambda: sinks(args), "batches": lambda: batches(args[0], args[1:])}[cmd]()
