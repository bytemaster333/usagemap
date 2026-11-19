// SPDX-License-Identifier: Apache-2.0
// Diagram building blocks for the technical-architecture pages. Plain HTML and CSS (styles in app/global.css,
// section "architecture diagrams"), so every diagram is crisp, selectable, searchable and readable on a phone.
import { Children, isValidElement, type ReactNode } from "react";

export type Tone = "ink" | "yellow" | "web" | "api" | "chain" | "plain" | "store";

/** One box in a diagram: icon, title, an optional one-line subtitle and an optional small detail list. */
export function Node({
  icon,
  title,
  sub,
  tone = "plain",
  children,
}: {
  icon?: ReactNode;
  title: string;
  sub?: ReactNode;
  tone?: Tone;
  children?: ReactNode;
}) {
  return (
    <div className={`arch-node arch-tone-${tone}`}>
      <div className="arch-node-hd">
        {icon ? <span className="arch-node-ic">{icon}</span> : null}
        <span className="arch-node-tx">
          <b>{title}</b>
          {sub ? <small>{sub}</small> : null}
        </span>
      </div>
      {children ? <div className="arch-node-bd">{children}</div> : null}
    </div>
  );
}

/** An arrow between two nodes in a Flow, with an optional label (protocol, payload). */
export function Arrow({ label }: { label?: ReactNode }) {
  return (
    <div className="arch-arrow" aria-hidden={label ? undefined : true}>
      <span className="arch-arrow-line" />
      {label ? <span className="arch-arrow-lb">{label}</span> : null}
    </div>
  );
}

/** A left-to-right chain of Node and Arrow elements; it turns top-to-bottom on narrow screens. */
export function Flow({ children, caption }: { children: ReactNode; caption?: ReactNode }) {
  return (
    <figure className="arch not-prose">
      <div className="arch-flow">{children}</div>
      {caption ? <figcaption className="arch-cap">{caption}</figcaption> : null}
    </figure>
  );
}

/** A grid of zones (trust boundaries, machines, networks). Use `cols` to set the number of columns on wide screens. */
export function Zones({
  children,
  caption,
  cols = 3,
}: {
  children: ReactNode;
  caption?: ReactNode;
  cols?: 1 | 2 | 3 | 4;
}) {
  return (
    <figure className="arch not-prose">
      <div className={`arch-zones arch-cols-${cols}`}>{children}</div>
      {caption ? <figcaption className="arch-cap">{caption}</figcaption> : null}
    </figure>
  );
}

/** A labelled area inside Zones that holds Nodes. `kind` changes the frame: public internet, our server, outside party. */
export function Zone({
  title,
  note,
  kind = "ours",
  children,
}: {
  title: string;
  note?: ReactNode;
  kind?: "ours" | "outside" | "public" | "stellar";
  children: ReactNode;
}) {
  return (
    <section className={`arch-zone arch-zone-${kind}`}>
      <header className="arch-zone-hd">
        <b>{title}</b>
        {note ? <small>{note}</small> : null}
      </header>
      <div className="arch-zone-bd">{children}</div>
    </section>
  );
}

/** A message in a Sequence: from one actor to another (same actor = a step done locally). */
export function Msg(_props: { from: string; to: string; children: ReactNode; note?: ReactNode }) {
  return null;
}

/**
 * A sequence diagram: actors as columns with lifelines, messages as arrows in order, numbered.
 * Usage: <Sequence actors={["Browser", "Gateway"]}><Msg from="Browser" to="Gateway">GET /challenge</Msg></Sequence>
 */
export function Sequence({
  actors,
  children,
  caption,
}: {
  actors: string[];
  children: ReactNode;
  caption?: ReactNode;
}) {
  const msgs = Children.toArray(children).filter(isValidElement) as {
    props: { from: string; to: string; children: ReactNode; note?: ReactNode };
  }[];
  const n = actors.length;
  const col = (a: string) => {
    const i = actors.indexOf(a);
    if (i < 0) throw new Error(`Sequence: unknown actor "${a}"`);
    return i;
  };
  return (
    <figure className="arch not-prose">
      <div className="arch-seq-scroll">
        <div
          className="arch-seq"
          style={{ gridTemplateColumns: `repeat(${n}, minmax(var(--arch-seq-col), 1fr))` }}
        >
          {actors.map((a, i) => (
            <div key={a} className="arch-seq-actor" style={{ gridColumn: i + 1, gridRow: 1 }}>
              {a}
            </div>
          ))}
          {actors.map((a, i) => (
            <div
              key={`l-${a}`}
              className="arch-seq-life"
              style={{ gridColumn: i + 1, gridRow: `2 / ${msgs.length + 2}` }}
            />
          ))}
          {msgs.map((m, k) => {
            const f = col(m.props.from);
            const t = col(m.props.to);
            const lo = Math.min(f, t);
            const hi = Math.max(f, t);
            const self = f === t;
            const dir = self ? "self" : t > f ? "right" : "left";
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: messages are a fixed, ordered list
                key={k}
                className={`arch-seq-msg arch-seq-${dir}`}
                style={{
                  gridColumn: `${lo + 1} / ${hi + 2}`,
                  gridRow: k + 2,
                  // the arrow runs from the centre of one lifeline to the centre of the other
                  marginInline: self ? undefined : `calc(50% / ${hi - lo + 1})`,
                }}
              >
                <span className="arch-seq-lb">
                  <i>{k + 1}</i>
                  <span>
                    {m.props.children}
                    {m.props.note ? <small>{m.props.note}</small> : null}
                  </span>
                </span>
                {self ? null : <span className="arch-seq-line" />}
              </div>
            );
          })}
        </div>
      </div>
      {caption ? <figcaption className="arch-cap">{caption}</figcaption> : null}
    </figure>
  );
}

/** A compact "where it lives / what it is" fact strip: label → value pairs. */
export function Facts({ children }: { children: ReactNode }) {
  return <dl className="arch-facts not-prose">{children}</dl>;
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="arch-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Status of a part of the design: what runs today, what is built but off, what is planned. */
export function Status({ kind }: { kind: "live" | "built" | "planned" }) {
  const text = { live: "Runs today", built: "Built, off by default", planned: "Planned" }[kind];
  return <span className={`arch-status arch-status-${kind}`}>{text}</span>;
}
