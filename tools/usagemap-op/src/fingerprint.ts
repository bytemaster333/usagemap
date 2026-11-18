// SPDX-License-Identifier: Apache-2.0
// Diff of two handover data fingerprints (tests/handover/fingerprint.sh: sorted TSV lines `<db> <kind> <name> <value>`,
// counts and hashes only, never row content). Two clusters hold the same data and schema exactly when the outputs are
// equal; this names what differs, grouped by kind, with row-count deltas for tables.

export interface FpLine {
  db: string;
  kind: string;
  name: string;
  value: string;
}

export interface FpChange {
  db: string;
  kind: string;
  name: string;
  a: string | null;
  b: string | null;
  /** tables only: row counts on each side (null when the side lacks the table) */
  rows?: { a: number | null; b: number | null };
}

export interface FpDiff {
  equal: boolean;
  lines: { a: number; b: number };
  /** per kind: lines on side a, and how many are only in a, only in b, changed */
  kinds: Record<string, { a: number; only_a: number; only_b: number; changed: number }>;
  tables: { a: number; b: number; rows_a: number; rows_b: number };
  changes: FpChange[];
  /** databases reported as `missing` by fingerprint.sh on either side */
  missing_databases: { a: string[]; b: string[] };
}

const KINDS = new Set(["table", "sequence", "schema", "database", "role"]);

export function parseFingerprint(text: string, label: string): Map<string, FpLine> {
  const out = new Map<string, FpLine>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    if (l.trim() === "") continue;
    const f = l.split("\t");
    if (f.length < 4 || !KINDS.has(f[1] as string))
      throw new Error(
        `${label} line ${i + 1} is not a fingerprint line (expected <db>\\t<kind>\\t<name>\\t<value>)`,
      );
    const [db, kind, name] = f as [string, string, string];
    const key = `${db}\t${kind}\t${name}`;
    if (out.has(key)) throw new Error(`${label} line ${i + 1} repeats ${db} ${kind} ${name}`);
    out.set(key, { db, kind, name, value: f.slice(3).join("\t") });
  }
  if (out.size === 0) throw new Error(`${label} is empty`);
  return out;
}

function rowsOf(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v.split(" ")[0]);
  return Number.isInteger(n) ? n : null;
}

export function diffFingerprints(a: Map<string, FpLine>, b: Map<string, FpLine>): FpDiff {
  const kinds: FpDiff["kinds"] = {};
  const k = (kind: string) => {
    kinds[kind] ??= { a: 0, only_a: 0, only_b: 0, changed: 0 };
    return kinds[kind];
  };
  const changes: FpChange[] = [];
  const tables = { a: 0, b: 0, rows_a: 0, rows_b: 0 };
  const missing = { a: [] as string[], b: [] as string[] };
  for (const [side, m] of [
    ["a", a],
    ["b", b],
  ] as const) {
    for (const l of m.values()) {
      if (l.kind === "database" && l.name === "missing") missing[side].push(l.db);
      if (l.kind === "table") {
        tables[side]++;
        tables[side === "a" ? "rows_a" : "rows_b"] += rowsOf(l.value) ?? 0;
      }
    }
  }
  for (const [key, la] of a) {
    k(la.kind).a++;
    const lb = b.get(key);
    if (!lb) k(la.kind).only_a++;
    else if (lb.value === la.value) continue;
    else k(la.kind).changed++;
    changes.push(change(la, la.value, lb?.value ?? null));
  }
  for (const [key, lb] of b) {
    if (a.has(key)) continue;
    k(lb.kind).only_b++;
    changes.push(change(lb, null, lb.value));
  }
  changes.sort((x, y) =>
    `${x.db}\t${x.kind}\t${x.name}` < `${y.db}\t${y.kind}\t${y.name}` ? -1 : 1,
  );
  return {
    equal: changes.length === 0,
    lines: { a: a.size, b: b.size },
    kinds,
    tables,
    changes,
    missing_databases: missing,
  };
}

function change(l: FpLine, va: string | null, vb: string | null): FpChange {
  const c: FpChange = { db: l.db, kind: l.kind, name: l.name, a: va, b: vb };
  if (l.kind === "table") c.rows = { a: rowsOf(va), b: rowsOf(vb) };
  return c;
}

export function renderDiff(d: FpDiff, names: { a: string; b: string }, max = 50): string {
  const out: string[] = [];
  out.push(`A: ${names.a} (${d.lines.a} lines, ${d.tables.a} tables, ${d.tables.rows_a} rows)`);
  out.push(`B: ${names.b} (${d.lines.b} lines, ${d.tables.b} tables, ${d.tables.rows_b} rows)`);
  for (const side of ["a", "b"] as const)
    if (d.missing_databases[side].length)
      out.push(
        `${side.toUpperCase()} reports missing databases: ${d.missing_databases[side].join(", ")}`,
      );
  if (d.equal) {
    out.push(
      "IDENTICAL: same data and schema (every table's rows and content hash, sequences, schema, roles).",
    );
    return `${out.join("\n")}\n`;
  }
  out.push(`DIFFERENT: ${d.changes.length} line(s) differ`);
  out.push("kind       lines(A)  only A  only B  changed");
  for (const [kind, s] of Object.entries(d.kinds).sort()) {
    if (!s.only_a && !s.only_b && !s.changed) continue;
    out.push(
      `${kind.padEnd(10)} ${String(s.a).padStart(8)}  ${String(s.only_a).padStart(6)}  ${String(s.only_b).padStart(6)}  ${String(s.changed).padStart(7)}`,
    );
  }
  for (const c of d.changes.slice(0, max)) {
    const what = c.a === null ? "only in B" : c.b === null ? "only in A" : "changed";
    let detail = "";
    if (c.rows && c.a !== null && c.b !== null)
      detail =
        c.rows.a === c.rows.b
          ? ` (${c.rows.a} rows both, content hash differs)`
          : ` (rows ${c.rows.a} → ${c.rows.b})`;
    else if (c.kind !== "table" && c.a !== null && c.b !== null && c.a.length + c.b.length < 120)
      detail = ` (${c.a} → ${c.b})`;
    out.push(`  ${c.db} ${c.kind} ${c.name}: ${what}${detail}`);
  }
  if (d.changes.length > max) out.push(`  … ${d.changes.length - max} more (use --json for all)`);
  if (d.kinds.schema?.changed)
    out.push(
      "Schema parts differ: rerun fingerprint.sh with FP_RAW=1 on both sides and diff the raw files to see the text.",
    );
  return `${out.join("\n")}\n`;
}
