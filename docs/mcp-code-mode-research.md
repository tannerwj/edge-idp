# Code Mode for the Johnson ID MCP Server — Research Brief

Date: 2026-10-07

## TL;DR

"Code mode" is **not** a protocol capability or MCP spec extension. It's an
architectural pattern (documented by Cloudflare, originating from Anthropic's
engineering work and Apple's CodeAct research): instead of advertising every
tool individually, the MCP server exposes **code execution as its tool
interface**. The model writes a short script that calls many tools inside an
isolated sandbox; intermediate results never re-enter model context. This cuts
input tokens by 58–93% (growing with tool count) while keeping a 100% pass rate.

Our Family Brain (`~/workspace/family-hub`) already implements exactly this —
`search_tools` + `execute` backed by Cloudflare Dynamic Workers — and its
implementation is a proven, in-production reference we can lift almost
verbatim. The plan below adapts it to the identity repo's hand-rolled MCP
server (`src/mcp.ts`).

---

## 1. What code mode is

Classic MCP tool-calling has a scaling wall:

1. **Tool definitions overload context** — every tool's schema loads into the
   model's context on every request, before it even reads the user's prompt.
2. **Intermediate results bloat context** — every tool result round-trips
   through the model, even when data only needs to flow between tools (e.g. a
   5,000-user list copied twice so the model can pick one id).

Code mode flips this: the server advertises a tiny tool surface (one or two
meta-tools) and the model writes code — JavaScript on Cloudflare — that
orchestrates the real tools inside a **sandboxed isolate**. The model sees only
the final result. Anthropic's example (a Google Drive → Salesforce integration)
shrank from ~150k tokens to ~2k by switching to code execution.

Two patterns exist (Cloudflare Agents docs: "Code Mode MCP server patterns"):

| Pattern | MCP tools | Best for |
|---|---|---|
| **Single code tool** (`codeMcpServer()`) | one `code` tool whose description carries typed TS declarations for every upstream tool | an existing server with a manageable tool count — **this is us** (12 tools) |
| **Search and execute** (`openApiMcpServer()`) | `search` (discovers ops) + `execute` (runs code with an authenticated request fn) | large APIs (thousands of ops) where even declarations would bloat context |

Our Family Brain uses the search+execute variant because it has ~170 tools; our
12-tool IdP catalog fits the single-code-tool pattern — but exposing both is
fine, and the `execute` tool described below subsumes the search+execute
workflow if we keep `search_tools` too.

## 2. Why it's useful for an IdP admin MCP

Typical admin tasks are **multi-step and data-shuffling**:

- "Add Chelsey, put her in `family` and `wedding` groups, and check which apps
  she'd get access to" = `users_create` → 2× `groups_add_member` → `clients_list`
  → filter in the model. With classic calling, the full user list, group list,
  and client list each round-trip through context.
- "Rotate the secret on every staging app" = list clients, loop, call rotate
  per app — N round trips vs. one script.

In code mode the model writes:

```js
async () => {
  const u = await id.users_create({ name: "Chelsey", email: "chelsey@example.com" });
  for (const g of ["family", "wedding"]) {
    await id.groups_add_member({ group_name: g, email: u.email });
  }
  const apps = await id.clients_list({});
  return apps.filter(a => a.allowed_groups?.some(g => ["family","wedding"].includes(g)))
             .map(a => a.name);
}
```

One tool call, one sandbox execution, filtering happens in code. The model
never sees the 5,000-row user list — only the filtered answer. Loops,
conditionals, and error handling live in code rather than chained tool calls,
which also reduces latency (no per-step model round trip).

## 3. How it works on Cloudflare Workers

Model-written JS runs in an **isolated Dynamic Worker** (a fresh V8 isolate per
execution), via the `worker_loaders` binding:

- **No filesystem, no env vars, `globalOutbound: null`** — generated code has
  zero network access. Its only capability is an RPC binding back to the host
  worker (`callTool`), through which upstream tool handlers execute **with the
  caller's own credential**.
- The sandbox never sees the API token: it's passed via `ctx.props`, which is
  invisible across the RPC boundary.
- Generated code reaches the outside world only through the upstream tool
  handlers (or a host-provided request callback), never directly.

This is what Our Family Brain's `McpCodeSandbox` (a `WorkerEntrypoint`) plus
`MCP_SANDBOX_BOOTSTRAP` do in `~/workspace/family-hub/src/index.js`
(~lines 23214–23420): a bootstrap module exposes a typed `id`/`fb` proxy (one
async method per tool) and a captured `console`; user code is wrapped as
`export async function run(id, console) { <code> }`; the host loads it with
`env.LOADER.load({ mainModule, modules, env: { ID: rpcStub }, globalOutbound:
null })` and calls the `Agent` entrypoint with CPU/time limits.

## 4. Concrete implementation plan for `~/workspace/identity`

Current state: `src/mcp.ts` is a hand-rolled minimal JSON-RPC server (no SDK)
with a `TOOLS` array; handlers take `(db, args, adminId)`. `wrangler.toml`
already has `nodejs_compat`; it lacks a `worker_loaders` binding.

**Step 1 — Add the sandbox binding** (`wrangler.toml`):

```toml
[[worker_loaders]]
binding = "LOADER"
```

Add `LOADER: WorkerLoader` to the `Env` type in `src/config.ts`.

**Step 2 — Generate typed declarations from the existing catalog.**

The `code` tool description must contain TypeScript declarations for every
upstream tool so the model knows the API. Generate them at module load from
the existing `TOOLS` array (single source of truth — no drift):

```ts
function toolDeclarations(): string {
  return TOOLS
    .filter((t) => t.name !== "code" && t.name !== "search_tools")
    .map((t) => {
      const schema = JSON.stringify(t.inputSchema);
      return `/** ${t.description} */\n${t.name}(args: ${schemaToTs(t.inputSchema)}): Promise<any>;`;
    })
    .join("\n");
}
```

(`schemaToTs` is a small JSON-schema→TS renderer; ~40 lines. Keep it
conservative: objects → interfaces, enums → unions.)

**Step 3 — Add the `execute` tool** (and optionally `search_tools`).

- `execute({ code })`: 
  1. **Validate the Bearer <redacted> before spinning up the isolate**
     (fail closed — family-hub does this so a bad token can't burn sandbox
     compute).
  2. Wrap: `export async function run(id, console) {\n${code}\n}`.
  3. `env.LOADER.load({ compatibilityDate, mainModule: "bootstrap.js",
     modules: { "bootstrap.js": ID_SANDBOX_BOOTSTRAP, "user-code.js": wrapped },
     env: { ID: rpcStub }, globalOutbound: null })`.
  4. Race against a 25s timeout; entrypoint limits `{ cpuMs: 20000,
     subRequests: 500 }`; reject code > 200KB.
  5. Return `{ value, logs, toolCalls }` as the tool result.
- The RPC stub (`IdCodeSandbox extends WorkerEntrypoint`) implements
  `callTool(toolName, args)`: looks up `TOOLS`, runs the handler **host-side**
  with the caller's `adminId`, and returns the parsed result. It must refuse
  `execute`/`search_tools`/`code` (no recursion).
- Keep `tools/call` accepting every underlying tool name directly (family-hub
  does this as a zero-token-cost debugging fallback).

**Step 4 — Update `tools/list` and the server instructions.**

Advertise `code` (primary) plus the raw tools, or `search_tools` + `execute`
if we prefer progressive discovery. The `initialize` response's `instructions`
field should teach the workflow: "write a single JS snippet against `id`,
chain calls, filter in code; only the return value comes back."

**Step 5 — Metrics and visibility** (user explicitly asked).

Every `execute` call should log to an `mcp_metrics` D1 table (or the existing
metrics infra): timestamp, tool name (`execute`), durationMs, status, error
code, code length, number of inner tool calls, which inner tools were called,
sandbox errors. Then expose:

- An admin-visible **metrics summary** (per-tool call counts, avg/p50/p95/max
  latency, top error codes, daily trend, execute composition: avg inner calls
  per run, most-chained tools, zero-result `search_tools` queries =
  discoverability gaps). Family-hub's `metrics_summary` MCP tool description is
  a good template: *"per-tool/endpoint calls, latency (avg/p50/p95/max), error
  counts with top error codes, daily trend, top agents, execute composition
  (avg fb calls per run, sandbox errors, most-chained tools), and search
  quality (zero-result queries = discoverability gaps)."*
- Surface it both as an MCP tool (`metrics_summary`) for agents and as a
  section on the admin dashboard for humans — the zero-result-search and
  most-chained-tools signals are what tell us where the catalog needs work
  (missing tools, bad descriptions, schemas agents fumble).

Also log `search_tools` queries with zero results — that's the direct signal
for "the model wanted something we don't have."

**Step 6 — Tests.**

- e2e: `execute` runs a two-call chain (e.g. `users_list` → filter → count)
  and returns only the filtered result; assert intermediate data doesn't leak
  into the model-visible result.
- e2e: sandbox has no network (`fetch` inside code throws); sandbox can't see
  the token (code that tries to read `env`/exfiltrate gets nothing).
- e2e: invalid token → 401/JSON-RPC error **without** isolate spin-up.
- e2e: `execute` can't call `execute` (recursion refused).

## 5. Security considerations

- **Code execution ≠ authorization.** Every side effect still runs through the
  existing tool handlers, which enforce the admin-credential check and audit
  logging. The sandbox adds orchestration power, not new privileges.
- **Credential isolation**: token lives in `ctx.props`, invisible across the
  RPC boundary. Generated code receives a request/call function, never the
  credential. Never include tokens in tool results or declarations.
- **Network isolation**: `globalOutbound: null`. The only exfiltration path is
  via tool calls, which are logged and permission-checked.
- **Resource limits**: cap CPU (20s), wall time (25s), subrequests (500), code
  size (200KB) — model-written code can loop.
- **Fail closed on auth**: validate before loading the isolate.
- **No recursion**: `execute`/`search_tools` unavailable inside `execute`.
- **Audit**: log the code hash (not full code? — full code is better for
  forensics; 200KB max makes this fine) alongside the admin id in `audit_log`.
- **Prompt-injection surface**: the model writes the code, but in our threat
  model the MCP client is the admin (Tanner or his agent) — the code author is
  already fully trusted. The sandbox matters for *blast radius* (a confused
  model can't touch the network or env), not for untrusted-code containment.

## 6. Decision: package vs. hand-rolled

| Option | Pros | Cons |
|---|---|---|
| **A. Hand-rolled** (mirror family-hub's `McpCodeSandbox` + bootstrap) | Proven in production on this exact stack; no new deps; keeps our no-SDK JSON-RPC server | We own the bootstrap string and declaration generator |
| **B. `@cloudflare/codemode`** (`codeMcpServer()`, `DynamicWorkerExecutor`) | Official, maintained; handles code normalization and declaration generation | Pulls in `@modelcontextprotocol/sdk` + `agents`; bigger refactor of `src/mcp.ts` |

**Recommendation: A.** Family-hub's implementation is battle-tested, dependency-free,
and directly transferable — the `TOOLS` array in `src/mcp.ts` maps 1:1 onto
the `fb`/`id` proxy pattern. Revisit B only if declaration generation or
sandbox edge cases become a maintenance burden.

## References

- Cloudflare Agents docs: "Code Mode MCP server patterns" —
  https://developers.cloudflare.com/agents/model-context-protocol/codemode/
- Cloudflare Agents docs: "Build a single-tool Code Mode MCP server" —
  https://developers.cloudflare.com/agents/model-context-protocol/guides/build-codemode-mcp-server/
- Cloudflare blog: "Sandboxing AI agents, 100x faster" (Dynamic Workers +
  `@cloudflare/codemode`) — https://blog.cloudflare.com/dynamic-workers/
- Maxim AI: "Code Execution with MCP: How Code Mode Cuts Agent Token Costs by
  90%+" — https://www.getmaxim.ai/articles/code-execution-with-mcp-how-code-mode-cuts-agent-token-costs-by-90/
- Dev.to: "MCP at Scale: When to Use Code Mode Instead of Classic Tool Calling" —
  https://dev.to/kuldeep_paul/mcp-at-scale-when-to-use-code-mode-instead-of-classic-tool-calling-1f02
- In-repo reference implementation: `~/workspace/family-hub/src/index.js`
  - `McpCodeSandbox` / `MCP_SANDBOX_BOOTSTRAP` (~line 23214)
  - `runCodeMode()` (~line 23323)
  - `metrics_summary` tool description (~line 22815)
  - Code-mode catalog comment (~line 22888)
