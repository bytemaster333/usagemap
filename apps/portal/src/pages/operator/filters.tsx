// SPDX-License-Identifier: Apache-2.0
// The filter bar of the web and API comparison tables: SCF round, award type, category, a name search and the "More
// filters" popover (minimum verification level, 28-day trust band). Round, award type and category are applied by
// the control plane (award_round / award_stage / category); the name search filters the loaded rows.

import { LEVELS, type Level } from "../../lib/search.ts";
import { MoreFilters, SearchBox, Sel } from "./kit.tsx";
import {
  BAND_TEXT,
  CATEGORIES,
  CATEGORY_SHORT,
  type OpSearch,
  STAGE_SHORT,
  STAGES,
} from "./model.ts";

export function FilterBar({
  search,
  set,
  rounds,
  shown,
  total,
  placeholder,
  rankMin,
  minLabel,
}: {
  search: OpSearch;
  set: (change: Partial<Record<keyof OpSearch, unknown>>) => void;
  rounds: number[];
  shown: number | null;
  total: number | null;
  placeholder: string;
  /** the platform's `op_rank_min_level` (rankings leave out projects below it by default) */
  rankMin: string;
  /** label of the threshold field: "Minimum page views" or "Minimum requests" */
  minLabel: string;
}) {
  const more =
    (search.min_level !== rankMin ? 1 : 0) + (search.band !== "any" ? 1 : 0) + (search.min ? 1 : 0);
  return (
    <div className="um-op-filters">
      <Sel
        label="SCF round"
        value={search.round ? String(search.round) : ""}
        onChange={(v) => set({ round: v ? Number(v) : undefined })}
      >
        <option value="">All SCF rounds</option>
        {(search.round && !rounds.includes(search.round) ? [search.round, ...rounds] : rounds).map(
          (r) => (
            <option key={r} value={r}>
              Round {r}
            </option>
          ),
        )}
      </Sel>
      <Sel
        label="Award type"
        value={search.stage ?? ""}
        onChange={(v) => set({ stage: v || undefined })}
      >
        <option value="">All award types</option>
        {STAGES.map((s) => (
          <option key={s} value={s}>
            {STAGE_SHORT[s]}
          </option>
        ))}
      </Sel>
      <Sel label="Category" value={search.cat ?? ""} onChange={(v) => set({ cat: v || undefined })}>
        <option value="">All categories</option>
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {CATEGORY_SHORT[c]}
          </option>
        ))}
      </Sel>
      <SearchBox
        value={search.q ?? ""}
        onChange={(v) => set({ q: v || undefined })}
        placeholder={placeholder}
        label="Search"
      />
      <MoreFilters
        count={more}
        onReset={() => set({ min_level: rankMin, band: "any", min: undefined })}
      >
        <div className="um-op-fld">
          <label htmlFor="op-f-level">Verification level</label>
          <Sel
            id="op-f-level"
            label="Verification level"
            value={search.min_level}
            onChange={(v) => set({ min_level: v as Level })}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l === "L4" ? "L4 only" : `${l} and up`}
              </option>
            ))}
          </Sel>
          <small>Projects below {rankMin} are left out of rankings by default.</small>
        </div>
        <div className="um-op-fld">
          <label htmlFor="op-f-band">Trust score, last 28 days</label>
          <Sel
            id="op-f-band"
            label="Trust score, last 28 days"
            value={search.band}
            onChange={(v) => set({ band: v })}
          >
            <option value="any">Any score</option>
            {(Object.keys(BAND_TEXT) as (keyof typeof BAND_TEXT)[]).map((b) => (
              <option key={b} value={b}>
                {BAND_TEXT[b]}
              </option>
            ))}
          </Sel>
        </div>
        <div className="um-op-fld">
          <label htmlFor="op-f-min">{minLabel}</label>
          <input
            id="op-f-min"
            className="um-inp um-inp--mono"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            placeholder="0"
            defaultValue={search.min ?? ""}
            key={search.min ?? 0}
            onBlur={(e) => {
              const n = Number(e.target.value);
              set({ min: Number.isInteger(n) && n > 0 ? n : undefined });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          <small>Rows below it are left out of the table.</small>
        </div>
      </MoreFilters>
      <span className="um-op-grow" />
      {shown !== null && total !== null ? (
        <span className="um-op-fcount" data-testid="filter-count">
          {shown} of {total}
        </span>
      ) : null}
    </div>
  );
}
