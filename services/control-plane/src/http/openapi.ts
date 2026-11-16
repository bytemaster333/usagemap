// SPDX-License-Identifier: Apache-2.0
// The OpenAPI document is the source of truth for routing, authorisation metadata and request validation. Response
// validation (used by the tests) is built from the same document.

import { controlPlaneOpenApi, type OpenApiDocument } from "@usagemap/api-types";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { FieldError } from "./problem.ts";

// ajv-formats is CommonJS; under ESM its default export is the plugin function.
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

const DOC_ID = "https://scf.invalid/control-plane.openapi.json";
export const METHODS = ["get", "put", "post", "delete", "patch"] as const;
export type Method = (typeof METHODS)[number];

export type RequiredRole =
  | "public"
  | "authenticated"
  | "tenant:viewer"
  | "tenant:member"
  | "tenant:admin"
  | "tenant:owner"
  | "operator"
  | "operator_admin"
  | "share_key"
  | "footprint_key"
  | "edge_node"
  | `operator_key:${string}`;

export interface OperationSpec {
  operationId: string;
  method: Method;
  path: string;
  /** Fastify route path (`{x}` → `:x`). */
  routePath: string;
  roles: RequiredRole[];
  audited: boolean;
  auditActions: string[];
  stepUp: boolean;
  recentAuth: boolean;
  tenantScoped: boolean;
  internal: boolean;
  csrf: boolean;
  pathParams: string[];
  /** Query parameters that are arrays in form style without explode (`a=x,y`): split on commas before validation. */
  csvQuery: string[];
  validateParams: ValidateFunction | undefined;
  validateQuery: ValidateFunction | undefined;
  validateBody: ValidateFunction | undefined;
  bodyRequired: boolean;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Rewrites document-relative `$ref`s so inline schemas resolve against the registered document. */
function absolutise(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(absolutise);
  if (!isObj(schema)) return schema;
  const out: Obj = {};
  for (const [k, v] of Object.entries(schema)) {
    out[k] =
      k === "$ref" && typeof v === "string" && v.startsWith("#/") ? `${DOC_ID}${v}` : absolutise(v);
  }
  return out;
}

function resolveRef(doc: OpenApiDocument, v: unknown): Obj {
  if (isObj(v) && typeof v.$ref === "string") {
    const parts = v.$ref.replace(/^#\//, "").split("/");
    let cur: unknown = doc;
    for (const p of parts) cur = isObj(cur) ? cur[p] : undefined;
    if (!isObj(cur)) throw new Error(`unresolved ${v.$ref}`);
    return cur;
  }
  if (!isObj(v)) throw new Error("expected an object");
  return v;
}

function newAjv(coerce: boolean, doc: OpenApiDocument): Ajv2020 {
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    coerceTypes: coerce ? "array" : false,
    useDefaults: coerce,
    validateFormats: true,
  });
  addFormats(ajv);
  ajv.addSchema({ ...doc, $id: DOC_ID } as Obj);
  return ajv;
}

export function toFieldErrors(
  errors: ErrorObject[] | null | undefined,
  prefix: string,
): FieldError[] {
  return (errors ?? []).slice(0, 20).map((e) => {
    const extra =
      e.keyword === "required" && isObj(e.params) && typeof e.params.missingProperty === "string"
        ? `/${e.params.missingProperty}`
        : e.keyword === "additionalProperties" &&
            isObj(e.params) &&
            typeof e.params.additionalProperty === "string"
          ? `/${e.params.additionalProperty}`
          : "";
    return { pointer: `${prefix}${e.instancePath}${extra}`, detail: e.message ?? e.keyword };
  });
}

export class OpenApi {
  readonly doc: OpenApiDocument;
  readonly operations: OperationSpec[];
  readonly #byId = new Map<string, OperationSpec>();
  readonly #responseAjv: Ajv2020;
  readonly #responseValidators = new Map<string, ValidateFunction | null>();

