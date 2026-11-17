// SPDX-License-Identifier: Apache-2.0
// SCF cohort vocabularies of registry_sync (wire-formats §i.4, C-136): label → slug mappings for categories and award
// stages, the latest award round, and the source rows that carry them. A label outside the closed lists is dropped,
// never guessed.

import { describe, expect, it } from "vitest";
import {
  awardStage,
  categorySlug,
  categorySlugs,
  latestAwardRound,
  pgAtlasRow,
  stellarlightRow,
} from "../../src/registry/sources.ts";

describe("§i.4 vocabularies", () => {
  it("maps the five SCF category labels (and their slugs) and nothing else", () => {
    expect(categorySlug("End-User Application")).toBe("end_user_application");
    expect(categorySlug("Financial Protocols")).toBe("financial_protocols");
    expect(categorySlug("Applications")).toBe("applications");
    expect(categorySlug(" developer  tooling ")).toBe("developer_tooling");
    expect(categorySlug("Infrastructure & Services")).toBe("infrastructure_services");
    expect(categorySlug("infrastructure_services")).toBe("infrastructure_services");
    for (const x of [
      "Education & Community",
      "SDKs",
      "Wallet Support",
      "",
      null,
      3,
      "Infrastructure and Services",
    ])
      expect(categorySlug(x)).toBeNull();
    expect(categorySlugs(["Applications", "Financial Protocols", "Applications", "Other"])).toEqual(
      ["applications", "financial_protocols"],
    );
  });
  it("maps tranche labels to award stages", () => {
    expect(awardStage("Pre-Launch #0 - Awarded")).toBe("t0_prelaunch");
    expect(awardStage("Pre-Launch #1 - MVP")).toBe("t1_mvp");
    expect(awardStage("Pre-Launch #2 - Testnet")).toBe("t2_testnet");
    expect(awardStage("Pre-Launch #3 - Mainnet")).toBe("t3_mainnet");
    expect(awardStage("#3 Mainnet")).toBe("t3_mainnet");
    expect(awardStage("t2_testnet")).toBe("t2_testnet");
    for (const x of ["Pre-Launch #3 - Testnet", "#4 - Mainnet", "Mainnet", null, ""])
      expect(awardStage(x)).toBeNull();
  });
  it("takes the highest numbered award round", () => {
    expect(latestAwardRound([29, 31, "SCF #33", "40"])).toBe(40);
    expect(latestAwardRound(["Legacy", -226, 0, 1000])).toBeNull();
    expect(latestAwardRound([])).toBeNull();
  });
  it("fills the row fields from each source", () => {
    const sl = stellarlightRow({
      id: "x",
      name: "X",
      category: "Developer Tooling",
      scfTrancheCompletion: "Pre-Launch #1 - MVP",
      scfRoundAwards: [{ round: 28 }, { round: 35 }],
    });
    expect(sl).toMatchObject({
      scfCategories: ["developer_tooling"],
      awardRound: 35,
      awardStage: "t1_mvp",
    });
    const pga = pgAtlasRow({
      canonical_id: "daoip-5:scf:project:x",
      display_name: "X",
      category: "Applications",
      metadata: {
        scf_tranche_completion: "Pre-Launch #2 - Testnet",
        scf_submissions: [{ round: "SCF #40" }],
      },
    });
    // PG Atlas lists submissions, not awards: no round.
    expect(pga).toMatchObject({
      scfCategories: ["applications"],
      awardRound: null,
      awardStage: "t2_testnet",
    });
  });
});
