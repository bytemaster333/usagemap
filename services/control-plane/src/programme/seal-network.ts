// SPDX-License-Identifier: Apache-2.0
// The daily seal's network as the public API names it (wire-formats §m.2; C-135, C-136, C-137): every seal response
// says which network it is on, whether that network is durable and — on testnet — that the seal is a demonstration,
// and where a transaction can be looked up (Horizon first, then the public ledger files; never RPC alone).
//
//   SCF_SEAL_NETWORK             testnet (default) | mainnet
//   SCF_SEAL_NETWORK_PASSPHRASE  default: that network's passphrase
//   SCF_SEAL_HORIZON_URL         default: SDF's public Horizon of that network
//   SCF_SEAL_EXPLORER_URL        URL template with `{tx_hash}` (default: stellar.expert for that network)
//   SCF_SEAL_LEDGER_FILES_URL    root of the public ledger-file store (SEP-54 layout) of that network and reset segment
//                                (default: AWS Open Data pubnet on mainnet; none on testnet, whose directory changes
//                                with every reset)

export type SealNetworkName = "testnet" | "mainnet";

export const TESTNET_NOTICE =
  "Stellar testnet is reset several times a year; this seal is a demonstration, not durable evidence.";
export const SEAL_STATEMENT =
  "Tamper-evidence of a published snapshot. It does not show that the numbers are genuine.";

export const PASSPHRASES: Record<SealNetworkName, string> = {
  mainnet: "Public Global Stellar Network ; September 2015",
  testnet: "Test SDF Network ; September 2015",
};

const DEFAULT_HORIZON: Record<SealNetworkName, string> = {
  mainnet: "https://horizon.stellar.org",
  testnet: "https://horizon-testnet.stellar.org",
};

const DEFAULT_EXPLORER: Record<SealNetworkName, string> = {
  mainnet: "https://stellar.expert/explorer/public/tx/{tx_hash}",
  testnet: "https://stellar.expert/explorer/testnet/tx/{tx_hash}",
};

const DEFAULT_LEDGER_FILES: Record<SealNetworkName, string | null> = {
  mainnet: "https://aws-public-blockchain.s3.amazonaws.com/v1.1/stellar/ledgers/pubnet",
  testnet: null,
};

export interface SealNetworkConfig {
  name: SealNetworkName;
  passphrase: string;
  horizon: string;
  explorer: string | null;
  ledgerFiles: string | null;
}

/** The `SealNetwork` object of the public API (control-plane.openapi.yaml). */
export interface SealNetworkView {
  name: SealNetworkName;
  passphrase: string;
  durable: boolean;
  notice: string | null;
  lookup: { horizon: string; explorer: string | null; ledger_files: string | null };
}

function httpsUrl(v: string, name: string): string {
  let u: URL;
  try {
    u = new URL(v.replace("{tx_hash}", "0"));
  } catch {
    throw new Error(`${name} must be an https URL`);
  }
  if (u.protocol !== "https:") throw new Error(`${name} must be an https URL`);
  return v.replace(/\/$/, "");
}

export function sealNetworkName(v: string | undefined): SealNetworkName {
  if (v === undefined || v === "testnet") return "testnet";
  if (v === "mainnet") return "mainnet";
  throw new Error("SCF_SEAL_NETWORK must be testnet or mainnet");
}

/** Reads the seal network settings with `get` (the caller's env reader, which also honours `<NAME>_FILE`). */
export function parseSealNetwork(get: (name: string) => string | undefined): SealNetworkConfig {
  const name = sealNetworkName(get("SCF_SEAL_NETWORK"));
  const explorer = get("SCF_SEAL_EXPLORER_URL");
  if (explorer !== undefined && !explorer.includes("{tx_hash}"))
    throw new Error("SCF_SEAL_EXPLORER_URL must contain {tx_hash}");
  const files = get("SCF_SEAL_LEDGER_FILES_URL");
  return {
    name,
    passphrase: get("SCF_SEAL_NETWORK_PASSPHRASE") ?? PASSPHRASES[name],
    horizon: httpsUrl(get("SCF_SEAL_HORIZON_URL") ?? DEFAULT_HORIZON[name], "SCF_SEAL_HORIZON_URL"),
    explorer: explorer ? httpsUrl(explorer, "SCF_SEAL_EXPLORER_URL") : DEFAULT_EXPLORER[name],
    ledgerFiles: files ? httpsUrl(files, "SCF_SEAL_LEDGER_FILES_URL") : DEFAULT_LEDGER_FILES[name],
  };
}

/** The configured network's settings, or the public defaults of another network (a proof sealed before a move). */
export function networkSettings(cfg: SealNetworkConfig, name: SealNetworkName): SealNetworkConfig {
  if (name === cfg.name) return cfg;
  return {
    name,
    passphrase: PASSPHRASES[name],
    horizon: DEFAULT_HORIZON[name],
    explorer: DEFAULT_EXPLORER[name],
    ledgerFiles: DEFAULT_LEDGER_FILES[name],
  };
}

export function sealNetworkView(cfg: SealNetworkConfig): SealNetworkView {
  return {
    name: cfg.name,
    passphrase: cfg.passphrase,
    durable: cfg.name === "mainnet",
    notice: cfg.name === "testnet" ? TESTNET_NOTICE : null,
    lookup: { horizon: cfg.horizon, explorer: cfg.explorer, ledger_files: cfg.ledgerFiles },
  };
}

export function explorerUrl(cfg: SealNetworkConfig, txHashHex: string | null): string | null {
  return cfg.explorer && txHashHex ? cfg.explorer.replace("{tx_hash}", txHashHex) : null;
}
