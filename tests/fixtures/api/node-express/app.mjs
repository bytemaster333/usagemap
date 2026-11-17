// SPDX-License-Identifier: Apache-2.0
// Sample API (Express 5). Routes: /health, /accounts/:id (404 for GMISSING), /assets/:code/:issuer, /boom (500).
import express from "express";

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/accounts/:id", (req, res) => {
  if (req.params.id === "GMISSING") return res.status(404).json({ error: "account not found" });
  res.json({ id: req.params.id, balance: "100.0000000" });
});
app.get("/assets/:code/:issuer", (req, res) =>
  res.json({ code: req.params.code, issuer: req.params.issuer }),
);
app.get("/boom", () => {
  throw new Error("boom");
});
// eslint-disable-next-line no-unused-vars
app.use((_err, _req, res, _next) => res.status(500).json({ error: "internal" }));

const port = Number(process.env.PORT ?? 18540);
const server = app.listen(port, process.env.HOST ?? "127.0.0.1", () =>
  console.log(`express listening on ${port}`),
);
process.on("SIGTERM", () => server.close());
