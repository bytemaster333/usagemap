// SPDX-License-Identifier: Apache-2.0
// What the coverage report runs (test.automated-suite). `unit` mode runs everything that needs no Docker; `all` mode also runs the
// integration/contract projects (real PostgreSQL / Umami / the Compose stack must be reachable as each suite's own
// harness expects). A workspace package without a target here fails `lib.test.ts`.

export interface TsTarget {
  dir: string;
  /** vitest arguments in unit mode (e.g. one project); `all` mode runs vitest without them. */
  unitArgs: string[];
  /** Source globs measured (relative to `dir`): files no test loads count as 0 %, not as absent. */
  include: string[];
  /** What unit mode leaves out, and why. */
  excludedInUnit: string[];
  /** What neither mode runs (browser suites, …). */
  neverRun: string[];
}

export const TS_TARGETS: TsTarget[] = [
  {
    dir: "apps/portal",
    unitArgs: [],
    include: ["src/**/*.{ts,tsx}", "server/**/*.ts"],
    excludedInUnit: [],
    neverRun: [
      "Playwright e2e (`test:e2e`, `test:e2e:real`): a browser against the built portal, not instrumented by v8 in-process",
    ],
  },
  {
    dir: "packages/umami-adapter",
    unitArgs: ["--project", "unit"],
    include: ["src/**/*.ts"],
    excludedInUnit: ["vitest project `contract`: needs a real Umami + PostgreSQL in Docker"],
    neverRun: [],
  },
  {
    dir: "packages/api-types",
    unitArgs: [],
    include: ["src/**/*.ts"],
    excludedInUnit: [],
    neverRun: [],
  },
  {
    dir: "packages/stellar-otel",
    unitArgs: [],
    include: ["src/**/*.ts"],
    excludedInUnit: [],
    neverRun: [
      "`test/testnet.smoke.test.ts`: read-only calls to the public testnet, skipped unless STELLAR_OTEL_TESTNET=1",
    ],
  },
  {
    dir: "packages/edge-otel",
    unitArgs: [],
    include: ["src/**/*.ts"],
    excludedInUnit: [],
    neverRun: [],
  },
  // Integration packages (C-169, C-173, C-174, C-176). tools/ap-listener is covered through go.work; the
  // Python package packages/stellar-otel-py (pytest) and packages/mobile-flutter (dart test) are outside this report.
  {
    dir: "packages/payments-otel",
    unitArgs: [],
    include: ["src/**/*.ts"],
    excludedInUnit: [],
    neverRun: [],
  },
  {
    dir: "packages/anchor-otel",
    unitArgs: [],
    include: ["src/**/*.ts"],
    excludedInUnit: [],
    neverRun: [],
  },
  {
    dir: "packages/partner-otel",
    unitArgs: [],
    include: ["src/**/*.ts"],
    excludedInUnit: [],
    neverRun: [],
  },
  {
    dir: "packages/mobile-rn",
    unitArgs: [],
    include: ["src/**/*.ts"],
    excludedInUnit: [],
    neverRun: [],
  },
  {
    dir: "services/control-plane",
    unitArgs: ["--project", "unit"],
    include: ["src/**/*.ts"],
    excludedInUnit: [
      "vitest project `integration`: needs PostgreSQL, PgBouncer and Umami in Docker",
    ],
    neverRun: [],
  },
  {
    dir: "services/jobs",
    unitArgs: ["--project", "unit"],
    include: ["src/**/*.ts"],
    excludedInUnit: [
      "vitest project `integration`: needs PostgreSQL, PgBouncer and Umami in Docker",
    ],
    neverRun: [],
  },
  {
    dir: "tracker",
    unitArgs: [],
    include: ["src/**/*.ts"],
    excludedInUnit: [],
    neverRun: ["Playwright e2e (`test:e2e`): real browsers against the built bundle"],
  },
  {
    dir: "tests",
    unitArgs: ["--project", "unit"],
    include: ["lib/**/*.ts", "load/**/*.ts", "isolation/**/*.ts", "chaos/**/*.ts"],
    excludedInUnit: [
      "vitest project `e2e`: needs the whole Compose stack (`tests/stack/up.sh`)",
      "`privacy-docs/` (own vitest config): needs PostgreSQL in Docker for the schema checks; it tests documents, not code",
    ],
    neverRun: [],
  },
];

/** Go modules whose tests skip or are build-tagged without Docker / external binaries (stated in the report). */
export const GO_EXCLUSIONS: Record<string, { unit: string[]; always: string[] }> = {
  "collector/tests": {
    unit: [
      "pipeline tests skip without a built Collector (`SCF_COLLECTOR_IT=1`, `SCF_OTELCOL_BIN`)",
    ],
    always: [],
  },
  "db/tests": {
    unit: ["every test needs PostgreSQL in Docker (`SCF_SKIP_DOCKER_TESTS=1` set)"],
    always: ["tests SQL, not Go: its Go coverage is harness code"],
  },
  "services/engine-proxy": {
    unit: [],
    always: ["`integration/` (build tag `integration`, needs Umami: `integration/run.sh`)"],
  },
  "services/metrics-writer": {
    unit: [
      "`integration/` runs only where Docker is available (it skips with `SCF_SKIP_DOCKER_TESTS=1` when it is not); its Collector end to end and 10× load are skipped (`SCF_SKIP_COLLECTOR_E2E=1`, `SCF_WSD_LOAD_SECONDS=0`) — job `metrics writer unit and integration` runs both",
    ],
    always: [],
  },
  "services/health-controller": {
    unit: ["`integration/` needs Docker (`SCF_SKIP_DOCKER_TESTS=1` set)"],
    always: [],
  },
  "services/gateway": {
    unit: [],
    always: [
      "`cmd/gateway` OTLP e2e skips without a built Collector (`SCF_COLLECTOR_BIN`); transport real-client cases skip for clients not installed",
    ],
  },
};
