// SPDX-License-Identifier: Apache-2.0
// The overlay applied to (1) a minimal fixture with the UI monorepo's shape,
// always, and (2) a real read-only checkout of stellar-scaffold/ui when
// SCAFFOLD_UI_DIR points to one (git clone https://github.com/stellar-scaffold/ui
// into a scratch directory; nothing from it is executed).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assemble, UPSTREAM } from "../assemble.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const read = (...p) => readFileSync(join(...p), "utf8");
const json = (...p) => JSON.parse(read(...p));

function write(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

/** The shape of stellar-scaffold/ui that assemble relies on, in miniature. */
function fixture() {
  const root = tmp("ui-fixture-");
  write(
    root,
    "package.json",
    `{\n\t"name": "@stellar-scaffold/ui",\n\t"workspaces": ["templates/*", "app-lib", "app-lib/clients/*", "e2e"]\n}\n`,
  );
  write(root, "scaffold.yml", "version: 2\n\nproject:\n  contracts-dir: contracts\n");
  write(
    root,
    "app-lib/package.json",
    `{\n\t"dependencies": { "@creit.tech/stellar-wallets-kit": "^2.5.0" }\n}\n`,
  );
  write(
    root,
    "templates/react/package.json",
    `{\n\t"name": "@stellar-scaffold/ui-react",\n\t"dependencies": { "react": "^19.2.6" }\n}\n`,
  );
  write(
    root,
    "templates/react/src/main.tsx",
    'import { StrictMode } from "react"\ncreateRoot(document.body).render(null)\n',
  );
  write(root, "templates/svelte/package.json", "{}\n");
  write(root, "e2e/tests/visual.spec.ts-snapshots/a.png", "x");
  write(root, "e2e/tests/smoke.spec.ts", "// spec\n");
  write(root, "node_modules/junk/index.js", "");
  write(root, ".git/HEAD", "ref: refs/heads/main\n");
  return root;
}

test("assembles an instantiated React project with the UsageMap overlay", () => {
  const up = fixture();
  const out = join(tmp("tpl-"), "out");
  const rec = assemble({ upstream: up, out });

  assert.ok(!existsSync(join(out, "templates")), "templates/ removed, as init does");
  assert.ok(!existsSync(join(out, "node_modules")) && !existsSync(join(out, ".git")));
  assert.ok(!existsSync(join(out, "e2e/tests/visual.spec.ts-snapshots")), "e2e snapshots pruned");
  assert.ok(existsSync(join(out, "e2e/tests/smoke.spec.ts")));
  assert.deepEqual(json(out, "package.json").workspaces, [
    "app",
    "app-lib",
    "app-lib/clients/*",
    "e2e",
    "tools/stellar-scaffold-usagemap",
  ]);
  assert.match(read(out, "package.json"), /\n\t"workspaces"/, "indentation kept");

  const main = read(out, "app/src/main.tsx").split("\n");
  assert.match(main[0], /^import "\.\/usagemap"/);
  assert.equal(main.slice(1).join("\n"), read(up, "templates/react/src/main.tsx"));

  assert.deepEqual(json(out, "app/package.json").dependencies, {
    "@creit.tech/stellar-wallets-kit": "^2.5.0",
    "@usagemap/tracker": "1.1.0",
    react: "^19.2.6",
  });
  const yml = read(out, "scaffold.yml");
  assert.ok(yml.startsWith(read(up, "scaffold.yml")), "upstream scaffold.yml kept verbatim");
  assert.match(yml, /\nextensions:\n {2}usagemap:\n/);
  assert.match(yml, /\n {4}register: false\n/);

  for (const f of ["app/src/usagemap.ts", "usagemap.env.example", "USAGEMAP.md"]) {
    assert.equal(read(out, f), read(HERE, "..", "overlay", f));
  }
  const bin = join(out, "tools/stellar-scaffold-usagemap/bin/stellar-scaffold-usagemap");
  const m = spawnSync(process.execPath, [bin, "manifest"], { encoding: "utf8" });
  assert.equal(m.status, 0, m.stderr);
  assert.equal(JSON.parse(m.stdout).name, "usagemap");
  assert.equal(
    json(out, "tools/stellar-scaffold-usagemap/package.json").bin["stellar-scaffold-usagemap"],
    "./bin/stellar-scaffold-usagemap",
  );

  assert.deepEqual(json(out, "USAGEMAP_TEMPLATE.json"), rec);
  assert.equal(rec.upstream.commit, UPSTREAM.commit);
  for (const [f, h] of Object.entries(rec.files)) {
    assert.equal(
      createHash("sha256")
        .update(readFileSync(join(out, f)))
        .digest("hex"),
      h,
      f,
    );
  }
  // Upstream checkout left untouched.
  assert.ok(existsSync(join(up, "templates/react/src/main.tsx")));
  assert.ok(!read(up, "templates/react/src/main.tsx").includes("usagemap"));
});

test("a vendored tracker tarball is copied and pinned as file:", () => {
  const up = fixture();
  const tgz = join(tmp("tgz-"), "scf-analytics-tracker-1.1.0.tgz");
  writeFileSync(tgz, "not really a tarball");
  const out = join(tmp("tpl-"), "out");
  const rec = assemble({ upstream: up, out, trackerTarball: tgz });
  assert.equal(rec.tracker, "file:vendor/scf-analytics-tracker-1.1.0.tgz");
  assert.equal(json(out, "app/package.json").dependencies["@usagemap/tracker"], rec.tracker);
  assert.ok(existsSync(join(out, "app/vendor/scf-analytics-tracker-1.1.0.tgz")));
});

test("fails loudly when upstream changes shape", () => {
  const cases = [
    ["scaffold.yml", "version: 2\nextensions:\n  reporter:\n", /already has an extensions: key/],
    ["templates/react/src/main.tsx", "export {}\n", /changed shape/],
    ["app-lib/package.json", "{}\n", /no longer depends on @creit\.tech/],
    ["package.json", '{ "workspaces": ["app"] }\n', /templates\/\*/],
    ["scaffold.yml", "version: 1\n", /not version 2/],
  ];
  for (const [file, text, why] of cases) {
    const up = fixture();
    write(up, file, text);
    assert.throws(() => assemble({ upstream: up, out: join(tmp("tpl-"), "out") }), why, file);
  }
  const up = fixture();
  const out = tmp("nonempty-");
  writeFileSync(join(out, "x"), "");
  assert.throws(() => assemble({ upstream: up, out }), /must be empty/);
  assert.throws(
    () => assemble({ upstream: tmp("empty-"), out: join(tmp("t-"), "o") }),
    /not a checkout/,
  );
  assert.throws(
    () => assemble({ upstream: fixture(), out: join(tmp("t-"), "o"), tracker: "^1.1.0" }),
    /exact version/,
  );
});

const UI = process.env.SCAFFOLD_UI_DIR;
test("applies to the pinned upstream stellar-scaffold/ui (read-only checkout)", {
  skip: UI ? false : "set SCAFFOLD_UI_DIR to a checkout of stellar-scaffold/ui",
}, () => {
  const head = execFileSync("git", ["-C", UI, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(head, UPSTREAM.commit, "checkout is at the commit pinned in UPSTREAM.json");
  const out = join(tmp("tpl-real-"), "out");
  const rec = assemble({ upstream: UI, out, commit: head });
  assert.equal(
    execFileSync("git", ["-C", UI, "status", "--porcelain"], { encoding: "utf8" }),
    "",
    "upstream checkout unchanged",
  );

  // The facts the overlay depends on still hold at this commit.
  const vite = read(out, "app/vite.config.ts");
  assert.match(
    vite,
    /envPrefix: "PUBLIC_"/,
    "Vite exposes PUBLIC_* (usagemap.ts reads PUBLIC_USAGEMAP_SITE)",
  );
  const wallet = read(out, "app-lib/wallet.ts");
  assert.match(wallet, /StellarWalletsKit\.init\(/, "app-lib initialises the kit at module load");
  assert.match(read(out, "app/src/main.tsx"), /^import "\.\/usagemap"[^\n]*\nimport /);
  assert.equal(
    read(out, "app/src/main.tsx").split("\n").slice(1).join("\n"),
    read(UI, "templates/react/src/main.tsx"),
  );

  const root = json(out, "package.json");
  assert.deepEqual(root.workspaces, [
    "app",
    "app-lib",
    "app-lib/clients/*",
    "e2e",
    "tools/stellar-scaffold-usagemap",
  ]);
  assert.equal(root.name, json(UI, "package.json").name);
  const app = json(out, "app/package.json");
  assert.equal(app.dependencies["@usagemap/tracker"], "1.1.0");
  assert.equal(
    app.dependencies["@creit.tech/stellar-wallets-kit"],
    json(UI, "app-lib/package.json").dependencies["@creit.tech/stellar-wallets-kit"],
  );
  const upstreamApp = json(UI, "templates/react/package.json");
  for (const [k, v] of Object.entries(upstreamApp.dependencies))
    assert.equal(app.dependencies[k], v, k);
  assert.deepEqual(app.devDependencies, upstreamApp.devDependencies);
  assert.deepEqual(app.scripts, upstreamApp.scripts);

  const yml = read(out, "scaffold.yml");
  assert.ok(yml.startsWith(read(UI, "scaffold.yml").replace(/\n*$/, "\n")));
  assert.match(yml, /\nextensions:\n {2}usagemap:\n {4}# /);
  // The contract id the upstream template declares for testnet is one the extension accepts.
  const id = /source: (C[A-Z2-7]{55})/.exec(yml)?.[1];
  assert.ok(id, "testnet contract id in scaffold.yml");
  assert.ok(!existsSync(join(out, "templates")));
  assert.ok(!existsSync(join(out, "app/src/usagemap.ts.orig")));
  assert.equal(rec.upstream.commit, head);
});
