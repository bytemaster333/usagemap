// SPDX-License-Identifier: Apache-2.0
// @ts-check
// Core of the tracker-pin check: parse the published release list, find every UsageMap tracker <script> in a text,
// judge its pin (version released and not withdrawn, SRI hash equal to the release's, crossorigin="anonymous"), and
// rewrite the tag to the proposed pin. Pure functions, Node standard library only; main.mjs does the I/O.

/**
 * @typedef {{ profile: "standard" | "strict", path: string, integrity: string }} TrackerFile
 * @typedef {{ version: string, status: "active" | "withdrawn", files: TrackerFile[] }} TrackerVersion
 * @typedef {{ start: number, end: number, value: string, quote: string } | null} AttrSpan
 * @typedef {{
 *   file: string, line: number, column: number, tagStart: number, tagEnd: number,
 *   host: string, version: string, profile: string,
 *   severity: "error" | "warning" | "ok", codes: string[], message: string,
 *   current: { version: string, integrity: string | null },
 *   proposed: { version: string, integrity: string, src: string } | null
 * }} Finding
 */

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const INTEGRITY = /^sha384-[A-Za-z0-9+/]{64}$/;

/** @param {string} a @param {string} b */
export function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * Reads the three published shapes of the release list: the control plane's `GET /v1/tracker/versions` (array, with
 * status), the edge's `GET /lib/manifest.json` (`scf-analytics/tracker-manifests/1`) and a single release manifest
 * (`tracker/releases/<v>/manifest.json`). Newest first.
 * @param {string} text
 * @returns {TrackerVersion[]}
 */
export function parseVersions(text) {
  /** @type {any} */
  const doc = JSON.parse(text);
  /** @type {any[]} */
  let raws;
  if (Array.isArray(doc)) raws = doc;
  else if (doc && Array.isArray(doc.versions)) raws = doc.versions;
  else if (doc && typeof doc.version === "string") raws = [doc];
  else throw new Error("not a tracker release list: no versions");
  /** @type {TrackerVersion[]} */
  const out = [];
  for (const r of raws) {
    if (typeof r?.version !== "string" || !SEMVER.test(r.version)) {
      throw new Error(`tracker release list: bad version ${JSON.stringify(r?.version)}`);
    }
    const status = r.status ?? "active";
    if (status !== "active" && status !== "withdrawn") {
      throw new Error(`tracker ${r.version}: unknown status ${JSON.stringify(status)}`);
    }
    /** @type {TrackerFile[]} */
    const files = [];
    for (const f of Array.isArray(r.files) ? r.files : []) {
      if (f?.profile !== "standard" && f?.profile !== "strict") continue;
      if (typeof f.integrity !== "string" || !INTEGRITY.test(f.integrity)) {
        throw new Error(`tracker ${r.version}/${f.profile}: bad integrity`);
      }
      files.push({
        profile: f.profile,
        path: typeof f.url === "string" ? f.url : `/lib/${r.version}/${f.profile}.js`,
        integrity: f.integrity,
      });
    }
    out.push({ version: r.version, status, files });
  }
  out.sort((a, b) => compareSemver(b.version, a.version));
  return out;
}

/**
 * Attribute value inside one tag. Names are matched case-insensitively (JSX writes `crossOrigin`). Values may be
 * quoted with " or ', or written as a JSX string expression {"…"}.
 * @param {string} tag
 * @param {string} name
 * @returns {AttrSpan}
 */
export function findAttr(tag, name) {
  const re = new RegExp(
    `(?<=[\\s<])${name}\\s*=\\s*(?:(")([^"]*)"|(')([^']*)'|\\{\\s*(")([^"]*)"\\s*\\})`,
    "i",
  );
  const m = re.exec(tag);
  if (!m) return null;
  const quote = m[1] ?? m[3] ?? m[5] ?? '"';
  const value = m[2] ?? m[4] ?? m[6] ?? "";
  const rel = m[0].indexOf(quote) + 1;
  return { start: m.index + rel, end: m.index + rel + value.length, value, quote };
}

/** @param {string} tag @param {string} name */
function hasBareAttr(tag, name) {
  return new RegExp(`(?<=[\\s<])${name}(?=[\\s/>])`, "i").test(tag);
}

