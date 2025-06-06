import { routeAgentRequest, type Schedule } from "agents";

import { AIChatAgent } from "agents/ai-chat-agent";
import {
  createDataStreamResponse,
  generateId,
  streamText,
  type StreamTextOnFinishCallback,
  type ToolSet,
} from "ai";

interface Env {
  AI: any;
  ASSETS: Fetcher;
}
// import { openai } from "@ai-sdk/openai";

import { createWorkersAI } from "workers-ai-provider";

import { processToolCalls } from "./utils";
import { tools, executions } from "./tools";
// import { env } from "cloudflare:workers";

// const model = openai("gpt-4o-2024-11-20");

// Alternative AI
// const workersai = createWorkersAI({ binding: env.AI });
// const model = workersai("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b");

// Cloudflare AI Gateway
// const openai = createOpenAI({
//   apiKey: env.OPENAI_API_KEY,
//   baseURL: env.GATEWAY_BASE_URL,
// });

/**
 * Chat Agent implementation that handles real-time AI chat interactions
 */
export class Chat extends AIChatAgent<Env> {
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: { abortSignal?: AbortSignal }
  ) {
    // ─── 1 ─── Grab the userId from the DO instance name ────────────────────
    const myId = this.name;
    console.log(
      "🔑 Chat.onChatMessage() — Durable Object instance name (userId):",
      myId
    );
    // ─── 2 ─── Connect to MCP and gather tools as you did before ────────────
    const workersai = createWorkersAI({ binding: this.env.AI });
    const model = workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast");

    if (!process.env.MCP_SERVER_URL) {
      throw new Error(
        "MCP_SERVER_URL is not defined in the environment variables."
      );
    }
    const mcpConnection = await this.mcp.connect(
      `${process.env.MCP_SERVER_URL}?userId=${myId}`
    );

    const mcpTools = this.mcp.unstable_getAITools();
    const aliasedTools: Record<
      string,
      (typeof mcpTools)[keyof typeof mcpTools]
    > = {};
    for (const fullName of Object.keys(mcpTools)) {
      // e.g. fullName = "n4E3SIHZ_listItems"
      const suffix = fullName.split("_").slice(1).join("_"); // → "listItems"
      aliasedTools[suffix] = mcpTools[fullName];
    }
    const allTools = { ...aliasedTools };

    // ─── 3 ─── Prompt that injects `${myId}` instead of "alice123" ───
    // Note how every literal "alice123" from before is now `${myId}`:
    const systemPrompt = `
You are a friendly supermarket assistant. The userId for this session is exactly "${myId}". Always use "${myId}" whenever you call any cart‐related tool.

If the user asks a general inventory question (“What items are available?” or “How much does a banana cost?”), reply in plain English.

If the user asks anything cart‐related (“What’s in my cart?”, “Add X apples to my cart”, “Remove Y bananas from my cart”, or “Checkout”), immediately emit the correct JSON tool invocation—always using "userId":"${myId}". For example:

• “What items do I have in my cart?” →  
  <tool name="viewCart">
  {"schema":{"userId":"${myId}"}}
  </tool>
  (Then, after you see the JSON array, respond in plain English.)

• “Add 2 apples and 1 candy bar to my cart” →  
  <tool name="addMultipleToCart">
  {"schema":{"userId":"${myId}","items":[{"id":"apple","quantity":2},{"id":"candy","quantity":1}]}}
  </tool>
  (Then reply: “Your items have been successfully added to your cart.”)

• “Remove 3 apples from my cart” →  
  <tool name="viewCart">
  {"schema":{"userId":"${myId}"}}
  </tool>
  (Wait for the viewCart JSON, check if apples ≥ 3, then either:)  
    ○ If yes:  
      <tool name="removeFromCart">
      {"schema":{"userId":"${myId}","itemId":"apple","quantity":3}}
      </tool>  
      → “Three apples have been removed—here’s your updated cart.”  
    ○ If no:  
      → “You only have X apples in your cart, so you cannot remove 3.”

• “Checkout” →  
  <tool name="checkout">
  {"schema":{"userId":"${myId}"}}
  </tool>  
  → “Your order has been placed. Thank you!”

Never ask the user to re-enter their userId. You already know it is “${myId}.” If at any point the user says “My userId changed to YYY,” accept YYY as the new userId and use it going forward. Always remain friendly, concise, and accurate.
`;

    // Log the fully‐interpolated prompt
    console.log("📝 Full systemPrompt (with userId injected):\n", systemPrompt);

    // ─── 4 ─── Wrap that prompt in your existing createDataStreamResponse ──
    const dataStreamResponse = createDataStreamResponse({
      execute: async (dataStream) => {
        const processedMessages = await processToolCalls({
          messages: this.messages,
          dataStream,
          tools: tools,
          executions,
        });

        const result = streamText({
          model,
          system: systemPrompt,
          messages: processedMessages,
          tools: allTools,
          onFinish: async (args) => {
            onFinish(
              args as Parameters<StreamTextOnFinishCallback<ToolSet>>[0]
            );
            await this.mcp.closeConnection(mcpConnection.id);
          },
          onError: (error) => console.error("Error while streaming:", error),
          maxSteps: 10,
        });

        result.mergeIntoDataStream(dataStream);
      },
    });

    return dataStreamResponse;
  }
  async executeTask(description: string, task: Schedule<string>) {
    await this.saveMessages([
      ...this.messages,
      {
        id: generateId(),
        role: "user",
        content: `Running scheduled task: ${description}`,
        createdAt: new Date(),
      },
    ]);
  }
}

/**
 * Worker entry point that routes incoming requests to the appropriate handler
 */
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const userId = url.searchParams.get("userId");

    // 1) If someone is simply trying to see the Login page:
    if (url.pathname === "/" || url.pathname === "/login") {
      return env.ASSETS.fetch(request);
    }

    // 2) If they typed /chat?userId=someName,
    //    we should also serve the same React app—so that React Router can take over:
    if (url.pathname === "/chat" && userId) {
      // Return the React index.html (and its .js/.css from “public/”)
      return env.ASSETS.fetch(request);
    }

    // 3) If /chat but no userId, redirect to /login:
    if (url.pathname === "/chat" && !userId) {
      return Response.redirect("/login", 302);
    }

    // 4) If the browser or React tries to open a WebSocket/SSE to /agents/chat/<userId>/…,
    //    let it fall through to routeAgentRequest so the DO can pick it up.
    //    (We do not do "return env.ASSETS.fetch" here, because static files are only at / or /login or /chat?userId).

    // 5) A health‐check endpoint:
    if (url.pathname === "/check-open-ai-key") {
      return Response.json({ success: !!process.env.OPENAI_API_KEY });
    }

    // 6) Finally, hand off to the Agents SDK to catch anything under /agents/chat/<instance>:
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
