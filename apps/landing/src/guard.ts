// SPDX-License-Identifier: Apache-2.0
// The publication guard: the public site is generated from repository files written for a private repository, so
// before anything is written the build checks the text of every page for what must never be published — local
// machine paths, e-mail addresses, public IP addresses, Stellar secret seeds and account keys outside the documented
// examples. A hit fails the build; the fix is in the source document, never an exception here without review.

/** Address ranges that are not anyone's address: loopback, private, CGNAT, link-local, documentation, unspecified. */
export function isHarmlessIpv4(ip: string): boolean {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // not an address
  const [a, b, c] = o as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

const EMAIL_OK =
  /@(?:example\.(?:com|org|net)|[a-z0-9.-]*\.example|[a-z0-9.-]*\.invalid|[a-z0-9.-]*\.test)$/i;

/** Text content of a page (tags removed, the entities the site writes decoded). */
export function pageText(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

export function guardFindings(path: string, html: string): string[] {
  return textFindings(path, pageText(html));
}

/** The same checks on a plain-text file as published (skill.md, llms-full.txt, stellar.toml): nothing is stripped. */
export function textFindings(path: string, t: string): string[] {
  const out: string[] = [];
  const hit = (what: string, m: string) => out.push(`${path}: ${what} "${m}"`);
  for (const m of t.matchAll(/(?:\/home\/|\/Users\/|C:\\Users\\)[^\s"'<>]*/g))
    hit("local path", m[0]);
  for (const m of t.matchAll(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
  )) {
    if (!EMAIL_OK.test(m[0])) hit("e-mail address", m[0]);
  }
  for (const m of t.matchAll(/(?<![\w.]|[A-Za-z]\/)(\d{1,3}(?:\.\d{1,3}){3})(?![\w.])/g)) {
    if (!isHarmlessIpv4(m[1] as string)) hit("public IPv4 address", m[1] as string);
  }
  // Product versions ("Chrome/142.0.0.0") are not addresses: a number after "name/" is skipped above.
  // A secret seed is never published, example or not.
  for (const m of t.matchAll(/(?<![A-Z2-7])S[A-Z2-7]{55}(?![A-Z2-7])/g))
    hit("Stellar secret seed", m[0]);
  return out;
}
