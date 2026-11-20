import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { call } from "./api.ts";
import { paths, t3lizardHome } from "./config.ts";

export const INSTRUCTIONS = readFileSync(new URL("./mcp-instructions.txt", import.meta.url), "utf8").trimEnd();

export async function serveMcp(socket = paths(t3lizardHome()).socket): Promise<McpServer> {
  const server = new McpServer({ name: "t3lizard", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const reply = async (fn: () => Promise<unknown>) => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(await fn(), null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] };
    }
  };

  server.registerTool(
    "pool_acquire",
    {
      description: "Ask for a T3 Code machine for a repo at a pushed ref. Returns a lease or a queue ticket.",
      inputSchema: {
        repo: z.string().describe("Origin URL, or absolute path of a local checkout"),
        ref: z.string().describe("Branch, tag or commit already pushed to origin"),
        holder: z.string().describe("Who holds the lease: your thread id or name"),
      },
    },
    (args) => reply(() => call(socket, "POST", "/acquire", args)),
  );
  server.registerTool(
    "pool_wait",
    {
      description: "Wait for a queued ticket. Returns early when granted; otherwise after maxSeconds with the queue position.",
      inputSchema: {
        ticketId: z.string(),
        maxSeconds: z.number().int().min(1).max(300).default(300).describe("At most 300"),
      },
    },
    (args) => reply(() => call(socket, "POST", "/wait", args)),
  );
  server.registerTool(
    "pool_release",
    {
      description: "Give a leased machine back (leaseId), or stop waiting for one (ticketId).",
      inputSchema: { leaseId: z.string().optional(), ticketId: z.string().optional() },
    },
    (args) => reply(() => call(socket, "POST", "/release", args)),
  );
  server.registerTool(
    "pool_renew",
    { description: "Push a lease's expiry out by another lease period.", inputSchema: { leaseId: z.string() } },
    (args) => reply(() => call(socket, "POST", "/renew", args)),
  );
  server.registerTool(
    "pool_setup_add",
    {
      description:
        "Add one install step to a repo's machine setup. It runs on every new machine for the repo, as the sandbox user, in the checkout, before the machine is handed out. Use it when a job failed on a missing tool or system package. A line already there is not added twice.",
      inputSchema: {
        repo: z.string().describe("Origin URL, or absolute path of a local checkout"),
        line: z.string().describe("One shell line, safe to run twice, e.g. command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash"),
        reason: z.string().describe("Why: the job and the missing tool, in a few words"),
        holder: z.string().optional().describe("Your thread id or name, recorded with the step"),
      },
    },
    ({ repo, line, reason, holder }) => reply(() => call(socket, "POST", "/setup/add", { repo, line, reason, ...(holder ? { by: holder } : {}) })),
  );
  server.registerTool(
    "pool_status",
    { description: "Machines (with size), queues and leases per repo, the size ladder in use, today's small-machine-hours against the daily budget, why creates are blocked, and which Claude accounts are limited until when." },
    () => reply(() => call(socket, "GET", "/status")),
  );

  await server.connect(new StdioServerTransport());
  return server;
}
