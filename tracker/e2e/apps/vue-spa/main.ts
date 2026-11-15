// SPDX-License-Identifier: Apache-2.0
// Vue Router SPA fixture (createWebHistory). The tracker is the classic script tag with SRI in <head>; the app is a
// separate module. Vue Router calls history.replaceState for the same URL when it starts, which must not count.
// Render functions instead of single-file components, so no Vue compiler is needed to build the fixture.

import { createApp, defineComponent, h } from "vue";
import { createRouter, createWebHistory, RouterLink, RouterView } from "vue-router";

interface Scf {
  track(name: string, props?: Record<string, string | number | boolean>): boolean;
}

const link = (id: string, to: string, text: string) =>
  h(RouterLink, { id, to }, { default: () => text });

const Home = defineComponent({ render: () => h("h1", "Home") });

const Doc = defineComponent({
  setup() {
    return () =>
      h("div", [
        h("h1", `Doc ${String(router.currentRoute.value.params.slug)}`),
        h("a", { id: "to-anchor", href: "#install" }, "Install (fragment only)"),
        h(
          "button",
          {
            id: "tab-api",
            type: "button",
            onClick: () => router.push({ query: { tab: "api" } }),
          },
          "API tab (query change only)",
        ),
        h(
          "button",
          {
            id: "copy",
            type: "button",
            onClick: () => (window as unknown as { scf: Scf }).scf.track("copy_snippet"),
          },
          "Copy snippet",
        ),
        h("section", { id: "install", style: "margin-top: 150vh" }, "Install"),
      ]);
  },
});

const Settings = defineComponent({ render: () => h("h1", "Settings") });

const App = defineComponent({
  render: () =>
    h("div", [
      h("nav", [
        link("nav-home", "/", "Home"),
        link("nav-doc-start", "/docs/getting-started", "Getting started"),
        link("nav-doc-api", "/docs/api", "API"),
        link("nav-settings", "/settings", "Settings"),
      ]),
      h(RouterView),
    ]),
});

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: Home },
    { path: "/docs/:slug", component: Doc },
    { path: "/settings", component: Settings },
  ],
});

createApp(App).use(router).mount("#app");
