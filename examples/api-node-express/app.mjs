// SPDX-License-Identifier: Apache-2.0
// The tenant's API: one route. No OpenTelemetry code; the start command loads it (package.json scripts).
import express from "express";

const app = express();
app.get("/accounts/:id", (req, res) => {
  if (req.params.id === "GMISSING") return res.status(404).json({ error: "account not found" });
  if (req.params.id === "GBOOM") return res.status(500).json({ error: "internal" });
  res.json({ id: req.params.id });
});

const port = Number(process.env.PORT ?? 8080);
const server = app.listen(port, process.env.HOST ?? "0.0.0.0");
process.on("SIGTERM", () => server.close());
