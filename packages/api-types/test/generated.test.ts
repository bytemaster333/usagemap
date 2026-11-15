// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { generate } from "../scripts/generate.ts";
import {
  controlPlaneOpenApi,
  controlPlaneOperationIds,
  operatorMetricsOpenApi,
} from "../src/index.ts";

const repo = join(import.meta.dirname, "..", "..", "..");

describe("generated API types", () => {
  it("lists every operationId of the control-plane document", () => {
    const doc = parse(readFileSync(join(repo, "docs/api/control-plane.openapi.yaml"), "utf8"), {
      uniqueKeys: false,
    }) as { paths: Record<string, Record<string, { operationId?: string }>> };
    const ids = Object.values(doc.paths)
      .flatMap((item) => Object.values(item))
      .map((op) => op.operationId)
      .filter((x): x is string => typeof x === "string")
      .sort();
    expect([...controlPlaneOperationIds]).toEqual(ids);
    expect(ids.length).toBeGreaterThan(100);
  });

  it("embeds both documents as parsed JSON", () => {
    expect(controlPlaneOpenApi().openapi).toBe("3.1.0");
    expect(operatorMetricsOpenApi().openapi).toMatch(/^3\.1\./);
    expect(controlPlaneOpenApi()).not.toBe(controlPlaneOpenApi());
  });

  it("is deterministic", () => {
    const src = readFileSync(join(repo, "docs/api/operator-metrics.openapi.yaml"), "utf8");
    expect(generate(src, "x").types).toBe(generate(src, "x").types);
  });

  it("maps schema keywords to TypeScript", () => {
    const src = `openapi: 3.1.0
info: {title: t, version: "1"}
paths:
  /a/{id}:
    get:
      operationId: getA
      parameters:
      - {name: id, in: path, required: true, schema: {type: string}}
      - {name: q, in: query, schema: {enum: [x, y]}}
      responses:
        "200": {description: ok, content: {application/json: {schema: {$ref: "#/components/schemas/A"}}}}
components:
  schemas:
    A:
      type: object
      additionalProperties: false
      required: [n]
      properties:
        n: {type: [integer, "null"]}
        k: {const: fixed}
        list: {type: array, items: {$ref: "#/components/schemas/B"}}
    B:
      allOf:
      - {type: object, properties: {b: {type: boolean}}}
      - {if: {required: [b]}, then: {required: [b]}}
`;
    const { types } = generate(src, "inline");
    expect(types).toContain(
      'export type A = {\n  n: number | null;\n  k?: "fixed";\n  list?: B[];\n};',
    );
    expect(types).toContain("export type B = ({\n  b?: boolean;\n});");
    expect(types).toContain('q?: "x" | "y";');
    expect(types).toContain('"200": A;');
  });
});
