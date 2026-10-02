import { useEffect, useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ICellRendererParams } from "ag-grid-community";
import { ExternalLink, Search } from "lucide-react";
import { api, money, shortDate, type Invoice, type Status, type Transaction } from "../api";
import { StatusPill } from "../components";
import { useLive } from "../live";
import { navigate } from "../App";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  fontFamily: "var(--font-body)",
  headerFontFamily: "var(--font-figures)",
  headerFontSize: 14,
  fontSize: 14,
  backgroundColor: "var(--surface)",
  foregroundColor: "var(--ink)",
  headerBackgroundColor: "var(--paper)",
  borderColor: "var(--line)",
  rowHoverColor: "var(--hover)",
  accentColor: "var(--carbon)",
  oddRowBackgroundColor: "var(--surface)",
  wrapperBorderRadius: 10,
  rowHeight: 48,
  headerHeight: 44,
});

type Tab = "invoices" | "payments";

export function Invoices({ status }: { status: Status | null }) {
  const { versions, toast } = useLive();
  const [tab, setTab] = useState<Tab>("invoices");
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [txns, setTxns] = useState<Transaction[] | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Invoice[]>("/api/invoices").then(setInvoices).catch((e) => setError(e.message));
    api.get<Transaction[]>("/api/transactions?days=31").then(setTxns).catch(() => setTxns([]));
  }, [versions.invoices]);

  async function sendDraft(inv: Invoice) {
    try {
      await api.post(`/api/invoices/${inv.id}/send`);
      toast({ tone: "success", title: `Invoice #${inv.number} sent`, body: inv.recipient.name });
    } catch (e) {
      toast({ tone: "warning", title: "Couldn't send", body: (e as Error).message });
    }
  }

  const invoiceCols = useMemo<ColDef<Invoice>[]>(
    () => [
      { headerName: "#", field: "number", width: 80, minWidth: 80, sort: "desc", comparator: (a, b) => Number(a) - Number(b) },
      { headerName: "Client", valueGetter: (p) => p.data?.recipient.name, flex: 1.4, minWidth: 140 },
      {
        headerName: "Status",
        field: "display_status",
        width: 140,
        minWidth: 140,
        cellRenderer: (p: ICellRendererParams<Invoice>) => <StatusPill status={p.value} />,
      },
      { headerName: "Total", field: "total", width: 120, minWidth: 120, type: "rightAligned", valueFormatter: (p) => money(p.value, p.data?.currency) },
      {
        headerName: "Still owed",
        field: "amount_due",
        width: 125,
        minWidth: 125,
        type: "rightAligned",
        valueFormatter: (p) => (p.value > 0 ? money(p.value, p.data?.currency) : "—"),
        cellClassRules: { "cell-late": (p) => !!p.data?.overdue },
      },
      {
        headerName: "Due",
        field: "due_date",
        width: 175,
        minWidth: 175,
        valueFormatter: (p) => (p.data?.overdue ? `${shortDate(p.value)} (${p.data.days_overdue}d late)` : shortDate(p.value)),
        cellClassRules: { "cell-late": (p) => !!p.data?.overdue },
      },
      {
        headerName: "",
        colId: "actions",
        width: 250,
        minWidth: 250,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<Invoice>) => {
          const inv = p.data!;
          return (
            <div className="grid-actions">
              {inv.status === "DRAFT" && (
                <button className="btn btn-small" onClick={() => void sendDraft(inv)}>
                  Send
                </button>
              )}
              {inv.overdue && (
                <button
                  className="btn btn-small btn-quiet"
                  onClick={() => {
                    sessionStorage.setItem("tally:prefill", `Send a reminder for invoice #${inv.number} to ${inv.recipient.name}.`);
                    navigate("agent");
                  }}
                >
                  Chase
                </button>
              )}
              {inv.payer_url && inv.status !== "DRAFT" && (
                <a className="btn btn-small btn-quiet" href={inv.payer_url} target="_blank" rel="noreferrer">
                  Pay page <ExternalLink size={13} />
                </a>
              )}
            </div>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const txCols = useMemo<ColDef<Transaction>[]>(
    () => [
      { headerName: "Date", field: "date", width: 130, sort: "desc", valueFormatter: (p) => shortDate(p.value) },
      { headerName: "From / to", field: "counterparty", flex: 1, minWidth: 160 },
      { headerName: "Note", field: "note", flex: 1.3, minWidth: 180 },
      {
        headerName: "Amount",
        field: "amount",
        width: 130,
        type: "rightAligned",
        valueFormatter: (p) => money(p.value, p.data?.currency),
        cellClassRules: { "cell-out": (p) => (p.value ?? 0) < 0 },
      },
      { headerName: "Status", field: "status", width: 130, cellRenderer: (p: ICellRendererParams<Transaction>) => <StatusPill status={p.value ?? ""} /> },
      { headerName: "PayPal id", field: "id", width: 200, cellClass: "cell-id" },
    ],
    [],
  );

  return (
    <div className="page page-wide">
      <header className="page-head page-head-row">
        <div>
          <h1>Invoices &amp; payments</h1>
          <p>Live from your PayPal {status?.paypalMode === "sandbox" ? "sandbox" : "simulator"} account.</p>
        </div>
        <label className="search">
          <Search size={16} aria-hidden="true" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by client, number, status…" aria-label="Filter" />
        </label>
      </header>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "invoices"} onClick={() => setTab("invoices")}>
          Invoices {invoices && <span>{invoices.length}</span>}
        </button>
        <button role="tab" aria-selected={tab === "payments"} onClick={() => setTab("payments")}>
          Payments {txns && <span>{txns.length}</span>}
        </button>
      </div>

      {error && <div className="banner banner-warn">{error}</div>}
      {tab === "payments" && status?.paypalMode === "sandbox" && (
        <p className="muted small">PayPal’s transaction search can take up to three hours to show new sandbox payments.</p>
      )}

      <div className="grid-wrap">
        {tab === "invoices" ? (
          <AgGridReact<Invoice> theme={theme} rowData={invoices} columnDefs={invoiceCols} quickFilterText={filter} getRowId={(p) => p.data.id} autoSizeStrategy={{ type: "fitGridWidth" }} suppressCellFocus />
        ) : (
          <AgGridReact<Transaction> theme={theme} rowData={txns} columnDefs={txCols} quickFilterText={filter} getRowId={(p) => p.data.id} autoSizeStrategy={{ type: "fitGridWidth" }} suppressCellFocus />
        )}
      </div>
    </div>
  );
}
