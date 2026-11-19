// SPDX-License-Identifier: Apache-2.0
// Local preview of the static export exactly as it is deployed at docs.usagemap.dev: out/ served at the root.
//   node scripts/serve.ts [port]   (default 3310)
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(import.meta.dirname, "..", "out");
const port = Number(process.argv[2] ?? process.env.PORT ?? 3310);
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

function resolve(urlPath: string): string | undefined {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, rel);
  if (!file.startsWith(root)) return undefined;
  if (existsSync(file) && statSync(file).isFile()) return file;
  const index = join(file, "index.html");
  if (existsSync(index)) return index;
  return undefined;
}

createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  const file = resolve(path);
  if (!file) {
    res.writeHead(404, { "content-type": types[".html"] });
    createReadStream(join(root, "404.html")).pipe(res);
    return;
  }
  const type =
    types[extname(file)] ??
    (file.endsWith("/api/search") ? types[".json"] : "application/octet-stream");
  res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => {
  console.log(`UsageMap docs: http://127.0.0.1:${port}/`);
});
