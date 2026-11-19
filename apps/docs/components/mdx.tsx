// SPDX-License-Identifier: Apache-2.0
import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import { Callout } from "fumadocs-ui/components/callout";
import { Card, Cards } from "fumadocs-ui/components/card";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { icons } from "lucide-react";
import type { MDXComponents } from "mdx/types";
import { Arrow, Fact, Facts, Flow, Msg, Node, Sequence, Status, Zone, Zones } from "./arch";
import { Feature, Features } from "./features";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    ...icons,
    Arrow,
    Fact,
    Facts,
    Flow,
    Msg,
    Node,
    Sequence,
    Status,
    Zone,
    Zones,
    Accordion,
    Accordions,
    Callout,
    Card,
    Cards,
    Feature,
    Features,
    Step,
    Steps,
    Tab,
    Tabs,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
