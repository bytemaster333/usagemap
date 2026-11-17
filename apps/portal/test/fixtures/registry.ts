// SPDX-License-Identifier: Apache-2.0
// FAKE registry projects for the portal's tests and mock control plane. These are invented names and `.example`
// domains — not real SCF projects, not real teams, not real contracts.

import type { ControlPlane } from "@usagemap/api-types";

export interface FakeRegistryProject {
  id: string;
  name: string;
  domain: string | null;
  categories: ControlPlane.ScfCategory[];
  round: number | null;
  stage: ControlPlane.AwardStage | null;
  contracts: string[];
  githubOrgs: string[];
}

export const FAKE_CONTRACT = `C${"FAKE".repeat(13)}AAA`;

export const FAKE_REGISTRY: readonly FakeRegistryProject[] = [
  {
    id: "d0000000-0000-4000-8000-000000000001",
    name: "Fakeorbit Wallet (FAKE)",
    domain: "fakeorbit.example",
    categories: ["end_user_application"],
    round: 33,
    stage: "t3_mainnet",
    contracts: [FAKE_CONTRACT],
    githubOrgs: ["fakeorbit-example"],
  },
  {
    id: "d0000000-0000-4000-8000-000000000002",
    name: "Fakeledger Tools (FAKE)",
    domain: "fakeledger-tools.vercel.app",
    categories: ["developer_tooling"],
    round: 30,
    stage: "t1_mvp",
    contracts: [],
    githubOrgs: [],
  },
  {
    id: "d0000000-0000-4000-8000-000000000003",
    name: "Fakeclaimed Labs (FAKE)",
    domain: "fakeclaimed.example",
    categories: ["financial_protocols"],
    round: 28,
    stage: "t2_testnet",
    contracts: [],
    githubOrgs: [],
  },
];

/** Projects another (unseen) tenant has already verified: the picker shows "already claimed — dispute". */
export const CLAIMED_ELSEWHERE: ReadonlySet<string> = new Set([
  "d0000000-0000-4000-8000-000000000003",
]);
