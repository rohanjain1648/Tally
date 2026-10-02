import { useEffect, useState } from "react";
import { api, money, type Policy, type RuleMode } from "../api";
import { useLive } from "../live";

const ACTIONS: { id: string; label: string; help: string }[] = [
  { id: "create_invoice", label: "Draft an invoice", help: "Nothing is sent; it just appears in your drafts." },
  { id: "send_invoice", label: "Send an invoice", help: "Emails the client a PayPal invoice." },
  { id: "send_reminder", label: "Send a payment reminder", help: "A nudge on an invoice that’s already out." },
  { id: "create_payment_link", label: "Create a payment link", help: "A one-off PayPal checkout for deposits or quick sales." },
  { id: "record_offline_payment", label: "Mark an invoice paid", help: "For cash or bank transfers outside PayPal." },
  { id: "cancel_invoice", label: "Cancel an invoice", help: "The client is told it no longer needs paying." },
  { id: "refund_payment", label: "Refund a payment", help: "Money goes back out of your PayPal balance." },
  { id: "create_retainer", label: "Set up a retainer", help: "Recurring PayPal subscription billing for a client." },
];

const MODES: { id: RuleMode; label: string }[] = [
  { id: "auto", label: "Within limits" },
  { id: "ask", label: "Always ask" },
  { id: "block", label: "Never" },
];

export function Guardrails() {
  const { toast } = useLive();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<{ policy: Policy }>("/api/policy").then((r) => {
      setPolicy(r.policy);
      setSaved(JSON.stringify(r.policy));
    });
  }, []);

  if (!policy) return <div className="page" />;
  const dirty = JSON.stringify(policy) !== saved;
  const set = (patch: Partial<Policy>) => setPolicy({ ...policy, ...patch });

  async function save() {
    setSaving(true);
    try {
      const p = await api.put<Policy>("/api/policy", policy);
      setPolicy(p);
      setSaved(JSON.stringify(p));
      toast({ tone: "success", title: "Guardrails saved", body: "Tally will follow these from its next action." });
    } catch (e) {
      toast({ tone: "warning", title: "Couldn't save", body: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <h1>Guardrails</h1>
        <p>
          These rules sit between Tally and your money. They’re enforced in code on every action, so the AI can’t talk its way past
          them. Lookups always run; anything that sends, charges or refunds is checked here first.
        </p>
      </header>

      <section className="rules-sentence" aria-label="Limits">
        <p>
          Tally may act on its own for amounts up to{" "}
          <label className="inline-num">
            <span className="sr-only">Auto-approve limit</span>$
            <input type="number" min="0" step="10" value={policy.autoApproveLimit} onChange={(e) => set({ autoApproveLimit: Number(e.target.value) })} />
          </label>{" "}
          each, and no more than{" "}
          <label className="inline-num">
            <span className="sr-only">Daily autopilot cap</span>$
            <input type="number" min="0" step="50" value={policy.dailyAutoLimit} onChange={(e) => set({ dailyAutoLimit: Number(e.target.value) })} />
          </label>{" "}
          in total per day. Anything bigger comes to you as a slip.
        </p>
        <label className="toggle">
          <input type="checkbox" checked={policy.requireApprovalForNewClients} onChange={(e) => set({ requireApprovalForNewClients: e.target.checked })} />
          <span>Ask me before Tally contacts or bills someone for the first time</span>
        </label>
      </section>

      <section aria-labelledby="per-action">
        <h2 id="per-action">Action by action</h2>
        <ul className="rules">
          {ACTIONS.map((a) => (
            <li key={a.id}>
              <div>
                <strong>{a.label}</strong>
                <small>{a.help}</small>
              </div>
              <div className="segmented" role="radiogroup" aria-label={a.label}>
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    role="radio"
                    aria-checked={policy.rules[a.id] === m.id}
                    className={`seg-${m.id}`}
                    onClick={() => set({ rules: { ...policy.rules, [a.id]: m.id } })}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <div className="savebar" data-visible={dirty}>
        <span>
          Auto-approve up to {money(policy.autoApproveLimit)} each, {money(policy.dailyAutoLimit)} a day.
        </span>
        <button className="btn btn-primary" onClick={save} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save guardrails"}
        </button>
      </div>
    </div>
  );
}