const SCRIPT_TAG = /<script\b[^>]*>/gi;
const TEMPLATED = /\$\{|\{\{|\{%|<%|<\?/;
const TRACKER_PATH = /^\/lib\/([^/]+)\/([^/.]+)\.js$/;

/** @param {string} text @param {number} offset */
function lineCol(text, offset) {
  let line = 1;
  let last = -1;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) {
    line++;
    last = i;
  }
  return { line, column: offset - last };
}

/**
 * Finds and judges every UsageMap tracker <script> (src on one of `hosts`, path /lib/<version>/<profile>.js).
 * @param {string} file
 * @param {string} text
 * @param {TrackerVersion[]} versions
 * @param {string[]} hosts lower-case host names
 * @param {{ upgrade?: boolean }} [opts] upgrade (default true): every proposal moves to the newest active release.
 *   false: a tag on an active release whose attributes are wrong keeps its version, and an outdated but correct pin
 *   gets no proposal (it is still reported as a warning).
 * @returns {Finding[]}
 */
export function scanText(file, text, versions, hosts, opts = {}) {
  const upgrade = opts.upgrade ?? true;
  /** @type {Finding[]} */
  const out = [];
  const newestActive = (/** @type {string} */ profile) =>
    versions.find((v) => v.status === "active" && v.files.some((f) => f.profile === profile));
  for (const m of text.matchAll(SCRIPT_TAG)) {
    const tag = m[0];
    const src = findAttr(tag, "src");
    if (!src) continue;
    if (TEMPLATED.test(src.value)) {
      // A src built by a template engine or a JS template literal cannot be judged or rewritten here.
      const lower = src.value.toLowerCase();
      if (lower.includes("/lib/") && hosts.some((h) => lower.includes(h))) {
        const at = lineCol(text, m.index);
        out.push({
          file,
          line: at.line,
          column: at.column,
          tagStart: m.index,
          tagEnd: m.index + tag.length,
          host: "",
          version: "",
          profile: "",
          severity: "warning",
          codes: ["templated"],
          message:
            "the src is built by a template, so its pin cannot be checked: render an exact version and its integrity hash.",
          current: { version: "", integrity: findAttr(tag, "integrity")?.value ?? null },
          proposed: null,
        });
      }
      continue;
    }
    /** @type {URL} */
    let u;
    try {
      u = new URL(src.value.startsWith("//") ? `https:${src.value}` : src.value);
    } catch {
      continue;
    }
    if (!hosts.includes(u.hostname.toLowerCase())) continue;
    const pm = TRACKER_PATH.exec(u.pathname);
    if (!pm) continue;
    const version = pm[1] ?? "";
    const profile = pm[2] ?? "";
    const at = lineCol(text, m.index);
    const integrity = findAttr(tag, "integrity");
    const cross = findAttr(tag, "crossorigin");
    /** @type {string[]} */
    const codes = [];
    /** @type {string[]} */
    const why = [];
    const rel = versions.find((v) => v.version === version);
    const relFile = rel?.files.find((f) => f.profile === profile);
    if (u.protocol !== "https:") {
      codes.push("insecure_src");
      why.push("the src is not https");
    }
    if (u.search || u.hash) {
      codes.push("src_query");
      why.push("the src carries a query or fragment");
    }
    if (!SEMVER.test(version)) {
      codes.push("unpinned_version");
      why.push(`"${version}" is not an exact version`);
    } else if (!rel) {
      codes.push("unknown_version");
      why.push(`${version} is not a released version`);
    } else if (rel.status === "withdrawn") {
      codes.push("withdrawn");
      why.push(`${version} is withdrawn (its files answer 410: the tracker does not run)`);
    } else if (!relFile) {
      codes.push("unknown_profile");
      why.push(`${version} has no "${profile}" profile`);
    }
    if (!integrity) {
      codes.push("missing_integrity");
      why.push("no integrity (SRI) attribute: the bytes are not pinned");
    } else if (
      relFile &&
      rel?.status === "active" &&
      integrity.value.trim() !== relFile.integrity
    ) {
      codes.push("integrity_mismatch");
      why.push(
        "the integrity hash is not the release's: the browser refuses the file and nothing is counted",
      );
    }
    // A bare `crossorigin` attribute is the anonymous state in HTML: accepted.
    if (!cross && !hasBareAttr(tag, "crossorigin")) {
      codes.push("missing_crossorigin");
      why.push('no crossorigin="anonymous": without it the browser cannot check the hash');
    } else if (cross && cross.value !== "anonymous" && cross.value !== "") {
      codes.push("bad_crossorigin");
      why.push(`crossorigin="${cross.value}" sends credentials; use "anonymous"`);
    }
    const target = newestActive(profile);
    const errors = codes.length > 0;
    const outdated = Boolean(
      rel && rel.status === "active" && target && compareSemver(rel.version, target.version) < 0,
    );
    if (outdated) {
      codes.push("outdated");
      why.push(
        `${version} is older than the newest release ${/** @type {TrackerVersion} */ (target).version}`,
      );
    }
    /** @type {Finding["proposed"]} */
    let proposed = null;
    const keepVersion = !upgrade && rel?.status === "active" && relFile !== undefined;
    if (errors || (outdated && upgrade)) {
      const pickV = keepVersion ? rel : target;
      const pickF = pickV?.files.find((f) => f.profile === profile);
      if (pickV && pickF) {
        const nu = new URL(pickF.path, `https://${u.host}`);
        proposed = { version: pickV.version, integrity: pickF.integrity, src: nu.toString() };
      }
    }
    out.push({
      file,
      line: at.line,
      column: at.column,
      tagStart: m.index,
      tagEnd: m.index + tag.length,
      host: u.hostname,
      version,
      profile,
      severity: errors ? "error" : outdated ? "warning" : "ok",
      codes,
      message: why.length
        ? `${why.join("; ")}.`
        : `pinned to ${version} with the release's SRI hash.`,
      current: { version, integrity: integrity ? integrity.value : null },
      proposed,
    });
  }
  return out;
}

/**
 * Rewrites one tag to the proposed pin: src and integrity values replaced (or integrity inserted after src), and
 * crossorigin="anonymous" set. Everything else in the tag is left byte-for-byte.
 * @param {string} tag
 * @param {{ src: string, integrity: string }} p
 */
export function fixTag(tag, p) {
  /** @type {{ start: number, end: number, text: string }[]} */
  const edits = [];
  const src = /** @type {NonNullable<AttrSpan>} */ (findAttr(tag, "src"));
  edits.push({ start: src.start, end: src.end, text: p.src });
  const integrity = findAttr(tag, "integrity");
  const cross = findAttr(tag, "crossorigin");
  const q = src.quote;
  const isJsxCase = /\bcrossOrigin\b|\bclassName\b|\{/.test(tag) || tag.startsWith("<Script");
  let insert = "";
  if (integrity) edits.push({ start: integrity.start, end: integrity.end, text: p.integrity });
  else insert += ` integrity=${q}${p.integrity}${q}`;
  if (cross) edits.push({ start: cross.start, end: cross.end, text: "anonymous" });
  else if (!hasBareAttr(tag, "crossorigin"))
    insert += ` ${isJsxCase ? "crossOrigin" : "crossorigin"}=${q}anonymous${q}`;
  if (insert) {
    // after the src attribute's closing quote (or closing brace of a JSX expression)
    let at = src.end + 1;
    if (tag[at] === "}") at++;
    else if (/^\s*\}/.test(tag.slice(at))) at = tag.indexOf("}", at) + 1;
    edits.push({ start: at, end: at, text: insert });
  }
  edits.sort((a, b) => b.start - a.start);
  let out = tag;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/**
 * Applies the proposed pins of a file's findings to its text.
 * @param {string} text
 * @param {Finding[]} findings
 */
export function fixText(text, findings) {
  const todo = findings.filter((f) => f.proposed).sort((a, b) => b.tagStart - a.tagStart);
  let out = text;
  for (const f of todo) {
    const p = /** @type {NonNullable<Finding["proposed"]>} */ (f.proposed);
    out =
      out.slice(0, f.tagStart) + fixTag(out.slice(f.tagStart, f.tagEnd), p) + out.slice(f.tagEnd);
  }
  return out;
}

/** @param {string} s */
function splitLines(s) {
  const lines = s.split("\n");
  const noEol = !s.endsWith("\n");
  if (!noEol) lines.pop();
  return { lines, noEol };
}

/**
 * Line-level edit script (LCS; deletions before insertions) of two line arrays.
 * @param {string[]} A
 * @param {string[]} B
 * @returns {{ op: " " | "-" | "+", text: string, ai: number, bi: number }[]}
 */
function editScript(A, B) {
  const n = A.length;
  const m = B.length;
  // dp[i * (m + 1) + j] = LCS length of A[i:] and B[j:]
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (/** @type {number} */ i, /** @type {number} */ j) => dp[i * (m + 1) + j] ?? 0;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * (m + 1) + j] =
        A[i] === B[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  /** @type {{ op: " " | "-" | "+", text: string, ai: number, bi: number }[]} */
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      ops.push({ op: " ", text: A[i] ?? "", ai: i++, bi: j++ });
    } else if (i < n && (j === m || at(i + 1, j) >= at(i, j + 1))) {
      ops.push({ op: "-", text: A[i] ?? "", ai: i++, bi: j });
    } else {
      ops.push({ op: "+", text: B[j] ?? "", ai: i, bi: j++ });
    }
  }
  return ops;
}

/**
 * Unified diff (git format, 3 lines of context) of two versions of one file. The LCS runs only on the region
 * between the common prefix and suffix, which is small here (only tags change).
 * @param {string} path repository-relative, forward slashes
 * @param {string} before
 * @param {string} after
 */
export function unifiedDiff(path, before, after) {
  if (before === after) return "";
  const a = splitLines(before);
  const b = splitLines(after);
  const A = a.lines;
  const B = b.lines;
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  // The last line is common only if both or neither end with a newline.
  while (
    suf < A.length - pre &&
    suf < B.length - pre &&
    A[A.length - 1 - suf] === B[B.length - 1 - suf] &&
    !(suf === 0 && a.noEol !== b.noEol)
  )
    suf++;
  /** @type {{ op: " " | "-" | "+", text: string, ai: number, bi: number }[]} */
  const ops = [];
  for (let k = 0; k < pre; k++) ops.push({ op: " ", text: A[k] ?? "", ai: k, bi: k });
  for (const o of editScript(A.slice(pre, A.length - suf), B.slice(pre, B.length - suf))) {
    ops.push({ ...o, ai: o.ai + pre, bi: o.bi + pre });
  }
  for (let k = 0; k < suf; k++) {
    const ai = A.length - suf + k;
    ops.push({ op: " ", text: A[ai] ?? "", ai, bi: B.length - suf + k });
  }
  const C = 3;
  const isChange = (/** @type {number} */ k) => (ops[k]?.op ?? " ") !== " ";
  let out = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
  let k = 0;
  while (k < ops.length) {
    if (!isChange(k)) {
      k++;
      continue;
    }
    const start = Math.max(0, k - C);
    let end = k;
    // one hunk while changes are at most 2*C context lines apart
    for (;;) {
      while (end < ops.length && isChange(end)) end++;
      let next = end;
      while (next < ops.length && !isChange(next)) next++;
      if (next < ops.length && next - end <= 2 * C) end = next;
      else break;
    }
    const stop = Math.min(ops.length, end + C);
    const h = ops.slice(start, stop);
    const first = h[0];
    if (!first) break;
    const aLen = h.filter((o) => o.op !== "+").length;
    const bLen = h.filter((o) => o.op !== "-").length;
    out += `@@ -${aLen ? first.ai + 1 : first.ai},${aLen} +${bLen ? first.bi + 1 : first.bi},${bLen} @@\n`;
    for (const o of h) {
      out += `${o.op}${o.text}\n`;
      const lastA = o.op !== "+" && o.ai === A.length - 1 && a.noEol;
      const lastB = o.op !== "-" && o.bi === B.length - 1 && b.noEol;
      if (lastA || lastB) out += "\\ No newline at end of file\n";
    }
    k = stop;
  }
  return out;
}
