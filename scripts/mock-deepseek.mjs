// Local DeepSeek-compatible mock server used to verify the AI pipeline
// end to end without a real API key:
//
//   node scripts/mock-deepseek.mjs [port]
//
// It implements POST /chat/completions with both plain JSON and streaming
// (server-sent events) responses, using the same shapes as the real API.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 8899);

const SUMMARY = [
  "**Summary (mock API).** This document is a synthetic sample report generated for testing.",
  "It contains five pages with a short caption and a framed area on each page.",
  "The text repeats the page number and a note that the document was generated for testing.",
  "Key facts: 5 pages, A4, plain text layer, no images, no signatures.",
  "No decisions, deadlines or amounts are present in the document.",
].join(" ");

function pickReply(body) {
  const messages = body?.messages ?? [];
  const lastUser = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  if (/JSON object/i.test(messages[0]?.content ?? "")) {
    return '{"title":"Sample report A","author":"PDF Swiss Army Knife samples","subject":"Synthetic test document","keywords":["sample","report","testing","pdf"]}';
  }
  if (/single word: ready/i.test(lastUser)) return "ready";
  if (/Translate/i.test(lastUser)) {
    return "**Çeviri (mock).** Bu belge, test için üretilmiş sentetik bir örnek rapordur. Beş sayfa içerir.";
  }
  if (/Question:/i.test(lastUser)) return "The document does not contain that information (mock answer).";
  return SUMMARY;
}

const server = createServer((request, response) => {
  if (request.method !== "POST" || !request.url?.includes("/chat/completions")) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":{"message":"not found"}}');
    return;
  }
  let raw = "";
  request.on("data", (chunk) => {
    raw += chunk;
  });
  request.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* keep empty */
    }
    const reply = pickReply(body);
    try {
      appendFileSync(
        process.env.TEMP + "/mock-deepseek.log",
        `${new Date().toISOString()} stream=${Boolean(body.stream)} model=${body.model} messages=${(body.messages ?? []).length} promptChars=${(body.messages ?? []).reduce((sum, message) => sum + String(message.content ?? "").length, 0)}\n`,
      );
    } catch {
      /* logging is best effort */
    }
    if (body.stream) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const words = reply.split(" ");
      let index = 0;
      const timer = setInterval(() => {
        if (index >= words.length) {
          clearInterval(timer);
          response.write("data: [DONE]\n\n");
          response.end();
          return;
        }
        const delta = (index === 0 ? "" : " ") + words[index];
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
        index += 1;
      }, 25);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "mock-completion",
        object: "chat.completion",
        model: body.model ?? "deepseek-chat",
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
      }),
    );
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock DeepSeek API listening on http://127.0.0.1:${port}`);
});
