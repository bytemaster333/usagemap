// SPDX-License-Identifier: Apache-2.0
// Copy the locked dependency closure of named packages out of a pnpm node_modules tree.
//
// Usage: node copy-closure.mjs <src-app-dir> <dest-dir> <pkg> [<pkg> ...]
//
// Why: upstream's runner stage runs an unlocked `pnpm add prisma @prisma/client ... chalk ...`
// (Dockerfile:78 at d3c62a8). We instead take exactly the versions that `pnpm install
// --frozen-lockfile` already resolved in the deps stage. pnpm's layout makes the closure
// explicit: node_modules/<pkg> -> .pnpm/<entry>/node_modules/<pkg>, and each package's
// dependencies are symlinks inside .pnpm/<entry>/node_modules/. We follow those symlinks,
// copy every .pnpm/<entry> reached, and re-create the top-level links.
import fs from 'node:fs';
import path from 'node:path';

const [src, dest, ...roots] = process.argv.slice(2);
if (!src || !dest || roots.length === 0) {
  console.error('usage: copy-closure.mjs <src-app-dir> <dest-dir> <pkg>...');
  process.exit(2);
}
const srcNm = path.join(src, 'node_modules');
const store = path.join(srcNm, '.pnpm');
const entries = new Set();

// Given the real path of a package inside the virtual store, return its .pnpm/<entry> name.
function entryOf(real) {
  const rel = path.relative(store, real);
  if (rel.startsWith('..')) throw new Error(`not in virtual store: ${real}`);
  return rel.split(path.sep)[0];
}

function linksIn(nmDir) {
  const out = [];
  for (const d of fs.readdirSync(nmDir, { withFileTypes: true })) {
    const p = path.join(nmDir, d.name);
    if (d.name.startsWith('@') && d.isDirectory()) {
      for (const s of fs.readdirSync(p, { withFileTypes: true })) {
        if (s.isSymbolicLink()) out.push(path.join(p, s.name));
      }
    } else if (d.isSymbolicLink()) {
      out.push(p);
    }
  }
  return out;
}

function visit(real) {
  const e = entryOf(real);
  if (entries.has(e)) return;
  entries.add(e);
  for (const link of linksIn(path.join(store, e, 'node_modules'))) {
    visit(fs.realpathSync(link));
  }
}

for (const name of roots) visit(fs.realpathSync(path.join(srcNm, name)));

const destStore = path.join(dest, 'node_modules', '.pnpm');
fs.mkdirSync(destStore, { recursive: true });
for (const e of [...entries].sort()) {
  fs.cpSync(path.join(store, e), path.join(destStore, e), { recursive: true, verbatimSymlinks: true });
}
for (const name of roots) {
  const real = fs.realpathSync(path.join(srcNm, name));
  const link = path.join(dest, 'node_modules', name);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(link), path.join(destStore, path.relative(store, real))), link);
}
console.log(`copied ${entries.size} locked packages for: ${roots.join(' ')}`);
for (const e of [...entries].sort()) console.log(`  ${e}`);
