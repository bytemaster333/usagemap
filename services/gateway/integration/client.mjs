// SPDX-License-Identifier: Apache-2.0
// Runs inside a throwaway Node container on <project>_core (uid 65532, owner of the dev keys it uses), like
// infra/compose/scripts/smoke-client.mjs. Commands:
//   provision <websiteId> <twinId> <domain>   P1 + P7 ×2 through the engine proxy with the provisioner certificate
//   templates <file.json>                      one /api/send per synthetic UA template with the edge certificate
import { readFileSync } from "node:fs";
import { request } from "node:https";

const ca = readFileSync("/pki/ca.pem");
const id = (n) => ({ cert: readFileSync(`/pki/${n}.pem`), key: readFileSync(`/pki/${n}-key.pem`) });
function call(who, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: "engine-proxy",
        port: 8443,
        method,
        path,
        ca,
        servername: "engine-proxy",
        ...id(who),
        headers: {
          ...(data
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const [cmd, ...args] = process.argv.slice(2);
if (cmd === "provision") {
  const [website, twin, domain] = args;
  const pw = readFileSync("/run/prov_password", "utf8").trim();
  const login = await call("core-a-umami-bootstrap", "POST", "/api/auth/login", {
    username: "scf-provisioner",
    password: pw,
  });
  if (login.status !== 200) throw new Error(`P1 ${login.status}`);
  const token = JSON.parse(login.body).token;
  for (const [wid, name] of [
    [website, "wsb-main"],
    [twin, "wsb-twin"],
  ]) {
    const exists = await call("core-a-umami-bootstrap", "GET", `/api/websites/${wid}`, undefined, {
      authorization: `Bearer ${token}`,
    });
    let found = null;
    try {
      found = exists.status === 200 ? JSON.parse(exists.body) : null;
    } catch {}
    if (found && found.id === wid) continue; // idempotent on retry (P13 lookup; Umami answers 200 null when absent)
    const r = await call(
      "core-a-umami-bootstrap",
      "POST",
      "/api/websites",
      { id: wid, name, domain },
      { authorization: `Bearer ${token}` },
    );
    if (r.status !== 200) throw new Error(`P7 ${r.status} ${r.body}`);
  }
  console.log("provisioned");
} else if (cmd === "templates") {
  const [file, website] = args;
  const tpls = JSON.parse(readFileSync(file, "utf8"));
  let i = 0;
  for (const t of tpls) {
    i++;
    const sur = `2001:db8:77::${i.toString(16)}`;
    const r = await call(
      "edge-a1",
      "POST",
      "/api/send",
      {
        type: "event",
        payload: {
          website,
          hostname: "site.test",
          url: `/tpl/${i}`,
          screen:
            t.Device === "mobile" ? "390x844" : t.Device === "tablet" ? "820x1180" : "1536x864",
          tag: "v",
          timestamp: Math.floor(Date.now() / 1000),
        },
      },
      {
        "user-agent": t.UA,
        "x-scf-surrogate-ip": sur,
        "cf-ipcountry": "XX",
        "x-scf-visit": "none",
      },
    );
    if (r.status !== 200 || r.body.includes("beep"))
      throw new Error(`template ${t.Family}/${t.OS}/${t.Device}: ${r.status} ${r.body}`);
  }
  console.log(`sent ${i}`);
}
