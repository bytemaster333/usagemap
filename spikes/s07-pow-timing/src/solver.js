// SPDX-License-Identifier: Apache-2.0
// S-07 PoW solver, wire-formats.md §b.2 (ALTCHA-v2-style, deterministic, PBKDF2-HMAC-SHA-256).
//   password(c) = "scf-pow-v1" ‖ nonce ‖ uint32be(c); salt = nonce; dk = PBKDF2(password, salt, cost, 32 bytes)
//   find the c in [0, max) with dk(c)[0..4] == pfx.
// nonce = token bytes 27..43 (§b.1). The first 4 bytes of a 32-byte PBKDF2-SHA-256 output are the first 4 bytes
// of block T1, so deriving 32 bits gives exactly dk(c)[0..4] for the same work.
// `P` = number of deriveBits calls kept in flight at once (WebCrypto runs them off the JS thread).
// This module is the body of a Web Worker: postMessage([token, cost, max, pfx, P]) -> postMessage(c | -1).
var S = crypto.subtle;
onmessage = async function (e) {
  var d = e.data, t = d[0], cost = d[1], max = d[2], pfx = d[3], P = d[4] || 1;
  var b = Uint8Array.from(atob(t.replace(/-/g, "+").replace(/_/g, "/")), function (x) { return x.charCodeAt(0); });
  var n = b.subarray(27, 43), pw = new Uint8Array(30);
  pw.set(new TextEncoder().encode("scf-pow-v1"));
  pw.set(n, 10);
  function one(c) {
    var p = pw.slice();
    new DataView(p.buffer).setUint32(26, c);
    return S.importKey("raw", p, "PBKDF2", false, ["deriveBits"])
      .then(function (k) { return S.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: n, iterations: cost }, k, 32); })
      .then(function (r) {
        var h = "", u = new Uint8Array(r), i = 0;
        for (; i < 4; i++) h += (u[i] | 256).toString(16).slice(1);
        return h;
      });
  }
  for (var c = 0; c < max; c += P) {
    var q = [], j = c;
    for (; j < c + P && j < max; j++) q.push(one(j));
    var r = await Promise.all(q), i = r.indexOf(pfx);
    if (i >= 0) return postMessage(c + i);
  }
  postMessage(-1);
};
