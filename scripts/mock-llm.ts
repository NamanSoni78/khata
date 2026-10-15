/**
 * Mock OpenAI-compatible LLM server for e2e chat-pipeline testing.
 * - Turn 1: emits a native tool call (log_expense)
 * - Turn 2: plain text reply (after tool result)
 * Also serves /v1/audio/transcriptions (returns fixed text).
 */
const STATE = { calls: 0 };

Bun.serve({
  port: 3999,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname.endsWith("/chat/completions")) {
      const body = await req.json().catch(() => ({}));
      const auth = req.headers.get("authorization") ?? "";
      STATE.calls++;
      console.log(`[mock-llm] call ${STATE.calls} auth=${auth} model=${body.model}`);

      const lastMsg = body.messages?.[body.messages.length - 1];
      const sawToolResult = body.messages?.some((m) => m.role === "tool");

      if (!sawToolResult) {
        // First turn → emit a tool call
        return Response.json({
          choices: [{
            message: {
              content: "",
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: {
                  name: "log_expense",
                  arguments: JSON.stringify({ amount: 20, category: "Transport", notes: "rapido" }),
                },
              }],
            },
          }],
        });
      }
      // Second turn → final reply
      return Response.json({
        choices: [{ message: { content: `Logged Rs 20 for Transport. (mock turns: ${STATE.calls})` } }],
      });
    }

    if (url.pathname.endsWith("/audio/transcriptions")) {
      return Response.json({ text: "aaj bees rupaye rapido ke kharch hue" });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log("mock-llm listening on :3999");
