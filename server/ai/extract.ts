import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { clientsFrom } from "../books.js";
import { paypal } from "../paypal/index.js";
import { claude, modelParams } from "./claude.js";

export interface InvoiceDraft {
  client_name: string;
  client_email: string | null;
  items: { name: string; description: string; quantity: number; unit_amount: number }[];
  currency: string;
  due_in_days: number;
  tax_percent: number;
  note: string;
  confidence: "high" | "medium" | "low";
  missing: string[];
  summary: string;
}

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["client_name", "client_email", "items", "currency", "due_in_days", "tax_percent", "note", "confidence", "missing", "summary"],
  properties: {
    client_name: { type: "string", description: "Person or business being billed" },
    client_email: { type: ["string", "null"], description: "Email if present or matched to a known client, else null" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "quantity", "unit_amount"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          quantity: { type: "number" },
          unit_amount: { type: "number" },
        },
      },
    },
    currency: { type: "string", description: "ISO 4217 code" },
    due_in_days: { type: "integer" },
    tax_percent: { type: "number" },
    note: { type: "string", description: "Friendly note to print on the invoice (thank-you, deposit terms, etc.)" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    missing: { type: "array", items: { type: "string" }, description: "Fields the owner must check or fill in" },
    summary: { type: "string", description: "One sentence describing what was captured" },
  },
} as const;

export type CaptureInput = { text?: string; file?: { mediaType: string; base64: string } };

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

export async function extractInvoice(input: CaptureInput): Promise<InvoiceDraft> {
  const clients = clientsFrom(await paypal.listInvoices().catch(() => [])).map((c) => `${c.name} <${c.email}>`);
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];

  if (input.file) {
    if ((IMAGE_TYPES as readonly string[]).includes(input.file.mediaType)) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: input.file.mediaType as (typeof IMAGE_TYPES)[number], data: input.file.base64 },
      });
    } else if (input.file.mediaType === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: input.file.base64 } });
    } else {
      throw new Error(`Unsupported file type ${input.file.mediaType}. Use a photo (JPG/PNG/WebP) or a PDF.`);
    }
  }

  content.push({
    type: "text",
    text: `Turn this into an invoice draft for ${config.businessName}. It may be a client email or chat message, a handwritten job sheet, a quote, a receipt for billable materials, or notes.

Rules:
- Extract each billable line with quantity and unit price. Hours × rate become quantity × unit_amount. Never invent prices; if a price is missing use 0 and list it in "missing".
- If the source mentions a deposit or upfront percentage, bill only that portion and say so in the item name and note.
- Match the client to a known client when the name clearly refers to one and use their email. Known clients:
${clients.length ? clients.map((c) => `  - ${c}`).join("\n") : "  (none yet)"}
- Default currency ${config.currency}, default due_in_days 14 unless terms say otherwise (e.g. "net 30" → 30, "due on receipt" → 0), tax_percent 0 unless stated.
- "missing" lists anything the owner should verify (e.g. "client email", "price for item 2").
${input.text ? `\nSource text:\n"""\n${input.text}\n"""` : ""}`,
  });

  const res = await claude().beta.messages.create({
    ...modelParams,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content }],
  });
  if (res.stop_reason === "refusal") throw new Error("The model declined to process this input.");
  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("No draft returned");
  return JSON.parse(text.text) as InvoiceDraft;
}
