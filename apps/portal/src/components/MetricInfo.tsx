// SPDX-License-Identifier: Apache-2.0
// The definition behind a figure (2026-11-19 improvements): every metric card carries an info disclosure with the
// figure's definition, generated at build time from docs/metrics/definitions.md (scripts/gen-definitions.ts). A
// <details> element: keyboard- and screen-reader-accessible, no script, nothing loaded from elsewhere (portal CSP).

import type { ReactNode } from "react";
import { METRIC_DEFINITIONS, type MetricKey } from "../lib/definitions.gen.ts";

export function metricDefinition(key: MetricKey) {
  return METRIC_DEFINITIONS[key];
}

export function MetricInfo({ metric }: { metric: MetricKey }) {
  const d = METRIC_DEFINITIONS[metric];
  return (
    <details className="metric-info" data-testid={`def-${metric}`}>
      <summary aria-label={`Definition: ${d.term}`}>
        <span aria-hidden="true">ⓘ</span>
      </summary>
      <p className="small">
        <strong>{d.term}.</strong> {d.text}
      </p>
    </details>
  );
}

/** A figure card: label with its definition, value, optional note. `metric` is required: no card without a definition. */
export function MetricTile({
  metric,
  label,
  value,
  sub,
  testId,
  children,
}: {
  metric: MetricKey;
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <div className="tile" data-testid={testId} data-metric={metric}>
      <div className="tile-head">
        <p className="tile-label">{label}</p>
        <MetricInfo metric={metric} />
      </div>
      <p className="tile-value">{value}</p>
      {sub ? <p className="tile-sub">{sub}</p> : null}
      {children}
    </div>
  );
}

/** The definitions of a card's figures as one disclosure (cards that show several figures in a list or table). */
export function MetricDefinitions({ metrics }: { metrics: readonly MetricKey[] }) {
  return (
    <details className="metric-defs" data-testid="metric-definitions">
      <summary>Definitions</summary>
      <dl className="small">
        {metrics.map((m) => (
          <div key={m} data-testid={`def-${m}`}>
            <dt>{METRIC_DEFINITIONS[m].term}</dt>
            <dd>{METRIC_DEFINITIONS[m].text}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
