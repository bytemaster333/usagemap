// SPDX-License-Identifier: Apache-2.0
// The public list of a project's signed snapshots (wire-formats §i.3.3, C-136, C-137) and a snapshot's place in it
// (§i.3.2 `series`): the list must run 1, 2, 3, … without a gap and each `previous_sha256` must equal the `sha256` of
// the entry before it; a v2 snapshot's own `series` must match its list entry. A deleted or withheld snapshot shows as
// a gap or a broken hash link — that is what makes cherry-picking visible to every reader.

import { canonicalize } from "./jcs.ts";
import { sha256, toHex } from "./seal.ts";

export interface ListEntry {
  snapshot_id: string;
  seq: number;
  previous_sha256: string | null;
  sha256: string;
  status: "valid" | "revoked";
}

export type SeriesProblem =
  | { kind: "not_sorted"; at: number }
  | { kind: "gap"; after: number; next: number }
  | { kind: "does_not_start_at_1"; first: number }
  | { kind: "broken_link"; seq: number }
  | { kind: "first_has_previous"; seq: number };

/** Every problem of the list, in order; empty when the list is gap-free and correctly linked. */
export function checkSeries(entries: readonly ListEntry[]): SeriesProblem[] {
  const problems: SeriesProblem[] = [];
  const first = entries[0];
  if (!first) return problems;
  if (first.seq !== 1) problems.push({ kind: "does_not_start_at_1", first: first.seq });
  if (first.seq === 1 && first.previous_sha256 !== null)
    problems.push({ kind: "first_has_previous", seq: 1 });
  for (let i = 1; i < entries.length; i++) {
    const a = entries[i - 1] as ListEntry;
    const b = entries[i] as ListEntry;
    if (b.seq <= a.seq) {
      problems.push({ kind: "not_sorted", at: b.seq });
      continue;
    }
    if (b.seq !== a.seq + 1) problems.push({ kind: "gap", after: a.seq, next: b.seq });
    else if (b.previous_sha256 !== a.sha256) problems.push({ kind: "broken_link", seq: b.seq });
  }
  return problems;
}

export function describeSeriesProblem(p: SeriesProblem): string {
  switch (p.kind) {
    case "gap":
      return p.next - p.after === 2
        ? `Snapshot ${p.after + 1} is missing from the list.`
        : `Snapshots ${p.after + 1}–${p.next - 1} are missing from the list.`;
    case "broken_link":
      return `Snapshot ${p.seq} does not point at the hash of snapshot ${p.seq - 1}.`;
    case "does_not_start_at_1":
      return `The list starts at snapshot ${p.first}, not 1.`;
    case "first_has_previous":
      return "Snapshot 1 names a predecessor.";
    case "not_sorted":
      return `The list is not in series order at snapshot ${p.at}.`;
  }
}

/** hex SHA-256 of the RFC 8785 form of a snapshot document — the `sha256` of its list entry. */
export async function snapshotSha256(snapshot: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalize(snapshot));
  const buf = new Uint8Array(new ArrayBuffer(bytes.length));
  buf.set(bytes);
  return toHex(await sha256(buf));
}

export type PlacementCheck =
  | { kind: "listed"; entry: ListEntry; hashOk: boolean; seqOk: boolean; previousOk: boolean }
  | { kind: "not_listed" };

/** Where a snapshot (hash `sha`, own `series`) sits in the public list, and whether that agrees with the document. */
export function placeInSeries(
  entries: readonly ListEntry[],
  snapshotId: string,
  sha: string,
  series: { seq: number; previous_sha256: string | null } | null,
): PlacementCheck {
  const entry = entries.find((e) => e.snapshot_id === snapshotId);
  if (!entry) return { kind: "not_listed" };
  return {
    kind: "listed",
    entry,
    hashOk: entry.sha256 === sha,
    seqOk: series === null || series.seq === entry.seq,
    previousOk: series === null || series.previous_sha256 === entry.previous_sha256,
  };
}
