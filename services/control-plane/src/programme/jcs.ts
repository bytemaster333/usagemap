// SPDX-License-Identifier: Apache-2.0
// RFC 8785 JSON Canonicalization Scheme (JCS) for the signed traction snapshot (wire-formats §i.3): object members
// sorted by the UTF-16 code units of their names, no whitespace, strings escaped as ECMAScript JSON.stringify does
// (which is what RFC 8785 §3.2.2.2 prescribes), numbers in the ECMAScript Number-to-String form (§3.2.2.3).

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("JCS: non-finite number");
      // ECMAScript serialisation; -0 becomes 0 (RFC 8785 §3.2.2.3).
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>).filter(
        ([, v]) => v !== undefined,
      );
      // Default sort compares UTF-16 code units, exactly as RFC 8785 §3.2.3 requires.
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
    }
    default:
      throw new Error(`JCS: unsupported value of type ${typeof value}`);
  }
}
