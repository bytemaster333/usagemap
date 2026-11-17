// SPDX-License-Identifier: Apache-2.0
// Address policy of the domain verifier (data-model §8.4, C-10, threat model SSRF). A tenant controls the DNS of the
// host it asks us to verify, so every address the host resolves to must be a public unicast address before the
// verifier connects to it. IPv4 uses a deny-list of special-purpose blocks (RFC 6890 registry); IPv6 is allowed only
// inside global unicast 2000::/3 minus its special-purpose blocks, and forms that embed an IPv4 address (6to4, NAT64)
// are judged by that address. IPv4-mapped and IPv4-compatible IPv6 addresses are always refused.

import { isIP } from "node:net";

/** [network, prefix length] of IPv4 blocks that are never contacted. */
const V4_DENY: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.31.196.0", 24], // AS112
  ["192.52.193.0", 24], // AMT
  ["192.88.99.0", 24], // 6to4 relay anycast (deprecated)
  ["192.168.0.0", 16], // private
  ["192.175.48.0", 24], // AS112 direct delegation
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. broadcast 255.255.255.255
];

function v4ToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  return (
    (((p[0] as number) << 24) |
      ((p[1] as number) << 16) |
      ((p[2] as number) << 8) |
      (p[3] as number)) >>>
    0
  );
}

const V4_DENY_INT = V4_DENY.map(([net, len]) => {
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  return [(v4ToInt(net) & mask) >>> 0, mask] as const;
});

export function isPublicIPv4(ip: string): boolean {
  if (isIP(ip) !== 4) return false;
  const n = v4ToInt(ip);
  return !V4_DENY_INT.some(([net, mask]) => (n & mask) >>> 0 === net);
}

/** Parses an IPv6 address (incl. a dotted IPv4 tail, without zone) to 16 bytes; null when not IPv6. */
export function parseIPv6(ip: string): Uint8Array | null {
  if (isIP(ip) !== 6) return null;
  let s = ip;
  const tail: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const n = v4ToInt(dotted[1] as string);
    tail.push((n >>> 16) & 0xffff, n & 0xffff);
    s = s.slice(0, s.length - (dotted[1] as string).length);
    if (s.endsWith(":") && !s.endsWith("::")) s = s.slice(0, -1);
  }
  const [head = "", rest] = s.split("::") as [string, string | undefined];
  const parse = (x: string) => (x === "" ? [] : x.split(":").map((g) => Number.parseInt(g, 16)));
  const h = parse(head);
  const r = rest === undefined ? [] : parse(rest);
  const fill = 8 - tail.length - h.length - r.length;
  const groups =
    rest === undefined ? [...h, ...tail] : [...h, ...Array(fill).fill(0), ...r, ...tail];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    out[2 * i] = (g >> 8) & 0xff;
    out[2 * i + 1] = g & 0xff;
  });
  return out;
}

function prefixMatch(b: Uint8Array, net: Uint8Array, len: number): boolean {
  for (let i = 0; i < len; i++) {
    const byte = i >> 3;
    const bit = 7 - (i & 7);
    if ((((b[byte] as number) >> bit) & 1) !== (((net[byte] as number) >> bit) & 1)) return false;
  }
  return true;
}

const v6 = (s: string) => parseIPv6(s) as Uint8Array;
/** Special-purpose blocks inside 2000::/3 that are never contacted. */
const V6_DENY: ReadonlyArray<readonly [Uint8Array, number]> = [
  [v6("2001::"), 23], // IETF protocol assignments (incl. Teredo 2001::/32, ORCHIDv2, benchmarking 2001:2::/48)
  [v6("2001:db8::"), 32], // documentation
  [v6("3fff::"), 20], // documentation (RFC 9637)
];
const NAT64_WKP = v6("64:ff9b::");
const NAT64_LOCAL = v6("64:ff9b:1::");
const SIXTOFOUR = v6("2002::");

function v4Of(b: Uint8Array, offset: number): string {
  return `${b[offset]}.${b[offset + 1]}.${b[offset + 2]}.${b[offset + 3]}`;
}

export function isPublicIPv6(ip: string): boolean {
  const b = parseIPv6(ip);
  if (!b) return false;
  // NAT64 well-known prefix: the address is the embedded IPv4 one; the local-use prefix is never public.
  if (prefixMatch(b, NAT64_WKP, 96)) return isPublicIPv4(v4Of(b, 12));
  if (prefixMatch(b, NAT64_LOCAL, 48)) return false;
  // 6to4 (2002::/16) is refused outright: it reaches an embedded IPv4 address through public relays.
  if (prefixMatch(b, SIXTOFOUR, 16)) return false;
  // Only global unicast 2000::/3 — this excludes ::, ::1, IPv4-mapped/-compatible, fc00::/7, fe80::/10, fec0::/10,
  // ff00::/8, 100::/64, and the AWS metadata address fd00:ec2::254.
  if (((b[0] as number) & 0xe0) !== 0x20) return false;
  return !V6_DENY.some(([net, len]) => prefixMatch(b, net, len));
}

/** True only for a public unicast address the verifier may connect to. */
export function isPublicAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isPublicIPv4(ip);
  if (fam === 6) return isPublicIPv6(ip);
  return false;
}
