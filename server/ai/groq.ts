import Groq from "groq-sdk";
import { aiReady, config } from "../config.js";

let client: Groq | null = null;

export function groq(): Groq {
  if (!aiReady()) throw new AiUnavailableError();
  // GROQ_BASE_URL is honoured by the SDK itself (used by the offline test stand-in).
  client ??= new Groq({ apiKey: config.ai.apiKey });
  return client;
}

export class AiUnavailableError extends Error {
  constructor() {
    super("GROQ_API_KEY is not set. Add it to .env to enable Tally's AI features.");
  }
}

/** Provider-neutral chat history (OpenAI-compatible shape, which is what Groq speaks). */
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export const isGroqError = (err: unknown): err is InstanceType<typeof Groq.APIError> => err instanceof Groq.APIError;

/** Llama and Qwen sometimes emit a malformed tool call; Groq reports it as HTTP 400 `tool_use_failed`. */
export const isToolUseFailure = (err: unknown) =>
  isGroqError(err) && err.status === 400 && JSON.stringify(err.error ?? "").includes("tool_use_failed");

/** GPT-OSS models don't support parallel tool calls; the others do. */
export const supportsParallelTools = (model: string) => !model.startsWith("openai/gpt-oss");
