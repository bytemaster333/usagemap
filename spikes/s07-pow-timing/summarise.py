"""Render S-07 result files as Markdown tables (median / p90 / p95 in ms)."""
import json
import pathlib
import sys

d = pathlib.Path(sys.argv[1])
size = json.loads((d / "size.json").read_text())
print("## Solver size (esbuild 0.28.2, es2017)\n")
print("| unit | raw B | gzip -9 B | brotli 11 B |\n|---|---|---|---|")
for k in ("solver_worker_body", "solver_plus_loader"):
    s = size[k]
    print(f"| {k} | {s['raw']} | {s['gzip9']} | {s['brotli11']} |")

files = sorted(d.glob("devtools-*.json")) + sorted(d.glob("quota*-chromium.json")) + sorted(d.glob("quota*-webkit.json"))
for f in files:
    r = json.loads(f.read_text())
    label = f.stem
    print(f"\n## {label} — {r['browser']} {r['version']}, n={r['n_per_cell']} per cell\n")
    print("controls (fixed work; shows whether the emulation reaches each thread):\n")
    print("| rate | JS loop main ms | JS loop worker ms | 1024 PBKDF2 attempts × 512 in worker ms |\n|---|---|---|---|")
    for c in r["controls"]:
        print(f"| {c['rate']} | {c['js_loop_main_ms']} | {c['js_loop_worker_ms']} | {c['pbkdf2_512x1024_worker_ms']} |")
    print("\n| rate | mode | cost | max | P | expected iter | median | p90 | p95 | max |\n|---|---|---|---|---|---|---|---|---|---|")
    for x in r["runs"]:
        print(f"| {x['rate']} | {x['mode']} | {x['cost']} | {x['max']} | {x['P']} | {x['expected_iterations']} | "
              f"{x['median_ms']} | {x['p90_ms']} | {x['p95_ms']} | {x['max_ms']} |")
