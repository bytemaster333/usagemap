// SPDX-License-Identifier: Apache-2.0
// Canary values planted in the wallet mocks (unit tests and the browser fixture): none of them may ever appear in a
// request body. Plain data, no test-runner imports, so the browser fixture bundles it too.

/** Canaries planted in every mock wallet's results, arguments and errors. */
export const CANARY = {
  /** account (G…), contract (C…), muxed (M…) and secret (S…) StrKeys */
  G: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
  C: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  M: "MAAAAAAAAAAAAAB7BQ2L7E5NBWMXDUCMZSIPOBKRDSBYVLMXGSSKF6YNPIB7Y77ITLVL6",
  S: "SBK2VIYYSVG76E7VC3QHYARNFLY2EAQXDHRC7BMXBBGIFG74ARPRMNQM",
  /** transaction hash (64 hex) */
  HASH: "e8d1a7a8c8e3a9d0b3b0a5cb1d9b5b0c2f9a3b1e4d6c7a8b9c0d1e2f3a4b5c6d",
  /** base64 XDR (TransactionEnvelope starts with AAAA…) */
  XDR: "AAAAAgAAAABi/B0L0JGythwN1lY0aypo19NHxvLCyO5tBEcCVvwF9wAAAGQAAAAAAAAAAQAAAAAAAAAAAAAAAQAAAAAAAAAB",
  AMOUNT: "1234.5678901",
  PASSPHRASE: "Public Global Stellar Network ; September 2015",
  MESSAGE: "wallet says: account GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7 declined",
  SIGNED_MESSAGE: "c2lnbmVkLW1lc3NhZ2Utc2lnbmF0dXJlLWJ5dGVzLWNhbmFyeQ==",
} as const;
