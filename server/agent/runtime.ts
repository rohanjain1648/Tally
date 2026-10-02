import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { bus } from "../bus.js";
import { claude, modelParams } from "../ai/claude.js";
import { newId, store, type Approval, type Conversation, type ToolOutcome } from "../store.js";
import { gate } from "./actions.js";
import { claudeTools } from "./tools.js";

type Msg = Anthropic.Beta.BetaMessageParam;

const MAX_ROUNDS = 12;

export type ConvEvent =
  | { type: "status"; status: Conversation["status"] }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; state: "done" | "error" | "pending" | "denied"; approvalId?: string }
  | { type: "turn_end" }
  | { type: "error"; message: string };

const emit = (conversationId: string, e: ConvEvent) => bus.emit(`conv:${conversationId}`, e);

function systemPrompt(kind: Conversation["kind"]) {
  return `You are Tally, the AI back-office agent for ${config.businessName}, a small business that gets paid through PayPal.
You act on the owner's real PayPal account through tools (invoicing, checkout links, refunds, subscriptions, transaction search).

How guarded actions work:
- Read tools always run. Write tools pass through the owner's guardrail policy, enforced in code, not by you.
- A write tool result is one of: executed (it happened), {"pending_approval": true} (it is queued on an approval card for the owner — tell them it is waiting for their approval and do not retry it), {"declined": true} (the owner said no — respect it and do not retry unless asked), or an error / block (explain plainly).
- Always fill the "reason" field with one short sentence the owner will read on the approval card.

Working style:
- Be concise and concrete. Use invoice numbers, client names and amounts formatted like $1,234.00. Default currency ${config.currency}.
- Look things up before acting on them. Never invent client emails, invoice ids or payment ids; ask if something essential is missing.
- To bill someone: create_invoice (draft), then send_invoice — unless the owner only asked for a draft.
- Reminders: friendly when just due, firmer and specific when long overdue, never threatening. Sign off as ${config.businessName}.
- Refunds need a payment id; find it with get_invoice (payment_ids) or list_transactions.
- Finish with a short summary of what happened and what is waiting for approval. Light markdown (bold, bullets) is fine.
${kind === "briefing" ? "\nYou are running the daily briefing: every write you make is a proposal the owner will review on the Today screen." : ""}
Today is ${new Date().toISOString().slice(0, 10)}.`;
}

export function createConversation(kind: Conversation["kind"] = "chat", title = "New conversation"): Conversation {
  const now = new Date().toISOString();
  const conv: Conversation = {
    id: newId(),
    title,
    kind,
    messages: [],
    pendingTurn: null,
    status: "idle",
    createdAt: now,
    updatedAt: now,
  };
  store.data.conversations[conv.id] = conv;
  store.save();
  return conv;
}

function setStatus(conv: Conversation, status: Conversation["status"], error?: string) {
  conv.status = status;
  conv.error = error;
  conv.updatedAt = new Date().toISOString();
  store.save();
  emit(conv.id, { type: "status", status });
}

export function sendMessage(conv: Conversation, content: Msg["content"]) {
  if (conv.status === "running") throw new Error("Tally is still working on the previous message.");
  if (conv.status === "awaiting_approval") throw new Error("Approve or reject the pending action first.");
  if (conv.messages.length === 0 && typeof content === "string") conv.title = content.slice(0, 60);
  conv.messages.push({ role: "user", content });
  void run(conv);
}

const toolResultBlock = (id: string, outcome: ToolOutcome): Anthropic.Beta.BetaToolResultBlockParam => ({
  type: "tool_result",
  tool_use_id: id,
  content: outcome.content,
  ...(outcome.ok ? {} : { is_error: true }),
});

/** The agent loop. History is append-only so thinking blocks stay valid when we resume later. */
async function run(conv: Conversation) {
  setStatus(conv, "running");
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const message = await callModel(conv);
      conv.messages.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
      store.save();

      if (message.stop_reason === "refusal") {
        emit(conv.id, { type: "text", delta: "\n\nI can't help with that request." });
        break;
      }
      if (message.stop_reason === "max_tokens") {
        emit(conv.id, { type: "text", delta: "\n\n(Stopped: response too long.)" });
        break;
      }
      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (message.stop_reason !== "tool_use" || toolUses.length === 0) break;

      const results: Record<string, ToolOutcome | null> = {};
      await Promise.all(
        toolUses.map(async (tu) => {
          emit(conv.id, { type: "tool_call", id: tu.id, name: tu.name, input: tu.input });
          const res = await gate(tu.name, tu.input, {
            source: conv.kind === "briefing" ? "briefing" : "agent",
            conversationId: conv.id,
            toolUseId: tu.id,
            proposeOnly: conv.kind === "briefing",
          });
          if (res.status === "pending") {
            results[tu.id] = null;
            emit(conv.id, { type: "tool_result", id: tu.id, state: "pending", approvalId: res.approval.id });
          } else {
            results[tu.id] = res.outcome;
            emit(conv.id, { type: "tool_result", id: tu.id, state: res.status === "denied" ? "denied" : res.outcome.ok ? "done" : "error" });
          }
        }),
      );

      const waiting = toolUses.filter((tu) => results[tu.id] === null);
      if (waiting.length > 0 && conv.kind === "chat") {
        // Suspend: the turn resumes when every pending call has a human decision.
        conv.pendingTurn = { toolUseIds: toolUses.map((t) => t.id), results };
        setStatus(conv, "awaiting_approval");
        emit(conv.id, { type: "turn_end" });
        return;
      }
      // Briefing proposals don't block: the agent keeps going and the cards wait on Today.
      for (const tu of waiting) {
        results[tu.id] = { ok: true, content: JSON.stringify({ pending_approval: true, message: "Queued for the owner's approval." }) };
      }
      conv.messages.push({ role: "user", content: toolUses.map((tu) => toolResultBlock(tu.id, results[tu.id]!)) });
    }
    setStatus(conv, "idle");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[agent]", message);
    // Keep history valid: if the last assistant turn has unanswered tool calls, answer them with errors.
    const last = conv.messages.at(-1);
    if (last?.role === "assistant" && Array.isArray(last.content)) {
      const pending = last.content.filter((b) => b.type === "tool_use") as Anthropic.Beta.BetaToolUseBlockParam[];
      if (pending.length) {
        conv.messages.push({ role: "user", content: pending.map((b) => toolResultBlock(b.id, { ok: false, content: "Interrupted by an error." })) });
      }
    }
    emit(conv.id, { type: "error", message });
    setStatus(conv, "error", message);
  }
  emit(conv.id, { type: "turn_end" });
}

