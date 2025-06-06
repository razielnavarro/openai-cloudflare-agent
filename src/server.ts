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
  /**
   * Handles incoming chat messages and manages the response stream
   * @param onFinish - Callback function executed when streaming completes
   */

  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: { abortSignal?: AbortSignal }
  ) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const model = workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    if (!process.env.MCP_SERVER_URL) {
      throw new Error(
        "MCP_SERVER_URL is not defined in the environment variables."
      );
    }
    const mcpConnection = await this.mcp.connect(process.env.MCP_SERVER_URL);
    // 1) Grab MCP‐registered tools (e.g. { n4E3SIHZ_listItems: fn, n4E3SIHZ_addToCart: fn, … })
    const mcpTools = this.mcp.unstable_getAITools();

    // 2) Build a new "alias" object that maps the UNprefixed name ("listItems") → the prefixed function.
    //    We'll look at each key in mcpTools, split off the random prefix, and re‐map to that suffix.
    const aliasedTools: Record<
      string,
      (typeof mcpTools)[keyof typeof mcpTools]
    > = {};
    for (const fullName of Object.keys(mcpTools)) {
      // e.g. fullName = "n4E3SIHZ_listItems"
      const suffix = fullName.split("_").slice(1).join("_"); // yields "listItems"
      aliasedTools[suffix] = mcpTools[fullName];
    }

    // Collect all tools, including MCP tools
    const allTools = {
      // ...tools,
      ...aliasedTools,
    };

    // Create a streaming response that handles both text and tool outputs
    const dataStreamResponse = createDataStreamResponse({
      execute: async (dataStream) => {
        // Process any pending tool calls from previous messages
        // This handles human-in-the-loop confirmations for tools
        const processedMessages = await processToolCalls({
          messages: this.messages,
          dataStream,
          tools: tools,
          executions,
        });

        // Stream the AI response using GPT-4
        const result = streamText({
          model,
          system: `
You are a helpful supermarket assistant. Each user may ask about inventory (items in stock) or perform cart operations (view cart, add items, remove items, checkout). Only cart operations require a userId—inventory queries do not.

If the user asks anything that involves a cart tool (viewCart, addToCart, addMultipleToCart, removeFromCart, checkout) and you do NOT yet know their userId, immediately respond with exactly:
"Hi there! I don't yet know who you are. Please provide your userId (any short, unique string) so I can keep track of your cart."
Do NOT perform any tool call or discuss the cart before the user supplies a valid userId. Once they reply with a nonempty string (for example, "My userId is alice123" or simply "alice123"), record that as userId = "alice123" and proceed.

If the user asks a general inventory question (e.g. "What items are available in stock?" or "How much does a banana cost?"), you may answer directly in plain English without asking for a userId.

After you have recorded a valid userId, use it in every cart-related tool call:

• If the user asks "What items do I have in my cart?" or "How many <item> do I have?":

Call the viewCart tool with that userId. Example:
<tool name="viewCart">
{"schema":{"userId":"alice123"}}
</tool>

Wait for the JSON response (an array of {"id","name","price","quantity"} objects).

Present a concise English response reflecting the live data (e.g. "You have 6 apples and 3 loaves of bread.").

• If the user says "Remove 4 apples from my cart":

Call viewCart first with the known userId to check how many apples they have:
<tool name="viewCart">
{"schema":{"userId":"alice123"}}
</tool>

When viewCart returns, let quantityInCart = the returned quantity for "apple."
– If quantityInCart ≥ 4, emit:
<tool name="removeFromCart">
{"schema":{"userId":"alice123","itemId":"apple","quantity":4}}
</tool>
– Otherwise, respond: "You only have X apples in your cart, so you cannot remove 4."

• If the user says "Add 2 apples and 1 candy bar to my cart":
<tool name="addMultipleToCart">
{"schema":{"userId":"alice123","items":[{"id":"apple","quantity":2},{"id":"candy","quantity":1}]}}
</tool>
After the tool returns, reply: "Your items have been successfully added to your cart."

• If the user says "Checkout" (or "I'd like to pay now"):
<tool name="checkout">
{"schema":{"userId":"alice123"}}
</tool>
Once checkout succeeds, reply: "Your order has been placed. Thank you!"

If at any point the user states "My userId changed to bob456," accept "bob456" as the new userId and use it for all future tool calls. Do not ask for it again unless they explicitly change it.

Always remain friendly, concise, and accurate. Do not guess or fabricate a userId—only proceed with cart operations once the user has explicitly provided it.



`,
          messages: processedMessages,
          tools: allTools,
          onFinish: async (args) => {
            onFinish(
              args as Parameters<StreamTextOnFinishCallback<ToolSet>>[0]
            );
            await this.mcp.closeConnection(mcpConnection.id);
          },
          onError: (error) => {
            console.error("Error while streaming:", error);
          },
          maxSteps: 10,
        });

        // Merge the AI response stream with tool execution outputs
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const userId = url.searchParams.get("userId");

    // Redirect to login if no userId
    if (!userId && url.pathname.startsWith("/chat")) {
      return Response.redirect("/login", 302);
    }

    // Route /chat to the Chat Durable Object, using userId as the instance name
    if (url.pathname.startsWith("/chat") && userId) {
      // The agents SDK will use the `name` param to route to the correct DO instance
      // e.g. /agents/Chat/alice
      const newUrl = new URL(
        `/agents/Chat/${encodeURIComponent(userId)}`,
        url.origin
      );
      // Copy over search params except userId
      url.searchParams.forEach((v, k) => {
        if (k !== "userId") newUrl.searchParams.set(k, v);
      });
      // Proxy the request to the correct DO instance
      return fetch(newUrl.toString(), request);
    }

    if (url.pathname === "/check-open-ai-key") {
      const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
      return Response.json({
        success: hasOpenAIKey,
      });
    }
    if (!process.env.OPENAI_API_KEY) {
      console.error(
        "OPENAI_API_KEY is not set, don't forget to set it locally in .dev.vars, and use `wrangler secret bulk .dev.vars` to upload it to production"
      );
    }

    // Serve SPA for all other routes (including /login, /chat, etc.)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return (
      // Route the request to our agent or return 404 if not found
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
