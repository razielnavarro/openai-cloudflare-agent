import {
  Agent as CFAgent,
  routeAgentRequest,
  type AgentNamespace,
} from "agents";
import { Agent, run, MCPServerStreamableHttp } from "@openai/agents";

type Env = {
  myagent: AgentNamespace<Chat>;
  ASSETS: Fetcher;
  INVENTORY_MCP_SERVER_URL: string;
  CART_MCP_SERVER_URL: string;
  OPENAI_API_KEY: string;
};

export class Chat extends CFAgent<Env> {
  async onRequest(request: Request) {
    // Extract the user's message.
    // It can come either in the JSON body `{ input: "..." }` or as the
    // `?input=` search-param (useful for simple curl / browser testing).
    let input: string | null = null;

    // 1. Try JSON body (if any)
    if (request.headers.get("content-type")?.includes("application/json")) {
      try {
        const body = (await request.json()) as { input?: string };
        input = body?.input ?? null;
      } catch {
        // Ignore JSON parse errors – will fall back to query param.
      }
    }

    // 2. Fallback: query param
    if (!input) {
      const url = new URL(request.url);
      input = url.searchParams.get("input");
    }

    if (!input) {
      return new Response("Missing `input`.", { status: 400 });
    }

    const myId = this.name;

    // == 1. Define Inventory Agent ==
    const inventoryMcpServer = new MCPServerStreamableHttp({
      url: `${this.env.INVENTORY_MCP_SERVER_URL}?userId=${encodeURIComponent(
        myId
      )}`,
      name: "Inventory MCP",
      // optional: cache the list_tools() response in memory
      cacheToolsList: true,
    });
    await inventoryMcpServer.connect();
    const inventoryAgent = new Agent({
      name: "InventoryManager",
      instructions: "An agent that can check inventory and manage stock.",
      mcpServers: [inventoryMcpServer],
      model: "gpt-4-turbo-preview",
    });

    // == 2. Define Cart Agent ==
    const cartMcpServer = new MCPServerStreamableHttp({
      url: `${this.env.CART_MCP_SERVER_URL}?userId=${encodeURIComponent(myId)}`,
      name: "Cart MCP",
      cacheToolsList: true,
    });
    await cartMcpServer.connect();
    const cartAgent = new Agent({
      name: "ShoppingCartManager",
      instructions:
        "An agent that can add, remove, and view items in a shopping cart.",
      mcpServers: [cartMcpServer],
      model: "gpt-4-turbo-preview",
    });

    // == 3. Define Triage Agent ==
    const triageAgent = new Agent({
      name: "TriageAgent",
      instructions: `You are a triage agent for a supermarket. Your job is to route user requests to the correct specialist agent.
- If the user asks about inventory, stock, or product details, use the InventoryManager.
- If the user wants to add, remove, or view their shopping cart, use the ShoppingCartManager.`,
      tools: [
        inventoryAgent.asTool({ toolName: "InventoryManager" }),
        cartAgent.asTool({ toolName: "ShoppingCartManager" }),
      ],
      model: "gpt-4-turbo-preview",
    });

    const result = await run(triageAgent, input);

    await inventoryMcpServer.close();
    await cartMcpServer.close();

    return new Response(result.finalOutput);
  }

  /**
   * This method is invoked by tools.scheduleTask via `agent.schedule(...)`.
   * It will run at the scheduled time inside the same Durable Object.
   */
  async executeTask(description: string) {
    // For now, just log; in real usage you could call an external API or update state.
    console.log("[executeTask]", description);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const userId = url.searchParams.get("userId");

    if (url.pathname === "/" || url.pathname === "/login") {
      return env.ASSETS.fetch(request);
    }

    // 2) If they typed /chat?userId=someName,
    //    we should also serve the same React app—so that React Router can take over:
    if (url.pathname === "/chat" && userId) {
      // Return the React index.html (and its .js/.css from "public/")
      return env.ASSETS.fetch(request);
    }

    // 3) If /chat but no userId, redirect to /login:
    if (url.pathname === "/chat" && !userId) {
      return Response.redirect("/login", 302);
    }

    // 4) If the browser or React tries to open a WebSocket/SSE to /agents/chat/<userId>/…,
    //    let it fall through to routeAgentRequest so the DO can pick it up.
    //    (We do not do "return env.ASSETS.fetch" here, because static files are only at / or /login or /chat?userId).

    // 5) A health-check endpoint:
    if (url.pathname === "/check-open-ai-key") {
      return Response.json({ success: !!env.OPENAI_API_KEY });
    }
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
};
