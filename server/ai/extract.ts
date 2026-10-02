import { z } from "zod";
import { config } from "../config.js";
import { clientsFrom } from "../books.js";
import { paypal } from "../paypal/index.js";
import { groq, isGroqError } from "./groq.js";

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

/** JSON Schema for Groq strict mode: every field required, no extra properties, nulls for optionals. */
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

/** Models can be sloppy even under a schema; validate and coerce before the owner sees it. */
const Draft = z.object({
  client_name: z.string().default(""),
  client_email: z.string().nullable().default(null),
  items: z
    .array(
      z.object({
        name: z.string().default(""),
        description: z.string().default(""),
        quantity: z.coerce.number().default(1),
        unit_amount: z.coerce.number().default(0),
      }),
    )
    .default([]),
  currency: z.string().default(config.currency),
  due_in_days: z.coerce.number().int().default(14),
  tax_percent: z.coerce.number().default(0),
  note: z.string().default(""),
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
  missing: z.array(z.string()).default([]),
  summary: z.string().default(""),
});

export type CaptureInput = { text?: string; file?: { mediaType: string; base64: string } };

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

export function assertImage(file: { mediaType: string }) {
  if (file.mediaType === "application/pdf") {
    throw new Error("Groq's vision models read images, not PDFs. Export the page as a JPG or PNG and attach that.");
  }
  if (!IMAGE_TYPES.includes(file.mediaType)) {
    throw new Error(`Unsupported file type ${file.mediaType}. Use a photo (JPG, PNG, WebP or GIF).`);
  }
}

const imagePart = (file: { mediaType: string; base64: string }) => ({
  type: "image_url" as const,
  image_url: { url: `data:${file.mediaType};base64,${file.base64}` },
});

function prompt(input: CaptureInput, clients: string[]) {
  return `Turn this into an invoice draft for ${config.businessName}. It may be a client email or chat message, a handwritten job sheet, a quote, a receipt for billable materials, or notes.

Rules:
- Extract each billable line with quantity and unit price. Hours x rate become quantity x unit_amount. Never invent prices; if a price is missing use 0 and list it in "missing".
- If the source mentions a deposit or upfront percentage, bill only that portion and say so in the item name and note.
- Match the client to a known client when the name clearly refers to one and use their email. Known clients:
${clients.length ? clients.map((c) => `  - ${c}`).join("\n") : "  (none yet)"}
- Default currency ${config.currency}, default due_in_days 14 unless terms say otherwise (e.g. "net 30" = 30, "due on receipt" = 0), tax_percent 0 unless stated.
- "missing" lists anything the owner should verify (e.g. "client email", "price for item 2").
${input.text ? `\nSource text:\n"""\n${input.text}\n"""` : ""}`;
}

export async function extractInvoice(input: CaptureInput): Promise<InvoiceDraft> {
  if (input.file) assertImage(input.file);
  const clients = clientsFrom(await paypal.listInvoices().catch(() => [])).map((c) => `${c.name} <${c.email}>`);
  const content = [{ type: "text" as const, text: prompt(input, clients) }, ...(input.file ? [imagePart(input.file)] : [])];

  try {
    // Preferred: strict constrained decoding on the vision model (also fine for text-only input).
    return await run(config.ai.visionModel, content, {
      type: "json_schema",
      json_schema: { name: "invoice_draft", strict: true, schema },
    });
  } catch (err) {
    // Retry only when the model/format itself is unavailable, and only if no image needs the vision model.
    const unavailable = isGroqError(err) && (err.status === 400 || err.status === 404);
    if (!unavailable || input.file) throw friendly(err);
    return run(config.ai.model, content, { type: "json_object" }, `\n\nReply with only a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}`);
  }
}

async function run(model: string, content: unknown[], response_format: unknown, extra = ""): Promise<InvoiceDraft> {
  const withExtra = extra ? content.map((p, i) => (i === 0 ? { ...(p as object), text: (p as { text: string }).text + extra } : p)) : content;
  const res = await groq().chat.completions.create({
    model,
    messages: [{ role: "user", content: withExtra }] as never,
    response_format: response_format as never,
    temperature: 0.1,
    max_completion_tokens: 3000,
  });
  const raw = res.choices[0]?.message?.content;
  if (!raw) throw new Error("The model returned no draft.");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("The model's reply wasn't valid JSON. Try again.");
  }
  return Draft.parse(json) as InvoiceDraft;
}

function friendly(err: unknown): Error {
  if (isGroqError(err)) return new Error(`Groq API error ${err.status}: ${err.message}`);
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * The chat agent runs on a text model, so attachments are read by the vision model first and the
 * transcript is added to the owner's message.
 */
export async function describeAttachment(file: { mediaType: string; base64: string }): Promise<string> {
  assertImage(file);
  try {
    const res = await groq().chat.completions.create({
      model: config.ai.visionModel,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Transcribe everything in this image that matters for billing or payments: names, emails, items, quantities, prices, dates, terms, totals, and anything handwritten. Plain text, no commentary. If a part is unreadable, say so.",
            },
            imagePart(file),
          ],
        },
      ] as never,
      temperature: 0.1,
      max_completion_tokens: 1500,
    });
    return res.choices[0]?.message?.content?.trim() || "(The image could not be read.)";
  } catch (err) {
    throw friendly(err);
  }
}
