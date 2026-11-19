// SPDX-License-Identifier: Apache-2.0
// A stand-in for `stellar.charge` from `@stellar/mpp`, so that this example runs offline: the same method name,
// intent and request schema, but `verify` accepts one demo transaction hash instead of looking it up on the ledger.
// In your server, use `@stellar/mpp`'s `stellar.charge({ … })` here; nothing else in server.mjs changes.
import { Errors, Method, Receipt, z } from "mppx";

export const DEMO_TX = "demo-paid";

const stellarCharge = Method.from({
  name: "stellar",
  intent: "charge",
  schema: {
    credential: { payload: z.object({ hash: z.string(), type: z.literal("hash") }) },
    request: z.object({
      amount: z.string(),
      currency: z.string(),
      recipient: z.string(),
      description: z.optional(z.string()),
      externalId: z.optional(z.string()),
      methodDetails: z.optional(z.object({ network: z.string() })),
    }),
  },
});

export const demoStellarCharge = (network) =>
  Method.toServer(stellarCharge, {
    defaults: { methodDetails: { network } },
    async verify({ credential }) {
      if (credential.payload.hash !== DEMO_TX)
        throw new Errors.VerificationFailedError({ reason: "transaction not found" });
      return Receipt.from({
        method: "stellar",
        reference: credential.payload.hash,
        status: "success",
        timestamp: new Date().toISOString(),
      });
    },
  });