  constructor(doc: OpenApiDocument = controlPlaneOpenApi()) {
    this.doc = doc;
    const reqAjv = newAjv(true, doc);
    const bodyAjv = newAjv(false, doc);
    this.#responseAjv = bodyAjv;
    this.operations = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      const shared = Array.isArray(item.parameters) ? item.parameters : [];
      for (const method of METHODS) {
        const op = item[method];
        if (!isObj(op) || typeof op.operationId !== "string") continue;
        const params = [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])].map(
          (p) => resolveRef(doc, p),
        );
        const group = (where: string) => {
          const ps = params.filter((p) => p.in === where);
          if (ps.length === 0) return undefined;
          const schema = {
            type: "object",
            properties: Object.fromEntries(
              ps.map((p) => [String(p.name), absolutise(p.schema ?? {})]),
            ),
            required: ps.filter((p) => p.required === true).map((p) => String(p.name)),
          };
          return reqAjv.compile(schema);
        };
        let validateBody: ValidateFunction | undefined;
        let bodyRequired = false;
        if (isObj(op.requestBody)) {
          const rb = resolveRef(doc, op.requestBody);
          bodyRequired = rb.required === true;
          const content = isObj(rb.content) ? rb.content : {};
          const json = content["application/json"];
          if (isObj(json) && json.schema !== undefined)
            validateBody = bodyAjv.compile(absolutise(json.schema) as Obj);
        }
        const security = Array.isArray(op.security) ? (op.security as Obj[]) : [];
        const roles = (
          Array.isArray(op["x-required-role"]) ? op["x-required-role"] : []
        ) as RequiredRole[];
        if (roles.length === 0) throw new Error(`${op.operationId} lacks x-required-role`);
        const actions = op["x-audit-action"];
        const spec: OperationSpec = {
          operationId: op.operationId,
          method,
          path,
          routePath: path.replace(/\{([^}]+)\}/g, ":$1"),
          roles,
          audited: op["x-audited"] === true,
          auditActions: Array.isArray(actions)
            ? (actions as string[])
            : typeof actions === "string"
              ? [actions]
              : [],
          stepUp: op["x-requires-step-up"] === true,
          recentAuth: op["x-requires-recent-auth"] === true,
          tenantScoped: op["x-tenant-scoped"] === true,
          internal: op["x-internal"] === true,
          csrf: security.some((s) => isObj(s) && "csrfHeader" in s),
          pathParams: params.filter((p) => p.in === "path").map((p) => String(p.name)),
          csvQuery: params
            .filter(
              (p) =>
                p.in === "query" &&
                p.explode === false &&
                isObj(p.schema) &&
                p.schema.type === "array",
            )
            .map((p) => String(p.name)),
          validateParams: group("path"),
          validateQuery: group("query"),
          validateBody,
          bodyRequired,
        };
        this.operations.push(spec);
        this.#byId.set(spec.operationId, spec);
      }
    }
  }

  get(operationId: string): OperationSpec {
    const op = this.#byId.get(operationId);
    if (!op) throw new Error(`unknown operation ${operationId}`);
    return op;
  }

  /**
   * Validates a response against the document (tests). Returns a list of problems; empty = valid. A status that the
   * operation does not document is itself a problem.
   */
  validateResponse(
    operationId: string,
    status: number,
    contentType: string | undefined,
    body: unknown,
  ): string[] {
    const op = this.get(operationId);
    const item = this.doc.paths[op.path] as Obj;
    const responses = (item[op.method] as Obj).responses as Obj;
    const declared = responses[String(status)] ?? responses.default;
    if (declared === undefined) return [`${operationId}: status ${status} is not documented`];
    const resp = resolveRef(this.doc, declared);
    const content = isObj(resp.content) ? resp.content : undefined;
    if (!content) {
      return body === undefined || body === "" || body === null
        ? []
        : [`${operationId} ${status}: unexpected body`];
    }
    const type = (contentType ?? "").split(";")[0]?.trim() ?? "";
    const media = content[type];
    if (!isObj(media))
      return [`${operationId} ${status}: content type ${type || "(none)"} not documented`];
    const key = `${operationId} ${status} ${type}`;
    let v = this.#responseValidators.get(key);
    if (v === undefined) {
      v =
        media.schema === undefined
          ? null
          : this.#responseAjv.compile(absolutise(media.schema) as Obj);
      this.#responseValidators.set(key, v);
    }
    if (v === null) return [];
    if (v(body)) return [];
    return toFieldErrors(v.errors, "").map((e) => `${key}: ${e.pointer} ${e.detail}`);
  }
}
