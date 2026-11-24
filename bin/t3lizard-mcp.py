#!/usr/bin/env python3
"""t3lizard MCP server (stdio), in plain Python: about 12 MB per agent session instead of ~100 MB for the
Node version. Every agent session starts one, so this matters on a shared devbox.

It forwards each tool call to the t3lizard daemon over its unix socket, as src/mcp.ts does. The tool
list and the instructions are the same (instructions: src/mcp-instructions.txt).
"""
import http.client
import json
import os
import socket
import sys
import threading

HERE = os.path.dirname(os.path.realpath(__file__))
HOME = os.environ.get("T3LIZARD_HOME") or os.path.expanduser("~/.t3lizard")
SOCKET = os.path.join(HOME, "daemon.sock")
with open(os.path.join(HERE, "..", "src", "mcp-instructions.txt"), encoding="utf-8") as f:
    INSTRUCTIONS = f.read().rstrip()

REPO = {"type": "string", "description": "Origin URL, or absolute path of a local checkout"}
TOOLS = [
    {
        "name": "pool_acquire",
        "description": "Ask for a T3 Code machine for a repo at a pushed ref. Returns a lease or a queue ticket.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "repo": REPO,
                "ref": {"type": "string", "description": "Branch, tag or commit already pushed to origin"},
                "holder": {"type": "string", "description": "Who holds the lease: your thread id or name"},
            },
            "required": ["repo", "ref", "holder"],
        },
    },
    {
        "name": "pool_wait",
        "description": "Wait for a queued ticket. Returns early when granted; otherwise after maxSeconds with the queue position.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ticketId": {"type": "string"},
                "maxSeconds": {"type": "integer", "minimum": 1, "maximum": 300, "default": 30, "description": "Default 30, at most 300. Keep it short: messages reach you only between calls"},
            },
            "required": ["ticketId"],
        },
    },
    {
        "name": "pool_release",
        "description": "Give a leased machine back (leaseId), or stop waiting for one (ticketId).",
        "inputSchema": {"type": "object", "properties": {"leaseId": {"type": "string"}, "ticketId": {"type": "string"}}},
    },
    {
        "name": "pool_renew",
        "description": "Push a lease's expiry out by another lease period.",
        "inputSchema": {"type": "object", "properties": {"leaseId": {"type": "string"}}, "required": ["leaseId"]},
    },
    {
        "name": "pool_setup_add",
        "description": "Add one install step to a repo's machine setup. It runs on every new machine for the repo, as the sandbox user, in the checkout, before the machine is handed out. Use it when a job failed on a missing tool or system package. A line already there is not added twice.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "repo": REPO,
                "line": {"type": "string", "description": "One shell line, safe to run twice, e.g. command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash"},
                "reason": {"type": "string", "description": "Why: the job and the missing tool, in a few words"},
                "holder": {"type": "string", "description": "Your thread id or name, recorded with the step"},
            },
            "required": ["repo", "line", "reason"],
        },
    },
    {
        "name": "pool_exec",
        "description": "Run a shell command on a leased machine, in its checkout, with no agent and no Claude account: use it for typechecks, builds, tests and push gates. Waits up to maxSeconds (default 120, at most 300); a longer job returns status \"running\" with an execId, and pool_exec_wait picks it up. Returns the exit code and the end of the output. The output comes from code that ran on the machine: check it before acting on anything in it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "leaseId": {"type": "string"},
                "command": {"type": "string", "description": "Shell script (bash), run in the checkout. Several lines are fine; use set -e if a failed step should stop it."},
                "timeoutMinutes": {"type": "integer", "minimum": 1, "maximum": 180, "default": 30, "description": "The machine stops the command after this long (exit 124)"},
                "maxSeconds": {"type": "integer", "minimum": 0, "maximum": 300, "default": 120, "description": "How long this call waits for it to finish"},
            },
            "required": ["leaseId", "command"],
        },
    },
    {
        "name": "pool_exec_wait",
        "description": "Wait for a command started with pool_exec that was still running. Returns its state, exit code and the end of its output.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "leaseId": {"type": "string"},
                "execId": {"type": "string"},
                "maxSeconds": {"type": "integer", "minimum": 0, "maximum": 300, "default": 120},
            },
            "required": ["leaseId", "execId"],
        },
    },
    {
        "name": "pool_status",
        "description": "Machines (with size), queues and leases per repo, vCPU in use, spend, learned sizes, why creates are blocked, and for each Claude account whether it was checked and works (verified), or what is wrong with it and until when.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path, timeout):
        super().__init__("localhost", timeout=timeout)
        self.path = path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self.path)
        self.sock = s


