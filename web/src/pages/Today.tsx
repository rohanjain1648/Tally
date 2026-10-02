import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, money, shortDate, type Approval, type Dashboard } from "../api";
import { ApprovalSlip, EmptyState, Markdown } from "../components";
import { useLive } from "../live";
import { Thread } from "../Thread";
import { useConversation } from "../useConversation";
import { navigate } from "../App";

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

export function Today() {
  const { versions, toast } = useLive();
  const [data, setData] = useState<Dashboard | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  // Decided slips stay visible for a moment so the owner sees the stamp land.
  const [kept, setKept] = useState<Record<string, Approval>>({});
  const [error, setError] = useState<string | null>(null);
  const [briefingId, setBriefingId] = useState<string | undefined>();
  const briefing = useConversation(briefingId);

  useEffect(() => {
    api
      .get<Dashboard>("/api/dashboard")
      .then((d) => {
        setData(d);
        setError(null);
        if (d.briefing) setBriefingId(d.briefing.id);
      })
      .catch((e) => setError(e.message));
  }, [versions.invoices, versions.approvals]);

  useEffect(() => {
    api.get<Approval[]>("/api/approvals").then(setApprovals).catch(() => {});
  }, [versions.approvals]);

  const keep = (a: Approval) => {
    setKept((k) => ({ ...k, [a.id]: a }));
    setTimeout(() => setKept((k) => Object.fromEntries(Object.entries(k).filter(([id]) => id !== a.id))), 3500);
  };
  const slips = [...approvals.filter((a) => !(a.id in kept)), ...Object.values(kept)].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const waiting = approvals.length;

  async function runBriefing() {
    try {
      const view = await api.post<{ id: string }>("/api/briefing");
      setBriefingId(view.id);
    } catch (e) {
      toast({ tone: "warning", title: "Couldn't start the briefing", body: (e as Error).message });
    }
  }

  const [mockMode, setMockMode] = useState(false);
  useEffect(() => {
    api.get<{ paypalMode: string }>("/api/status").then((s) => setMockMode(s.paypalMode === "mock")).catch(() => {});
  }, []);
  async function queueDemo() {
    try {
      await api.post("/api/demo/propose");
    } catch (e) {
      toast({ tone: "warning", title: "Couldn't queue proposals", body: (e as Error).message });
    }
  }

  const s = data?.summary;
  const cur = s?.currency ?? "USD";
  const running = briefing.view?.status === "running";
  const lastNote = [...briefing.items].reverse().find((i) => i.kind === "assistant");

  return (
    <div className="page">
      <header className="page-head">
        <h1>{greeting()}</h1>
        <p>{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</p>
      </header>

      {error && <div className="banner banner-warn">Couldn’t load your PayPal data: {error}</div>}

      <section className="ledger" aria-label="Cash position">
        <div>
          <span className="ledger-label">Owed to you</span>
          <span className="figure">{s ? money(s.outstanding_total, cur) : "—"}</span>
          <span className="ledger-note">{s ? `${s.outstanding_count} open invoice${s.outstanding_count === 1 ? "" : "s"}` : ""}</span>
        </div>
        <div className={s && s.overdue_count > 0 ? "is-late" : ""}>
          <span className="ledger-label">Overdue</span>
          <span className="figure">{s ? money(s.overdue_total, cur) : "—"}</span>
          <span className="ledger-note">{s ? (s.overdue_count ? `${s.overdue_count} past due` : "Nobody’s late") : ""}</span>
        </div>
        <div>
          <span className="ledger-label">Collected in the last 30 days</span>
          <span className="figure">{s ? money(s.collected_last_30_days, cur) : "—"}</span>
          <span className="ledger-note">{s ? `${s.drafts} draft${s.drafts === 1 ? "" : "s"} not sent yet` : ""}</span>
        </div>
      </section>

      <div className="today-grid">
        <section className="note" aria-labelledby="briefing-h">
          <div className="note-head">
            <h2 id="briefing-h">Today’s briefing</h2>
            <button className="btn btn-quiet" onClick={runBriefing} disabled={running}>
              <RefreshCw size={15} className={running ? "spin" : ""} /> {running ? "Reviewing your books…" : briefingId ? "Refresh" : "Write my briefing"}
            </button>
          </div>
          {!briefingId && (
            <p className="muted">
              Tally reads your PayPal invoices and payments, works out who to chase, and drafts every reminder for you to approve.
              Nothing gets sent until you say so.
            </p>
          )}
          {briefingId && running && (
            <Thread
              items={briefing.items.filter((i) => i.kind === "tool")}
              liveText={briefing.liveText}
              liveThinking={briefing.liveThinking}
              running
            />
          )}
          {briefingId && !running && lastNote?.kind === "assistant" && <BriefingNote text={lastNote.text} />}
          {briefing.view?.status === "error" && <p className="error-text">{briefing.view.error}</p>}
        </section>

        <section className="queue" aria-labelledby="queue-h">
          <h2 id="queue-h">
            Waiting for your OK {waiting > 0 && <span className="count-lg">{waiting}</span>}
          </h2>
          {slips.length === 0 ? (
            <EmptyState title="Nothing needs you right now">
              <p>When Tally wants to send, refund or charge something above your limits, it lands here.</p>
              {mockMode && (
                <button className="btn btn-quiet" style={{ marginTop: 12 }} onClick={queueDemo}>
                  Queue two sample proposals
                </button>
              )}
            </EmptyState>
          ) : (
            <div className="slips">
              {slips.map((a) => (
                <ApprovalSlip key={a.id} approval={a} compact onDecided={keep} />
              ))}
            </div>
          )}
        </section>
      </div>

      <section aria-labelledby="owes-h">
        <h2 id="owes-h">Who owes you</h2>
        {data && data.clients.filter((c) => c.outstanding > 0).length === 0 && <p className="muted">Everyone’s paid up.</p>}
        <table className="rows">
          <tbody>
            {data?.clients
              .filter((c) => c.outstanding > 0)
              .map((c) => (
                <tr key={c.email}>
                  <th scope="row">
                    {c.name}
                    <small>Last invoiced {shortDate(c.last_invoice)}</small>
                  </th>
                  <td className="num">{money(c.outstanding, cur)}</td>
                  <td>{c.overdue > 0 ? <span className="pill pill-overdue">{money(c.overdue, cur)} overdue</span> : <span className="pill pill-sent">on time</span>}</td>
                  <td className="row-action">
                    <button
                      className="btn btn-quiet"
                      onClick={() => {
                        sessionStorage.setItem("tally:prefill", `Chase ${c.name} about what they owe. Check their open invoices first.`);
                        navigate("agent");
                      }}
                    >
                      Ask Tally to chase
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function BriefingNote({ text }: { text: string }) {
  return (
    <div className="note-body">
      <Markdown text={text} />
    </div>
  );
}
