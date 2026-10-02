import { useRef, useState } from "react";
import { FileUp, Loader2, Plus, Trash2, X } from "lucide-react";
import { api, money, readFile, type FilePayload, type Invoice, type InvoiceDraft } from "../api";
import { useLive } from "../live";
import { navigate } from "../App";

const SAMPLES = [
  {
    label: "Client email",
    text: `From: Maya Chen <maya@bloomstudio.example>
Subject: Re: website phase 2

Hi! Loved the homepage. Let's go ahead with phase 2 — the 4 product pages at the $350 each we discussed, plus the 3 hours of copy edits at your $90 rate. Can you invoice Bloom Studio net 30? Thanks!`,
  },
  {
    label: "Job notes",
    text: `Fixed kitchen sink at Dave Morrow's place (dave.morrow@example.com)
- 2.5 hrs labour @ 85/hr
- new P-trap + fittings 46.80
- callout fee 40
he wants it due on receipt. add 8% tax`,
  },
  {
    label: "Deposit request",
    text: `WhatsApp from Priya (priya.r@example.com): "Can we book the full brand package? $2,400 total. Happy to pay 50% upfront to get started next week 🙏"`,
  },
];

type Draft = Omit<InvoiceDraft, "client_email"> & { client_email: string };

export function Capture() {
  const { toast } = useLive();
  const [text, setText] = useState("");
  const [file, setFile] = useState<FilePayload | null>(null);
  const [reading, setReading] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [meta, setMeta] = useState<Pick<InvoiceDraft, "confidence" | "missing" | "summary"> | null>(null);
  const [submitting, setSubmitting] = useState<"send" | "draft" | null>(null);
  const [created, setCreated] = useState<Invoice | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function pick(f: File | undefined) {
    if (!f) return;
    try {
      setFile(await readFile(f));
    } catch (e) {
      toast({ tone: "warning", title: "Couldn't read that file", body: (e as Error).message });
    }
  }

  async function read() {
    setReading(true);
    setCreated(null);
    try {
      const d = await api.post<InvoiceDraft>("/api/capture", { text, file: file ? { mediaType: file.mediaType, base64: file.base64 } : undefined });
      setDraft({ ...d, client_email: d.client_email ?? "" });
      setMeta({ confidence: d.confidence, missing: d.missing, summary: d.summary });
    } catch (e) {
      toast({ tone: "warning", title: "Tally couldn't read that", body: (e as Error).message });
    } finally {
      setReading(false);
    }
  }

  async function submit(send: boolean) {
    if (!draft) return;
    setSubmitting(send ? "send" : "draft");
    try {
      const inv = await api.post<Invoice>("/api/invoices", {
        recipient_name: draft.client_name,
        recipient_email: draft.client_email,
        items: draft.items.map((i) => ({ ...i, description: i.description || undefined })),
        due_in_days: draft.due_in_days,
        tax_percent: draft.tax_percent || undefined,
        note: draft.note || undefined,
        send,
      });
      setCreated(inv);
      setDraft(null);
      setMeta(null);
      setText("");
      setFile(null);
      toast({ tone: "success", title: send ? `Invoice #${inv.number} sent` : `Draft #${inv.number} saved`, body: `${inv.recipient.name}, ${money(inv.total, inv.currency)}` });
    } catch (e) {
      toast({ tone: "warning", title: "PayPal didn't accept the invoice", body: (e as Error).message });
    } finally {
      setSubmitting(null);
    }
  }

  const update = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const updateItem = (idx: number, patch: Partial<Draft["items"][number]>) =>
    setDraft((d) => (d ? { ...d, items: d.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)) } : d));

  const subtotal = draft?.items.reduce((s, i) => s + i.quantity * i.unit_amount, 0) ?? 0;
  const total = subtotal * (1 + (draft?.tax_percent ?? 0) / 100);
  const emailMissing = draft && !/^\S+@\S+\.\S+$/.test(draft.client_email);
  const canSubmit = draft && !emailMissing && draft.client_name.trim() && draft.items.length > 0 && draft.items.every((i) => i.name.trim() && i.quantity > 0);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Capture</h1>
        <p>Snap a job sheet, drop a quote, or paste the client’s message. Tally turns it into a PayPal invoice you check before it goes.</p>
      </header>

      <div className="capture-grid">
        <section className="capture-in" aria-label="Source">
          <div
            className={`drop ${dragging ? "drop-on" : ""} ${file ? "drop-has" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void pick(e.dataTransfer.files[0]);
            }}
          >
            {file ? (
              <div className="drop-file">
                {file.mediaType.startsWith("image/") ? <img src={file.previewUrl} alt="Attached source" /> : <FileUp size={28} />}
                <span>{file.name}</span>
                <button className="icon-btn" onClick={() => setFile(null)} aria-label="Remove file">
                  <X size={16} />
                </button>
              </div>
            ) : (
              <button className="drop-cta" onClick={() => inputRef.current?.click()}>
                <FileUp size={26} />
                <strong>Add a photo or PDF</strong>
                <span>Handwritten job sheets, quotes and receipts all work. Drag it here or tap to choose.</span>
              </button>
            )}
            <input ref={inputRef} type="file" accept="image/*,application/pdf" capture="environment" hidden onChange={(e) => void pick(e.target.files?.[0])} />
          </div>

          <label className="field">
            <span>Or paste a message</span>
            <textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste an email, a text from a client, or your own notes…" />
          </label>
          <div className="samples">
            <span>Try one:</span>
            {SAMPLES.map((s) => (
              <button key={s.label} className="chip" onClick={() => setText(s.text)}>
                {s.label}
              </button>
            ))}
          </div>
          <button className="btn btn-primary btn-wide" onClick={read} disabled={reading || (!text.trim() && !file)}>
            {reading ? (
              <>
                <Loader2 size={16} className="spin" /> Reading…
              </>
            ) : (
              "Read it into an invoice"
            )}
          </button>
        </section>

        <section className="capture-out" aria-label="Invoice draft">
          {created && (
            <div className="done-card">
              <h2>Invoice #{created.number} {created.status === "DRAFT" ? "saved as a draft" : "is on its way"}</h2>
              <p>
                {created.recipient.name} will get a PayPal invoice for <strong>{money(created.total, created.currency)}</strong>, due {created.due_date}.
              </p>
              <div className="row-gap">
                {created.payer_url && (
                  <a className="btn btn-primary" href={created.payer_url} target="_blank" rel="noreferrer">
                    Open the client’s payment page
                  </a>
                )}
                <button className="btn btn-quiet" onClick={() => navigate("invoices")}>
                  See all invoices
                </button>
              </div>
            </div>
          )}

          {!draft && !created && (
            <div className="paper-ghost">
              <p>Your draft appears here, ready to check.</p>
            </div>
          )}

          {draft && meta && (
            <form
              className="paper"
              onSubmit={(e) => {
                e.preventDefault();
                void submit(true);
              }}
            >
              <p className={`confidence confidence-${meta.confidence}`}>
                {meta.summary} <em>{meta.confidence} confidence</em>
              </p>
              {meta.missing.length > 0 && (
                <ul className="missing">
                  {meta.missing.map((m) => (
                    <li key={m}>Check: {m}</li>
                  ))}
                </ul>
              )}

              <div className="two">
                <label className="field">
                  <span>Bill to</span>
                  <input value={draft.client_name} onChange={(e) => update({ client_name: e.target.value })} required />
                </label>
                <label className={`field ${emailMissing ? "field-bad" : ""}`}>
                  <span>Email</span>
                  <input type="email" value={draft.client_email} onChange={(e) => update({ client_email: e.target.value })} placeholder="client@example.com" required />
                  {emailMissing && <small>PayPal needs an email to deliver the invoice.</small>}
                </label>
              </div>

              <table className="items">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Qty</th>
                    <th className="num">Price</th>
                    <th className="num">Amount</th>
                    <th>
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {draft.items.map((it, idx) => (
                    <tr key={idx}>
                      <td>
                        <input aria-label="Item name" value={it.name} onChange={(e) => updateItem(idx, { name: e.target.value })} />
                      </td>
                      <td className="num">
                        <input aria-label="Quantity" type="number" min="0" step="any" value={it.quantity} onChange={(e) => updateItem(idx, { quantity: Number(e.target.value) })} />
                      </td>
                      <td className="num">
                        <input aria-label="Unit price" type="number" min="0" step="0.01" value={it.unit_amount} onChange={(e) => updateItem(idx, { unit_amount: Number(e.target.value) })} />
                      </td>
                      <td className="num">{money(it.quantity * it.unit_amount, draft.currency)}</td>
                      <td>
                        <button type="button" className="icon-btn" aria-label={`Remove ${it.name}`} onClick={() => update({ items: draft.items.filter((_, i) => i !== idx) })}>
                          <Trash2 size={15} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button type="button" className="linkish" onClick={() => update({ items: [...draft.items, { name: "", description: "", quantity: 1, unit_amount: 0 }] })}>
                <Plus size={14} /> Add a line
              </button>

              <div className="three">
                <label className="field">
                  <span>Due in (days)</span>
                  <input type="number" min="0" max="120" value={draft.due_in_days} onChange={(e) => update({ due_in_days: Number(e.target.value) })} />
                </label>
                <label className="field">
                  <span>Tax %</span>
                  <input type="number" min="0" max="30" step="0.01" value={draft.tax_percent} onChange={(e) => update({ tax_percent: Number(e.target.value) })} />
                </label>
                <div className="total">
                  <span>Total</span>
                  <strong>{money(total, draft.currency)}</strong>
                </div>
              </div>
              <label className="field">
                <span>Note to client</span>
                <textarea rows={2} value={draft.note} onChange={(e) => update({ note: e.target.value })} />
              </label>

              <div className="row-gap">
                <button className="btn btn-primary" type="submit" disabled={!canSubmit || !!submitting}>
                  {submitting === "send" ? "Sending through PayPal…" : `Send ${money(total, draft.currency)} invoice`}
                </button>
                <button className="btn btn-quiet" type="button" disabled={!canSubmit || !!submitting} onClick={() => void submit(false)}>
                  {submitting === "draft" ? "Saving…" : "Save as draft"}
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