async function callModel(conv: Conversation) {
  let jsonRetries = 0;
  for (;;) {
    const stream = claude().beta.messages.stream({
      ...modelParams,
      max_tokens: 16000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "medium" },
      system: systemPrompt(conv.kind),
      tools: claudeTools().map((t) => ({ ...t, eager_input_streaming: true })),
      messages: conv.messages,
    });
    stream.on("text", (delta) => emit(conv.id, { type: "text", delta }));
    stream.on("thinking", (delta) => emit(conv.id, { type: "thinking", delta }));
    try {
      return await stream.finalMessage();
    } catch (err) {
      // With eager input streaming a tool input can arrive as unparseable JSON; re-issue the turn.
      if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
    }
  }
}

/** Resume a suspended chat turn once all of its pending actions have been decided. */
bus.on("approval_decided", (approval: Approval) => {
  if (!approval.conversationId || !approval.toolUseId) return;
  const conv = store.data.conversations[approval.conversationId];
  if (!conv?.pendingTurn || !(approval.toolUseId in conv.pendingTurn.results)) return;

  conv.pendingTurn.results[approval.toolUseId] = approval.result ?? { ok: false, content: "No result" };
  emit(conv.id, {
    type: "tool_result",
    id: approval.toolUseId,
    state: approval.status === "executed" ? "done" : approval.status === "rejected" ? "denied" : "error",
    approvalId: approval.id,
  });
  const { toolUseIds, results } = conv.pendingTurn;
  if (toolUseIds.some((id) => results[id] === null)) {
    store.save();
    return;
  }
  conv.messages.push({ role: "user", content: toolUseIds.map((id) => toolResultBlock(id, results[id]!)) });
  conv.pendingTurn = null;
  void run(conv);
});

// ───────────── view model for the UI ─────────────

export type ViewItem =
  | { kind: "user"; text: string; images: number }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; state: "running" | "done" | "error" | "pending" | "denied"; result?: unknown; approvalId?: string };

export function conversationView(conv: Conversation) {
  const items: ViewItem[] = [];
  const toolItems = new Map<string, Extract<ViewItem, { kind: "tool" }>>();
  const approvalsByToolUse = new Map(store.data.approvals.filter((a) => a.toolUseId).map((a) => [a.toolUseId!, a]));

  for (const m of conv.messages) {
    const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    if (m.role === "user") {
      const text = blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      const images = blocks.filter((b) => b.type === "image").length;
      if (text || images) items.push({ kind: "user", text, images });
      for (const b of blocks) {
        if (b.type !== "tool_result") continue;
        const item = toolItems.get(b.tool_use_id);
        if (!item) continue;
        const raw = typeof b.content === "string" ? b.content : "";
        let parsed: unknown = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          /* keep raw */
        }
        const p = parsed as { pending_approval?: boolean; declined?: boolean } | null;
        item.result = parsed;
        item.state = p?.pending_approval ? "pending" : p?.declined ? "denied" : b.is_error ? "error" : "done";
      }
    } else {
      for (const b of blocks) {
        if (b.type === "text" && b.text.trim()) items.push({ kind: "assistant", text: b.text });
        if (b.type === "thinking" && b.thinking?.trim()) items.push({ kind: "thinking", text: b.thinking });
        if (b.type === "tool_use") {
          const approval = approvalsByToolUse.get(b.id);
          const item: Extract<ViewItem, { kind: "tool" }> = {
            kind: "tool",
            id: b.id,
            name: b.name,
            input: b.input,
            state: approval?.status === "pending" ? "pending" : "running",
            approvalId: approval?.id,
          };
          toolItems.set(b.id, item);
          items.push(item);
        }
      }
    }
  }
  return {
    id: conv.id,
    title: conv.title,
    kind: conv.kind,
    status: conv.status,
    error: conv.error,
    updatedAt: conv.updatedAt,
    items,
  };
}

// ───────────── daily briefing ─────────────

export function startBriefing() {
  const conv = createConversation("briefing", `Briefing ${new Date().toISOString().slice(0, 10)}`);
  store.data.briefing = { conversationId: conv.id, createdAt: conv.createdAt };
  sendMessage(
    conv,
    `Run today's money briefing.
1. Check the cash summary and every overdue or outstanding invoice.
2. For each overdue invoice, propose a send_reminder whose tone fits how late it is.
3. Propose send_invoice for any draft that looks ready to go.
4. Then write the briefing for the owner (max 120 words): the headline numbers, what you queued for approval, and one useful insight about their clients or cash flow. Use a few bullets.`,
  );
  return conv;
}
