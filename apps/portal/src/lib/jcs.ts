// SPDX-License-Identifier: Apache-2.0
// RFC 8785 JSON Canonicalization Scheme (JCS) for the browser-side check of signed traction snapshots (C-47,
// wire-formats §i.3): object members sorted by their UTF-16 code units, no whitespace, numbers and strings serialised
// exactly as ECMAScript's JSON.stringify does (which RFC 8785 adopts). Only JSON values are accepted.

export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JCS: numbers must be finite");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Default sort compares UTF-16 code units, which is what RFC 8785 §3.2.3 prescribes.
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
  }
  throw new TypeError(`JCS: ${typeof value} is not a JSON value`);
}
