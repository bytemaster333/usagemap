"""Render S-12 results.json as a Markdown table (rates in %)."""
import json
import sys

d = json.load(open(sys.argv[1]))
pct = lambda a, b: f"{100 * a / b:.2f}%" if b else "n/a"
print(f"routed IPv4 ranges {d['routed_v4_ranges']}, IPv6 ranges {d['routed_v6_ranges']}, seed {d['seed']}\n")
print("| sample | db | unknown (full) | unknown (truncated) | country changed by truncation (any) | changed, both known | known→unknown |")
print("|---|---|---|---|---|---|---|")
for r in d["results"]:
    for db, s in r["per_db"].items():
        n = r["n"]
        print(f"| {r['sample']} (n={n}) | {db} | {pct(s['unknown_full'], n)} | {pct(s['unknown_trunc'], n)} | "
              f"{pct(s['changed_any'], n)} | {pct(s['changed_both_known'], n)} | {pct(s['full_known_trunc_unknown'], n)} |")
print("\n| sample | DB-IP vs user-country disagree, full (both known) | truncated (both known) | full (any, incl. unknown) | truncated (any) |")
print("|---|---|---|---|---|")
for r in d["results"]:
    c, n = r["dbip_vs_usercountry"], r["n"]
    print(f"| {r['sample']} | {pct(c['disagree_full_both_known'], c['both_known_full'])} | "
          f"{pct(c['disagree_trunc_both_known'], c['both_known_trunc'])} | {pct(c['disagree_full_any'], n)} | {pct(c['disagree_trunc_any'], n)} |")
print("\nTop DB-IP country changes caused by truncation (full->truncated: count):")
for r in d["results"]:
    print(f"- {r['sample']}: " + ", ".join(f"{k}: {v}" for k, v in sorted(r["top_changes_dbip"].items(), key=lambda x: -x[1])))
