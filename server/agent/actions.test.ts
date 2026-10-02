import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Isolated mock-mode store for this test file (must be set before modules load).
process.env.PAYPAL_MODE = "mock";
process.env.DATA_FILE = path.join(os.tmpdir(), `tally-test-${process.pid}-${Date.now()}.json`);

let gate: typeof import("./actions.js").gate;
let decide: typeof import("./actions.js").decide;
let paypal: typeof import("../paypal/index.js").paypal;
let store: typeof import("../store.js").store;

beforeAll(async () => {
  ({ gate, decide } = await import("./actions.js"));
  ({ paypal } = await import("../paypal/index.js"));
  ({ store } = await import("../store.js"));
});

const opts = { source: "agent" as const, conversationId: null, toolUseId: null };

describe("gate", () => {
  it("runs read tools immediately", async () => {
    const res = await gate("get_cash_summary", {}, opts);
    expect(res.status).toBe("done");
    if (res.status === "done") expect(JSON.parse(res.outcome.content).overdue_count).toBeGreaterThan(0);
  });

  it("rejects invalid input without touching PayPal", async () => {
    const res = await gate("create_invoice", { recipient_name: "x", recipient_email: "not-an-email", items: [], reason: "test" }, opts);
    expect(res.status).toBe("done");
    if (res.status === "done") expect(res.outcome.ok).toBe(false);
  });

  it("auto-runs a small reminder to a known client", async () => {
    const overdue = (await paypal.listInvoices()).find((i) => i.recipient.name === "Acme Coffee Roasters" && i.status === "SENT")!;
    const res = await gate(
      "send_reminder",
      { invoice_id: overdue.id, subject: "Friendly reminder", message: "Hi! Just a reminder that this invoice is due.", reason: "It is overdue" },
      opts,
    );
    // $680 is above the default $250 limit, so this one must ask.
    expect(res.status).toBe("pending");
  });

  it("queues a refund for approval, then executes it once approved", async () => {
    const tx = (await paypal.listTransactions(31)).find((t) => t.counterparty === "Sam Patel")!;
    const res = await gate("refund_payment", { payment_id: tx.id, amount: 80, reason: "Partial refund for a reshoot" }, opts);
    expect(res.status).toBe("pending");
    if (res.status !== "pending") return;
    expect(res.approval.policyReasons.join(" ")).toMatch(/always ask/);

    const decided = await decide(res.approval.id, true);
    expect(decided.status).toBe("executed");
    const refunds = (await paypal.listTransactions(1)).filter((t) => t.amount === -80);
    expect(refunds).toHaveLength(1);
  });

  it("returns a declined result when the owner rejects", async () => {
    const res = await gate("create_payment_link", { amount: 900, description: "Deposit for website", reason: "Deposit" }, opts);
    expect(res.status).toBe("pending");
    if (res.status !== "pending") return;
    const decided = await decide(res.approval.id, false, "Not yet");
    expect(decided.status).toBe("rejected");
    expect(JSON.parse(decided.result!.content).declined).toBe(true);
    expect(store.data.paymentLinks).toHaveLength(0);
  });

  it("denies blocked tools", async () => {
    store.data.policy.rules.cancel_invoice = "block";
    const inv = (await paypal.listInvoices()).find((i) => i.status === "DRAFT")!;
    const res = await gate("cancel_invoice", { invoice_id: inv.id, reason: "Duplicate" }, opts);
    expect(res.status).toBe("denied");
  });
});