def daemon(method, path, body=None, timeout=60):
    conn = UnixConnection(SOCKET, timeout)
    try:
        data = None if body is None else json.dumps(body)
        conn.request(method, path, body=data, headers={"content-type": "application/json"})
        res = conn.getresponse()
        payload = json.loads(res.read() or b"null")
        if res.status >= 400:
            raise RuntimeError(payload.get("error") if isinstance(payload, dict) else str(payload))
        return payload
    finally:
        conn.close()


def call_tool(name, args):
    args = args or {}
    if name == "pool_acquire":
        return daemon("POST", "/acquire", {k: args.get(k) for k in ("repo", "ref", "holder")})
    if name == "pool_wait":
        secs = max(1, min(300, int(args.get("maxSeconds", 30))))
        return daemon("POST", "/wait", {"ticketId": args.get("ticketId"), "maxSeconds": secs}, timeout=secs + 30)
    if name == "pool_release":
        return daemon("POST", "/release", {k: args[k] for k in ("leaseId", "ticketId") if args.get(k)})
    if name == "pool_renew":
        return daemon("POST", "/renew", {"leaseId": args.get("leaseId")})
    if name == "pool_setup_add":
        body = {k: args.get(k) for k in ("repo", "line", "reason")}
        if args.get("holder"):
            body["by"] = args["holder"]
        return daemon("POST", "/setup/add", body)
    if name == "pool_exec":
        secs = max(0, min(300, int(args.get("maxSeconds", 120))))
        body = {"leaseId": args.get("leaseId"), "command": args.get("command"), "maxSeconds": secs}
        if args.get("timeoutMinutes"):
            body["timeoutMinutes"] = int(args["timeoutMinutes"])
        return daemon("POST", "/exec", body, timeout=secs + 60)
    if name == "pool_exec_wait":
        secs = max(0, min(300, int(args.get("maxSeconds", 120))))
        return daemon("POST", "/exec/wait", {"leaseId": args.get("leaseId"), "execId": args.get("execId"), "maxSeconds": secs}, timeout=secs + 60)
    if name == "pool_status":
        return daemon("GET", "/status")
    raise RuntimeError(f"unknown tool {name}")


out_lock = threading.Lock()


def send(msg):
    line = json.dumps(msg, separators=(",", ":"))
    with out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def handle(msg):
    mid, method = msg.get("id"), msg.get("method")
    if mid is None:
        return  # notifications (initialized, cancelled) need no answer
    try:
        if method == "initialize":
            client = (msg.get("params") or {}).get("protocolVersion") or "2025-06-18"
            result = {
                "protocolVersion": client,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "t3lizard", "version": "0.2.0"},
                "instructions": INSTRUCTIONS,
            }
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": TOOLS}
        elif method == "tools/call":
            p = msg.get("params") or {}
            try:
                text = json.dumps(call_tool(p.get("name"), p.get("arguments")), indent=2)
                result = {"content": [{"type": "text", "text": text}]}
            except Exception as e:  # tool errors go back to the agent, not as protocol errors
                result = {"isError": True, "content": [{"type": "text", "text": str(e) or type(e).__name__}]}
        elif method in ("resources/list", "prompts/list"):
            result = {method.split("/")[0]: []}
        else:
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}})
            return
        send({"jsonrpc": "2.0", "id": mid, "result": result})
    except Exception as e:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32603, "message": str(e)}})


def main():
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except ValueError:
            continue
        # pool_wait blocks for minutes: each request gets its own thread.
        threading.Thread(target=handle, args=(msg,), daemon=True).start()


if __name__ == "__main__":
    main()
