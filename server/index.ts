import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiReady, config } from "./config.js";
import { store } from "./store.js";
import { api } from "./routes.js";
import { pages } from "./pages.js";

// A restart interrupts any in-flight agent turn; don't leave conversations stuck in "running".
for (const conv of Object.values(store.data.conversations)) {
  if (conv.status === "running") {
    conv.status = "error";
    conv.error = "Interrupted by a server restart";
  }
}

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use("/api", api);
app.use(pages);

const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/web");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api|pay).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

app.listen(config.port, () => {
  console.log(`\n  Tally API  →  http://localhost:${config.port}`);
  console.log(`  PayPal     →  ${config.paypal.mode === "sandbox" ? "live sandbox (api-m.sandbox.paypal.com)" : "built-in simulator (mock mode)"}`);
  console.log(`  Claude     →  ${aiReady() ? config.ai.model : "NOT CONFIGURED — set ANTHROPIC_API_KEY"}\n`);
});

process.on("SIGINT", () => {
  store.flush();
  process.exit(0);
});
