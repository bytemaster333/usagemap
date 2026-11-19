// SPDX-License-Identifier: Apache-2.0
// Signs a SEP-53 sign-in message with a demo key, for the portal's "any wallet" sign-in path:
//   node tools/demo-seed/sign.ts '<message shown by the portal>'            → demo viewer (read-only) signature
//   node tools/demo-seed/sign.ts --as demo-alder-remit '<message>'          → that demo project's owner
//   node tools/demo-seed/sign.ts --operator '<message>'                      → the demo operator (needs its
//                                                                              secret: --operator-secret or
//                                                                              SCF_DEMO_OPERATOR_SECRET)
//   node tools/demo-seed/sign.ts --account [--as …|--operator]              → just print the account
// The keys are derived from the seed phrase (SCF_DEMO_PHRASE or --phrase; the default demo phrase otherwise). They
// are demo keys for a local stack: never fund them or use them on a public network.

import { parseArgs } from "node:util";
import { DEFAULT_PHRASE } from "./src/plan.ts";
import { operatorKey, ownerKey, viewerKey } from "./src/sql.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    phrase: { type: "string", default: process.env.SCF_DEMO_PHRASE ?? DEFAULT_PHRASE },
    as: { type: "string" },
    account: { type: "boolean", default: false },
    operator: { type: "boolean", default: false },
    "operator-secret": { type: "string", default: process.env.SCF_DEMO_OPERATOR_SECRET },
  },
});
const phrase = values.phrase as string;
if (values.operator && !values["operator-secret"]) {
  process.stderr.write(
    "the demo operator's key comes from its secret: --operator-secret or SCF_DEMO_OPERATOR_SECRET\n",
  );
  process.exit(2);
}
const key = values.operator
  ? operatorKey(values["operator-secret"] as string)
  : values.as
    ? ownerKey(phrase, values.as)
    : viewerKey(phrase);
if (values.account) {
  process.stdout.write(`${key.account}\n`);
} else {
  const message = positionals.join(" ");
  if (!message) {
    process.stderr.write("usage: node tools/demo-seed/sign.ts [--as <demo-slug>] '<message>'\n");
    process.exit(2);
  }
  process.stdout.write(`account    ${key.account}\nsignature  ${key.signMessage(message)}\n`);
}
