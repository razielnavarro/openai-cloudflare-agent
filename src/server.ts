import { routeAgentRequest, type Schedule } from "agents";
import { unstable_getSchedulePrompt } from "agents/schedule";
import { AIChatAgent } from "agents/ai-chat-agent";
import {
  createDataStreamResponse,
  generateId,
  streamText,
  type StreamTextOnFinishCallback,
  type ToolSet,
} from "ai";
import { openai } from "@ai-sdk/openai";
import { processToolCalls } from "./utils";
import { tools, executions } from "./tools";

// Bind your model
const model = openai("gpt-4o-2024-11-20");

type Env = {
  myagent: DurableObjectNamespace;
  ASSETS: Fetcher;
  INVENTORY_MCP_SERVER_URL: string;
  CART_MCP_SERVER_URL: string;
  OPENAI_API_KEY: string;
};

export class Chat extends AIChatAgent<Env> {
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: { abortSignal?: AbortSignal }
  ) {
    // Connect to specialist agents over MCP
    const invConn = await this.mcp.connect(
      `${this.env.INVENTORY_MCP_SERVER_URL}?userId=${this.name}`
    );
    const cartConn = await this.mcp.connect(
      `${this.env.CART_MCP_SERVER_URL}?userId=${this.name}`
    );

    // Merge your local tools with those exposed by the remote agents
    const allTools = {
      ...tools,
      ...this.mcp.unstable_getAITools(),
    };

    return createDataStreamResponse({
      execute: async (dataStream) => {
        // First, handle any pending tool calls
        const processed = await processToolCalls({
          messages: this.messages,
          dataStream,
          tools: allTools,
          executions,
        });

        // Then stream out the AI’s response
        const result = streamText({
          model,
          system: `You are a helpful assistant that can do various tasks...\n\n${unstable_getSchedulePrompt({ date: new Date() })}`,
          messages: processed,
          tools: allTools,
          onFinish: async (step) => {
            onFinish(step as any);
            // Clean up MCP connections when done
            await this.mcp.closeConnection(invConn.id);
            await this.mcp.closeConnection(cartConn.id);
          },
          onError: (err) => console.error("Stream error:", err),
          maxSteps: 10,
        });

        result.mergeIntoDataStream(dataStream);
      },
    });
  }

  // Handle scheduled tasks if you ever call `agent.schedule(...)`
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

// Entry point: serve your static frontend and hand `/agents/...` routes to the agent runtime
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const userId = url.searchParams.get("userId");

    // Static pages
    if (url.pathname === "/" || url.pathname === "/login") {
      return env.ASSETS.fetch(request);
    }
    if (url.pathname === "/chat") {
      if (userId) {
        return env.ASSETS.fetch(request);
      } else {
        return Response.redirect("/login", 302);
      }
    }

    // Health check
    if (url.pathname === "/check-open-ai-key") {
      return Response.json({ success: !!env.OPENAI_API_KEY });
    }

    // All agent interaction routes
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
