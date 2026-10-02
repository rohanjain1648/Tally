// Scripted stand-in for Groq's OpenAI-compatible chat completions API, for trying Tally's agent loop offline.
//   npm run mock:groq                                                  (terminal 1, listens on :8899)
//   GROQ_API_KEY=test GROQ_BASE_URL=http://localhost:8899 npm start    (terminal 2)
// Then ask: "Refund Sam $80". It looks up transactions, asks to refund, and waits for your approval.
// Say "flaky" in the message to see a malformed tool call get retried.
import http from "node:http";

const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const toolCalls = (calls) => chunk({ role: "assistant", tool_calls: calls.map((c, i) => ({ index: i, id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }) + chunk({}, "tool_calls") + "data: [DONE]\n\n";
const textTurn = (t) => chunk({ role: "assistant", content: t.slice(0, 12) }) + chunk({ content: t.slice(12) }) + chunk({}, "stop") + "data: [DONE]\n\n";
const completion = (content) => JSON.stringify({ id: "c", object: "chat.completion", created: 0, model: "mock", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });

let flakyUsed = false;
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const data = body ? JSON.parse(body) : {};
    const msgs = data.messages ?? [];
    const last = msgs.at(-1);
    const firstUser = msgs.find((m) => m.role === "user");
    const hasImage = Array.isArray(last?.content) && last.content.some((p) => p.type === "image_url");
    console.log(`[mock] ${req.url} model=${data.model} stream=${!!data.stream} msgs=${msgs.length} tools=${data.tools?.length ?? 0} rf=${data.response_format?.type ?? "-"} parallel=${data.parallel_tool_calls} img=${hasImage}`);

    // Capture / extraction (structured output, non-streaming)
    if (data.response_format) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(completion(JSON.stringify({
        client_name: "Bloom Studio", client_email: "hello@bloomstudio.example",
        items: [{ name: "Product pages", description: "4 pages", quantity: 4, unit_amount: 350 }, { name: "Copy edits", description: "", quantity: 3, unit_amount: 90 }],
        currency: "USD", due_in_days: 30, tax_percent: 0, note: "Thanks!", confidence: "high", missing: [], summary: "Phase 2 for Bloom Studio.",
      })));
    }
    // Attachment transcription (non-streaming vision call)
    if (!data.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(completion("Job sheet: Dave Morrow, 2.5 hrs labour at 85/hr, P-trap 46.80"));
    }

    const text = typeof firstUser?.content === "string" ? firstUser.content : "";
    if (text.includes("flaky") && !flakyUsed) {
      flakyUsed = true;
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "Failed to call a function. Please adjust your prompt.", type: "invalid_request_error", code: "tool_use_failed", failed_generation: "<function=oops>" } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const trailingTools = [];
    for (let i = msgs.length - 1; i >= 0 && msgs[i].role === "tool"; i--) trailingTools.push(msgs[i]);

    if (!trailingTools.length) return res.end(toolCalls([
      { id: "call_a", name: "list_transactions", args: { days: 30 } },
      { id: "call_c", name: "get_cash_summary", args: {} },
    ]));
    if (trailingTools.some((t) => t.tool_call_id === "call_a")) {
      const txs = JSON.parse(trailingTools.find((t) => t.tool_call_id === "call_a").content);
      const sam = txs.find((t) => t.counterparty === "Sam Patel" && t.amount > 0);
      return res.end(toolCalls([{ id: "call_b", name: "refund_payment", args: { payment_id: sam.id, amount: 80, reason: "You asked me to refund Sam $80." } }]));
    }
    const declined = trailingTools[0].content.includes("declined");
    return res.end(textTurn(declined ? "Understood, I did not refund Sam." : "Done. I refunded **$80.00** to Sam Patel."));
  });
}).listen(8899, () => console.log("mock groq on 8899"));
