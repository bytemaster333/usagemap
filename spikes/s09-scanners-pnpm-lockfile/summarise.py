"""Summarise S-09 scanner outputs: did each scanner find the canaries in each fixture?"""
import json
import pathlib
import sys

out = pathlib.Path(sys.argv[1])
CANARIES = {
    "lodash@4.17.20": {"GHSA-35jh-r3h4-6jhm", "CVE-2021-23337"},
    "minimist@1.2.5 (dev)": {"GHSA-xvch-5gv4-984h", "CVE-2021-44906"},
}
SCANNERS = ["osv", "trivy", "trivy-nodev", "grype", "pnpm-audit"]


def ids(scanner, data):
    """Return (set of advisory ids with package name, number of findings)."""
    found = set()
    if scanner == "osv":
        for r in data.get("results", []):
            for p in r.get("packages", []):
                name = p["package"]["name"]
                for v in p.get("vulnerabilities", []):
                    found |= {(name, i) for i in [v["id"], *v.get("aliases", [])]}
    elif scanner.startswith("trivy"):
        for r in data.get("Results", []) or []:
            for v in r.get("Vulnerabilities", []) or []:
                found |= {(v["PkgName"], v["VulnerabilityID"])}
    elif scanner == "grype":
        for m in data.get("matches", []):
            name = m["artifact"]["name"]
            found.add((name, m["vulnerability"]["id"]))
            found |= {(name, r["id"]) for r in m.get("relatedVulnerabilities", [])}
    elif scanner == "pnpm-audit":
        for a in (data.get("advisories") or {}).values():
            name = a.get("module_name")
            found.add((name, a.get("github_advisory_id", "")))
            found |= {(name, c) for c in a.get("cves", [])}
    return found


rows = []
for fx in sorted(p for p in out.iterdir() if p.is_dir()):
    for sc in SCANNERS:
        f = fx / f"{sc}.json"
        try:
            text = f.read_text()
            err = None
            if text and not text.lstrip().startswith("{"):
                err = "stdout has non-JSON preamble: " + repr(text.splitlines()[0][:40])
                text = text[text.index("{"):] if "{" in text else ""
            data = json.loads(text or "{}")
        except (OSError, json.JSONDecodeError) as e:
            data, err = {}, f"unparseable ({type(e).__name__})"
        found = ids(sc, data)
        hits = []
        for canary, cids in CANARIES.items():
            pkg = canary.split("@")[0]
            hits.append("yes" if any(n == pkg and i in cids for n, i in found) else "**no**")
        pkgs_with_findings = len({n for n, _ in found})
        if sc == "osv" and (fx / "osv-inventory.txt").exists():
            err = (err or "") + (fx / "osv-inventory.txt").read_text().strip()
        rows.append((fx.name, sc, *hits, pkgs_with_findings, err or ""))

print("| fixture | scanner | lodash 4.17.20 | minimist 1.2.5 (dev) | vulnerable pkgs reported | note |")
print("|---|---|---|---|---|---|")
for r in rows:
    print("| " + " | ".join(str(x) for x in r) + " |")
