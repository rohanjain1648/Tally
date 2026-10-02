import { useState, type ReactNode } from "react";
import { Check, X } from "lucide-react";
import { api, money, timeAgo, type Approval } from "./api";
import { useLive } from "./live";

/** The tally-mark logo: four strokes and a gate. */
export function TallyMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
        <path d="M8 7v18M13 7v18M18 7v18M23 7v18" />
        <path d="M5 21 27 11" stroke="var(--slip-ink)" />
      </g>
    </svg>
  );
}

const TOOL_LABEL: Record<string, string> = {
  create_invoice: "Draft invoice",
  send_invoice: "Send invoice",
  send_reminder: "Payment reminder",
  cancel_invoice: "Cancel invoice",
  record_offline_payment: "Record payment",
  create_payment_link: "Payment link",
  refund_payment: "Refund",
  create_retainer: "Retainer",
  get_cash_summary: "Checked cash position",
  list_invoices: "Looked up invoices",
  get_invoice: "Opened invoice",
  list_clients: "Reviewed clients",
  list_transactions: "Read PayPal transactions",
  list_payment_links: "Checked payment links",
};
export const toolLabel = (name: string) => TOOL_LABEL[name] ?? name;

/** Pretty-print the parameters the agent wants to use, minus the rationale (shown separately). */
function Params({ input }: { input: Record<string, unknown> }) {
  const entries = Object.entries(input).filter(([k]) => k !== "reason");
  return (
    <dl className="slip-params">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{k.replace(/_/g, " ")}</dt>
          <dd>
            {Array.isArray(v)
              ? v.map((it, i) => (
                  <div key={i}>
                    {typeof it === "object" && it
                      ? `${(it as { quantity?: number }).quantity ?? 1} × ${(it as { name?: string }).name} @ ${money((it as { unit_amount?: number }).unit_amount)}`
                      : String(it)}
                  </div>
                ))
              : typeof v === "object"
                ? JSON.stringify(v)
                : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The approval slip — Tally's signature element. Styled like the yellow carbon copy torn from an invoice
 * pad: the agent's proposal on top, the policy's reasons below, and the owner's stamp at the bottom.
 */
export function ApprovalSlip({ approval, compact = false, onDecided }: { approval: Approval; compact?: boolean; onDecided?: (a: Approval) => void }) {
  const { toast, bump } = useLive();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [showParams, setShowParams] = useState(!compact);
  // Our own decision wins over the (possibly stale) prop until the parent refetches.
  const [decided, setCurrent] = useState<Approval | null>(null);
  const a = decided?.id === approval.id ? decided : approval;

  async function decide(approve: boolean) {
    setBusy(approve ? "approve" : "reject");
    try {
      const res = await api.post<Approval>(`/api/approvals/${a.id}`, { approve });
      setCurrent(res);
      onDecided?.(res);
      bump("approvals");
      if (res.status === "failed") toast({ tone: "warning", title: "PayPal returned an error", body: errorText(res) });
      else toast({ tone: approve ? "success" : "info", title: approve ? "Approved and done" : "Rejected", body: a.summary });
    } catch (err) {
      toast({ tone: "warning", title: "Couldn't record your decision", body: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const stamped = a.status !== "pending";
  return (
    <article className={`slip ${stamped ? `slip-${a.status}` : ""}`} aria-label={`Approval: ${a.summary}`}>
      <header className="slip-head">
        <span className="slip-kind">{toolLabel(a.tool)}</span>
        {a.amount != null && a.tool !== "create_invoice" && <span className="slip-amount">{money(a.amount, a.currency)}</span>}
      </header>
      <p className="slip-summary">{a.summary}</p>
      {a.reason && (
        <p className="slip-reason">
          <span>Tally’s reason</span> {a.reason}
        </p>
      )}
      <ul className="slip-policy">
        {a.policyReasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {compact && (
        <button className="linkish" onClick={() => setShowParams((s) => !s)} aria-expanded={showParams}>
          {showParams ? "Hide details" : "Show exact details"}
        </button>
      )}
      {showParams && <Params input={a.input} />}
      <footer className="slip-foot">
        {stamped ? (
          <span className={`stamp stamp-${a.status}`}>{STAMP[a.status]}</span>
        ) : (
          <>
            <button className="btn btn-approve" disabled={!!busy} onClick={() => decide(true)}>
              <Check size={16} /> {busy === "approve" ? "Working…" : "Approve"}
            </button>
            <button className="btn btn-ghost" disabled={!!busy} onClick={() => decide(false)}>
              <X size={16} /> Reject
            </button>
          </>
        )}
        <span className="slip-meta">
          {SOURCE[a.source]}, {timeAgo(a.createdAt)}
        </span>
      </footer>
      {a.status === "failed" && <p className="slip-error">{errorText(a)}</p>}
    </article>
  );
}

const STAMP: Record<Approval["status"], string> = {
  pending: "",
  approved: "Approved",
  executed: "Approved · done",
  rejected: "Rejected",
  failed: "Failed",
};
const SOURCE: Record<Approval["source"], string> = {
  agent: "Asked in chat",
  briefing: "From your briefing",
  human: "You",
  webhook: "PayPal",
  mcp: "External agent",
};

function errorText(a: Approval) {
  try {
    return JSON.parse(a.result?.content ?? "{}").error ?? "Unknown error";
  } catch {
    return a.result?.content ?? "Unknown error";
  }
}

export function StatusPill({ status }: { status: string }) {
  const label = status.replace(/_/g, " ").toLowerCase();
  return <span className={`pill pill-${status.toLowerCase()}`}>{label}</span>;
}

/** Minimal, safe markdown: paragraphs, bullets, **bold**, *italic*, `code`. */
export function Markdown({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="md">
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
          const ordered = /^\s*\d+\./.test(lines[0]);
          const items = lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ""))}</li>);
          return ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
        }
        const heading = /^#{1,4}\s+(.*)/.exec(lines[0]);
        if (heading && lines.length === 1) return <h4 key={i}>{inline(heading[1])}</h4>;
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <span key={j}>
                {inline(l.replace(/^#{1,4}\s+/, ""))}
                {j < lines.length - 1 && <br />}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={m.index}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={m.index}>{t.slice(1, -1)}</code>);
    else out.push(<em key={m.index}>{t.slice(1, -1)}</em>);
    last = m.index! + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <TallyMark size={36} />
      <h3>{title}</h3>
      {children}
    </div>
  );
}
