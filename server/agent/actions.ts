import { paypal } from "../paypal/index.js";
import { autoApprovedToday, isKnownClient } from "../books.js";
import { evaluatePolicy } from "../policy.js";
import { newId, store, type ActionSource, type Approval, type ToolOutcome } from "../store.js";
import { bus, emitUi } from "../bus.js";
import { toolByName, type WriteToolDef } from "./tools.js";

export type GateResult =
  | { status: "done"; outcome: ToolOutcome }
  | { status: "pending"; approval: Approval }
  | { status: "denied"; outcome: ToolOutcome };

const errorOutcome = (msg: string): ToolOutcome => ({ ok: false, content: JSON.stringify({ error: msg }) });
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function execute(tool: WriteToolDef, input: unknown, source: ActionSource, summary: string): Promise<ToolOutcome> {
  try {
    const outcome = await tool.run(input as never);
    store.audit({ source, kind: "tool", tool: tool.name, summary, detail: JSON.parse(outcome.content), ok: true });
    emitUi({ type: "invoices_changed" });
    return outcome;
  } catch (err) {
    store.audit({ source, kind: "tool", tool: tool.name, summary: `Failed: ${summary}`, detail: { error: errMsg(err) }, ok: false });
    return errorOutcome(errMsg(err));
  } finally {
    emitUi({ type: "audit_changed" });
  }
}

/**
 * The single choke point for every tool call, whoever makes it (agent, briefing, MCP client).
 * Reads run immediately. Writes are validated, priced, checked against policy, and then
 * either executed, queued for approval, or denied.
 */
export async function gate(
  name: string,
  rawInput: unknown,
  opts: { source: ActionSource; conversationId?: string | null; toolUseId?: string | null; proposeOnly?: boolean },
): Promise<GateResult> {
  const tool = toolByName.get(name);
  if (!tool) return { status: "done", outcome: errorOutcome(`Unknown tool ${name}`) };

  const parsed = tool.schema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { status: "done", outcome: errorOutcome(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`) };
  }

  if (tool.kind === "read") {
    try {
      return { status: "done", outcome: await tool.run(parsed.data) };
    } catch (err) {
      return { status: "done", outcome: errorOutcome(errMsg(err)) };
    }
  }

  let info;
  try {
    info = await tool.describe(parsed.data);
  } catch (err) {
    return { status: "done", outcome: errorOutcome(errMsg(err)) };
  }

  const invoices = await paypal.listInvoices().catch(() => []);
  const decision = evaluatePolicy(store.data.policy, {
    tool: tool.name,
    amount: info.amount,
    recipientEmail: info.recipientEmail,
    knownClient: isKnownClient(invoices, info.recipientEmail),
    autoApprovedToday: autoApprovedToday(),
    proposeOnly: opts.proposeOnly,
  });
  const reason = String((parsed.data as { reason?: string }).reason ?? "");
  store.audit({
    source: opts.source,
    kind: "policy",
    tool: tool.name,
    decision: decision.decision,
    summary: `${decision.decision === "allow" ? "Auto-approved" : decision.decision === "ask" ? "Needs approval" : "Blocked"}: ${info.summary}`,
    detail: { amount: tool.name === "create_invoice" ? 0 : info.amount, reasons: decision.reasons, reason },
  });
  emitUi({ type: "audit_changed" });

  if (decision.decision === "deny") {
    return { status: "denied", outcome: errorOutcome(`Blocked by the owner's guardrails: ${decision.reasons.join(" ")}`) };
  }
  if (decision.decision === "allow") {
    return { status: "done", outcome: await execute(tool, parsed.data, opts.source, info.summary) };
  }

  const approval: Approval = {
    id: newId(),
    conversationId: opts.conversationId ?? null,
    toolUseId: opts.toolUseId ?? null,
    tool: tool.name,
    input: parsed.data as Record<string, unknown>,
    summary: info.summary,
    reason,
    amount: info.amount,
    currency: info.currency,
    policyReasons: decision.reasons,
    source: opts.source,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  store.data.approvals.unshift(approval);
  store.save();
  emitUi({ type: "approvals_changed" });
  return { status: "pending", approval };
}

/** A human approves or rejects a queued action. Resuming the agent is handled by the runtime via the bus. */
export async function decide(approvalId: string, approve: boolean, note?: string): Promise<Approval> {
  const approval = store.data.approvals.find((a) => a.id === approvalId);
  if (!approval) throw new Error("Approval not found");
  if (approval.status !== "pending") throw new Error(`Already ${approval.status}`);

  approval.decidedAt = new Date().toISOString();
  if (approve) {
    approval.status = "approved";
    store.audit({ source: "human", kind: "approval", tool: approval.tool, decision: "approved", summary: `Approved: ${approval.summary}` });
    const tool = toolByName.get(approval.tool) as WriteToolDef;
    approval.result = await execute(tool, approval.input, approval.source, approval.summary);
    approval.status = approval.result.ok ? "executed" : "failed";
  } else {
    approval.status = "rejected";
    approval.result = {
      ok: false,
      content: JSON.stringify({ declined: true, message: `The owner declined this action.${note ? ` Their note: ${note}` : ""}` }),
    };
    store.audit({
      source: "human",
      kind: "approval",
      tool: approval.tool,
      decision: "rejected",
      summary: `Rejected: ${approval.summary}`,
      detail: note ? { note } : undefined,
    });
  }
  store.save();
  emitUi({ type: "approvals_changed" });
  emitUi({ type: "audit_changed" });
  bus.emit("approval_decided", approval);
  return approval;
}

/** Direct human action from the UI (e.g. the Capture review screen). The human is the approver. */
export async function runAsHuman(name: string, input: unknown): Promise<ToolOutcome> {
  const tool = toolByName.get(name);
  if (!tool || tool.kind !== "write") return errorOutcome(`Unknown action ${name}`);
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) return errorOutcome(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const info = await tool.describe(parsed.data);
  return execute(tool, parsed.data, "human", info.summary);
}
