import "dotenv/config";

export type PayPalMode = "sandbox" | "mock";

function paypalMode(): PayPalMode {
  const explicit = process.env.PAYPAL_MODE?.toLowerCase();
  if (explicit === "mock") return "mock";
  if (explicit === "sandbox") return "sandbox";
  // Default: use the real sandbox whenever credentials are present.
  return process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET ? "sandbox" : "mock";
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, ""),
  businessName: process.env.BUSINESS_NAME ?? "Rivera Design Studio",
  currency: process.env.CURRENCY ?? "USD",
  dataFile: process.env.DATA_FILE ?? "data/tally.json",
  paypal: {
    mode: paypalMode(),
    clientId: process.env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
    webhookId: process.env.PAYPAL_WEBHOOK_ID ?? "",
    baseUrl: "https://api-m.sandbox.paypal.com",
  },
  ai: {
    provider: "Groq",
    apiKey: process.env.GROQ_API_KEY ?? "",
    /** Chat agent: production model with tool calling and parallel tool calls. */
    model: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
    /** Reads photos and returns schema-strict JSON for Capture. */
    visionModel: process.env.GROQ_VISION_MODEL ?? "qwen/qwen3.8-27b",
  },
};

export const aiReady = () => Boolean(config.ai.apiKey);
