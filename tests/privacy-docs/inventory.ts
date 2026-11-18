// SPDX-License-Identifier: Apache-2.0
// Parser of docs/privacy/data-inventory.md (privacy.strategy-docs): the legend paragraph, every table row of the numbered sections
// (keyed by section number and the text of its first cell), and the bullets of §8. Claims address a row by section
// and a pattern on the first cell, and read one named column; a row or column that disappears is a failure, never a
// silent pass.

export interface InventoryRow {
  section: number;
  sectionTitle: string;
  /** First cell, markdown stripped of `**` and backticks. */
  field: string;
  cells: Record<string, string>;
}

export interface Inventory {
  legend: string;
  rows: InventoryRow[];
  /** Bullets of "## 8. Fields we explicitly never collect" (continuation lines joined). */
  neverCollected: string[];
  /** Free text of each section (prose under the table included). */
  sectionText: Map<number, string>;
}

export const plain = (s: string): string =>
  s.replace(/\*\*/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim();

const splitRow = (line: string): string[] => {
  // `|` inside backticks does not occur in this document; a literal "\|" is kept as "|".
  const cells = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim());
  return cells;
};

export function parseInventory(md: string): Inventory {
  const lines = md.split("\n");
  const rows: InventoryRow[] = [];
  const neverCollected: string[] = [];
  const sectionText = new Map<number, string>();
  const legend: string[] = [];
  let section = 0;
  let title = "";
  let header: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const h = /^## (\d+)\. (.+)$/.exec(line);
    if (h) {
      section = Number(h[1]);
      title = (h[2] as string).trim();
      header = null;
      sectionText.set(section, "");
      continue;
    }
    if (section === 0) {
      legend.push(line);
      continue;
    }
    sectionText.set(section, `${sectionText.get(section) ?? ""}${line}\n`);
    if (line.startsWith("|")) {
      const cells = splitRow(line);
      if (header === null) {
        header = cells.map(plain);
        continue;
      }
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
      if (cells.length !== header.length) {
        throw new Error(
          `data-inventory §${section} row ${JSON.stringify(cells[0])}: ${cells.length} cells, header has ${header.length}`,
        );
      }
      const rec: Record<string, string> = {};
      header.forEach((name, k) => {
        rec[name] = cells[k] as string;
      });
      rows.push({ section, sectionTitle: title, field: plain(cells[0] as string), cells: rec });
      continue;
    }
    header = null;
    if (section === 8 && line.startsWith("- ")) {
      let item = line.slice(2);
      while (i + 1 < lines.length && /^ {2}\S/.test(lines[i + 1] as string))
        item += ` ${(lines[++i] as string).trim()}`;
      neverCollected.push(plain(item));
    }
  }
  return { legend: plain(legend.join("\n")), rows, neverCollected, sectionText };
}

/** The one row of `section` whose first cell matches `field`; throws when none or several match. */
export function row(inv: Inventory, section: number, field: RegExp): InventoryRow {
  const hits = inv.rows.filter((r) => r.section === section && field.test(r.field));
  if (hits.length !== 1) {
    throw new Error(
      `data-inventory §${section}: ${hits.length} rows match ${field} (expected exactly one)`,
    );
  }
  return hits[0] as InventoryRow;
}

/** A column of a row, plain text; throws when the column is missing. Column names are matched by prefix
 *  ("Where" matches "Where it exists" and "Where"). */
export function cell(r: InventoryRow, column: string): string {
  const key = Object.keys(r.cells).find((k) => k === column || k.startsWith(column));
  if (key === undefined)
    throw new Error(`data-inventory §${r.section} row "${r.field}": no column "${column}"`);
  return plain(r.cells[key] as string);
}

/** Durations as written in the document ("35 days", "25 mo", "1-min 35 d", "72 h", "10 minutes") → a comparable
 *  value; "indefinitely" / "life of the service" → "indefinite". */
export type Duration = { months: number; days: number; minutes: number } | "indefinite";

export function parseDuration(text: string): Duration {
  const t = text.trim().toLowerCase();
  if (/^(indefinitely|indefinite|life of (the )?service)$/.test(t)) return "indefinite";
  const m = /^(\d+)\s*(months?|mo|days?|d|hours?|h|minutes?|min)$/.exec(t);
  if (!m) throw new Error(`not a duration: ${JSON.stringify(text)}`);
  const n = Number(m[1]);
  const unit = m[2] as string;
  if (/^mo/.test(unit)) return { months: n, days: 0, minutes: 0 };
  if (/^d/.test(unit)) return { months: 0, days: n, minutes: 0 };
  if (/^h/.test(unit))
    return n % 24 === 0
      ? { months: 0, days: n / 24, minutes: 0 }
      : { months: 0, days: 0, minutes: n * 60 };
  return { months: 0, days: 0, minutes: n };
}

export const fmtDuration = (d: Duration): string =>
  d === "indefinite"
    ? "indefinite"
    : [
        d.months && `${d.months} months`,
        d.days && `${d.days} days`,
        d.minutes && `${d.minutes} minutes`,
      ]
        .filter(Boolean)
        .join(" ") || "0";

/** Extracts the first capture group of `re` from `text`; throws (claim text changed) when it does not match. */
export function pick(text: string, re: RegExp, what: string): string {
  const m = re.exec(text);
  if (!m || m[1] === undefined)
    throw new Error(
      `data-inventory: ${what} — pattern ${re} not found in: ${JSON.stringify(text.slice(0, 300))}`,
    );
  return m[1];
}
