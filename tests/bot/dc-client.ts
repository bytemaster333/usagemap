// SPDX-License-Identifier: Apache-2.0
// Runs inside a throwaway Node container on the test stack's `botnet` network (10.213.47.0/24, listed as
// `datacenter` in the gateway's range lists), so the gateway classifies this client's address as a cloud address.
//   node /t/bot/dc-client.ts '<json: {gateway, servername, site, origin, loads, act}>'
// Sends `loads` page loads (challenge → proof → one page view each, distinct User-Agent per load) with
// browser-identical headers and prints {statuses} as JSON.

import { browserHeaders, CHROME_UA, GatewayClient } from "../lib/gateway-client.ts";

const a = JSON.parse(process.argv[2] ?? "{}") as {
  gateway: string;
  servername: string;
  site: string;
  origin: string;
  loads: number;
  act: 0 | 1;
};
const statuses: number[] = [];
for (let i = 0; i < a.loads; i++) {
  const gw = new GatewayClient(
    { url: a.gateway, servername: a.servername, caFile: "" },
    browserHeaders(a.origin, CHROME_UA(120 + i)),
  );
  const { token, c } = await gw.solved(a.site);
  const r = await gw.send({
    site: a.site,
    token,
    c,
    sg: { wd: 0, vis: "v", act: a.act },
    events: [{ k: "pv", u: `/dc/${i}`, w: "l", l: "en" }],
  });
  statuses.push(r.status);
}
console.log(JSON.stringify({ statuses }));
