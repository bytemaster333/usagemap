// SPDX-License-Identifier: Apache-2.0
// Validates mock responses and fixtures against the control-plane OpenAPI document, so the browser tests can only
// pass on data the real API is allowed to send.

import { controlPlaneOpenApi, type OpenApiDocument } from "@usagemap/api-types";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

const DOC_ID = "https://scf.invalid/control-plane.json";

let ajv: Ajv2020 | undefined;
let doc: OpenApiDocument | undefined;
const cache = new Map<string, ValidateFunction>();

function escapePointer(seg: string): string {
  return seg.replace(/~/g, "~0").replace(/\//g, "~1");
}

function init(): { ajv: Ajv2020; doc: OpenApiDocument } {
  if (!ajv || !doc) {
    doc = controlPlaneOpenApi();
    ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
    addFormats(ajv);
    ajv.addSchema({ ...doc, $id: DOC_ID });
  }
  return { ajv, doc };
}

/** Finds the operation by id; returns its path template and method. */
export function findOperation(operationId: string): { path: string; method: string } {
  const { doc } = init();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if ((op as { operationId?: string }).operationId === operationId) return { path, method };
    }
  }
  throw new Error(`unknown operation ${operationId}`);
}

/** Validator for the JSON body of `operationId` answering `status`; null when that answer has no JSON body. */
export function responseValidator(
  operationId: string,
  status: number,
  opts: { undeclaredAsProblem?: boolean } = {},
): ValidateFunction | null {
  const key = `${operationId}:${status}:${opts.undeclaredAsProblem === true}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { ajv, doc } = init();
  const { path, method } = findOperation(operationId);
  const op = (doc.paths[path] as Record<string, { responses: Record<string, unknown> }>)[method];
  if (!op) throw new Error(`no ${method} ${path}`);
  let res = op.responses[String(status)] as Record<string, unknown> | undefined;
  if (!res) {
    if (!opts.undeclaredAsProblem)
      throw new Error(`${operationId} does not declare status ${status}`);
    const v = ajv.compile({ $ref: `${DOC_ID}#/components/schemas/Problem` });
    cache.set(key, v);
    return v;
  }
  let pointer = `#/paths/${escapePointer(path)}/${method}/responses/${status}`;
  const ref = res.$ref;
  if (typeof ref === "string") {
    pointer = ref;
    const name = ref.split("/").pop() as string;
    res = (doc.components.responses as Record<string, Record<string, unknown>>)[name];
  }
  const content = res?.content as Record<string, { schema?: unknown }> | undefined;
  if (!content) return null;
  const type = Object.keys(content).find((t) => t.includes("json"));
  if (!type || !content[type]?.schema) return null;
  const v = ajv.compile({ $ref: `${DOC_ID}${pointer}/content/${escapePointer(type)}/schema` });
  cache.set(key, v);
  return v;
}

export function assertValidResponse(
  operationId: string,
  status: number,
  body: unknown,
  opts: { undeclaredAsProblem?: boolean } = {},
): void {
  const v = responseValidator(operationId, status, opts);
  if (!v) return;
  if (!v(body)) {
    throw new Error(
      `${operationId} ${status}: response does not match the OpenAPI schema: ${JSON.stringify(v.errors?.slice(0, 5))}`,
    );
  }
}
