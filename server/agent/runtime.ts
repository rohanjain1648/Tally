import { config } from "../config.js";
import { bus } from "../bus.js";
import { groq, isGroqError, isToolUseFailure, supportsParallelTools, type ChatMessage, type ToolCall } from "../ai/groq.js";
import { newId, store, type Approval, type Conversation, type ToolOutcome } from "../store.js";
import { gate } from "./actions.js";
import { toolSpecs } from "./tools.js";

const MAX_ROUNDS = 12;

export type ConvEvent =
  | { type: "status"; status: Conversation["status"] }
  | { type: "text"; delta: string }
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
- A write tool result is one of: executed (it happened), {"pending_approval": true} (it is queued on an approval card for the owner: tell them it is waiting for their approval and do not retry it), {"declined": true} (the owner said no: respect it and do not retry unless asked), or an error / block (explain plainly).
- Always fill the "reason" field with one short sentence the owner will read on the approval card.

Working style:
- Be concise and concrete. Use invoice numbers, client names and amounts formatted like $1,234.00. Default currency ${config.currency}.
- Look things up before acting on them. Never invent client emails, invoice ids or payment ids; ask if something essential is missing.
- Call tools only through the tool-calling interface. Never write a tool call as text. Pass numbers as numbers.
- To bill someone: create_invoice (draft), then send_invoice (using the id create_invoice returned), unless the owner only asked for a draft.
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

export function sendMessage(conv: Conversation, content: string) {
  if (conv.status === "running") throw new Error("Tally is still working on the previous message.");
  if (conv.status === "awaiting_approval") throw new Error("Approve or reject the pending action first.");
  if (conv.messages.length === 0) conv.title = content.slice(0, 60);
  conv.messages.push({ role: "user", content });
  void run(conv);
}

const toolMessage = (id: string, outcome: ToolOutcome): ChatMessage => ({ role: "tool", tool_call_id: id, content: outcome.content });

/** Models occasionally send arguments that aren't valid JSON; treat that as a tool error, not a crash. */
function parseArgs(raw: string): { ok: true; value: unknown } | { ok: false } {
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/** The agent loop. History is append-only; a suspended turn resumes exactly where it stopped. */
async function run(conv: Conversation) {
  setStatus(conv, "running");
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const turn = await callModel(conv);
      const assistant: ChatMessage = {
        role: "assistant",
        ...(turn.text ? { content: turn.text } : {}),
        ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls } : {}),
      };
      conv.messages.push(assistant);
      store.save();

      if (turn.finish === "length") emit(conv.id, { type: "text", delta: "\n\n(Stopped: response too long.)" });
      if (turn.toolCalls.length === 0) break;

      const results: Record<string, ToolOutcome | null> = {};
      await Promise.all(
        turn.toolCalls.map(async (tc) => {
          const parsed = parseArgs(tc.function.arguments);
          emit(conv.id, { type: "tool_call", id: tc.id, name: tc.function.name, input: parsed.ok ? parsed.value : tc.function.arguments });
          if (!parsed.ok) {
            results[tc.id] = { ok: false, content: JSON.stringify({ error: "Arguments were not valid JSON. Call the tool again with valid JSON arguments." }) };
            emit(conv.id, { type: "tool_result", id: tc.id, state: "error" });
            return;
          }
          const res = await gate(tc.function.name, parsed.value, {
            source: conv.kind === "briefing" ? "briefing" : "agent",
            conversationId: conv.id,
            toolUseId: tc.id,
            proposeOnly: conv.kind === "briefing",
          });
          if (res.status === "pending") {
            results[tc.id] = null;
            emit(conv.id, { type: "tool_result", id: tc.id, state: "pending", approvalId: res.approval.id });
          } else {
            results[tc.id] = res.outcome;
            emit(conv.id, { type: "tool_result", id: tc.id, state: res.status === "denied" ? "denied" : res.outcome.ok ? "done" : "error" });
          }
        }),
      );

      const ids = turn.toolCalls.map((t) => t.id);
      const waiting = ids.filter((id) => results[id] === null);
      if (waiting.length > 0 && conv.kind === "chat") {
        // Suspend: the turn resumes when every pending call has a human decision.
        conv.pendingTurn = { toolUseIds: ids, results };
        setStatus(conv, "awaiting_approval");
        emit(conv.id, { type: "turn_end" });
        return;
      }
      // Briefing proposals don't block: the agent keeps going and the slips wait on Today.
      for (const id of waiting) {
        results[id] = { ok: true, content: JSON.stringify({ pending_approval: true, message: "Queued for the owner's approval." }) };
      }
      for (const id of ids) conv.messages.push(toolMessage(id, results[id]!));
    }
    setStatus(conv, "idle");
  } catch (err) {
    const message = isGroqError(err) ? `Groq API error ${err.status}: ${err.message}` : err instanceof Error ? err.message : String(err);
    console.error("[agent]", message);
    // Keep history valid: every tool call in the last assistant turn needs an answer.
    const answered = new Set(conv.messages.filter((m) => m.role === "tool").map((m) => (m as { tool_call_id: string }).tool_call_id));
    const last = conv.messages.at(-1);
    if (last?.role === "assistant" && last.tool_calls) {
      for (const tc of last.tool_calls) if (!answered.has(tc.id)) conv.messages.push(toolMessage(tc.id, { ok: false, content: "Interrupted by an error." }));
    }
    emit(conv.id, { type: "error", message });
    setStatus(conv, "error", message);
  }
  emit(conv.id, { type: "turn_end" });
}

interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  finish: string | null;
}

const tools = () =>
  toolSpecs().map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }));

async function callModel(conv: Conversation): Promise<ModelTurn> {
  let failures = 0;
  for (;;) {
    try {
      const stream = await groq().chat.completions.create({
        model: config.ai.model,
        messages: [{ role: "system", content: systemPrompt(conv.kind) }, ...conv.messages] as never,
        tools: tools() as never,
        tool_choice: "auto",
        ...(supportsParallelTools(config.ai.model) ? { parallel_tool_calls: true } : {}),
        temperature: 0.2,
        max_completion_tokens: 4096,
        stream: true,
      });

      let text = "";
      let finish: string | null = null;
      const calls = new Map<number, { id: string; name: string; args: string }>();
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          text += choice.delta.content;
          emit(conv.id, { type: "text", delta: choice.delta.content });
        }
        for (const tc of choice.delta?.tool_calls ?? []) {
          const c = calls.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name += tc.function.name;
          if (tc.function?.arguments) c.args += tc.function.arguments;
          calls.set(tc.index, c);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      const toolCalls: ToolCall[] = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .filter(([, c]) => c.name)
        .map(([, c]) => ({ id: c.id || `call_${newId().slice(0, 12)}`, type: "function", function: { name: c.name, arguments: c.args } }));
      return { text, toolCalls, finish };
    } catch (err) {
      // Malformed tool call from the model: ask again rather than failing the owner's request.
      if (isToolUseFailure(err) && failures++ < 2) continue;
      throw err;
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
  for (const id of toolUseIds) conv.messages.push(toolMessage(id, results[id]!));
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
    if (m.role === "user") {
      if (m.content.trim()) items.push({ kind: "user", text: m.content, images: /\[Attached photo/.test(m.content) ? 1 : 0 });
    } else if (m.role === "assistant") {
      if (m.content?.trim()) items.push({ kind: "assistant", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        const parsed = parseArgs(tc.function.arguments);
        const approval = approvalsByToolUse.get(tc.id);
        const item: Extract<ViewItem, { kind: "tool" }> = {
          kind: "tool",
          id: tc.id,
          name: tc.function.name,
          input: parsed.ok ? parsed.value : tc.function.arguments,
          state: approval?.status === "pending" ? "pending" : "running",
          approvalId: approval?.id,
        };
        toolItems.set(tc.id, item);
        items.push(item);
      }
    } else {
      const item = toolItems.get(m.tool_call_id);
      if (!item) continue;
      let parsed: unknown = m.content;
      try {
        parsed = JSON.parse(m.content);
      } catch {
        /* keep raw */
      }
      const p = parsed as { pending_approval?: boolean; declined?: boolean; error?: string } | null;
      item.result = parsed;
      item.state = p?.pending_approval ? "pending" : p?.declined ? "denied" : p?.error ? "error" : "done";
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
