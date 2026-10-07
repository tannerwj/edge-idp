import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../config";
import { resolveEnv } from "../instance";
import * as ops from "../ops";
import { activeAdmin, obj, trackCall } from "./common";
import type { McpAuth, ToolDef, WaitCtx } from "./common";
import { TOOLS } from "./tools";

interface SandboxProps {
  adminId: string;
  readOnly: boolean;
  tokenId: string;
  issuer: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function isSandboxProps(v: unknown): v is SandboxProps {
  return (
    isRecord(v) &&
    typeof v.adminId === "string" &&
    !!v.adminId &&
    typeof v.readOnly === "boolean" &&
    typeof v.tokenId === "string" &&
    typeof v.issuer === "string"
  );
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class IdCodeSandbox extends WorkerEntrypoint<Env> {
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const name = toolName;
    if (name === "execute") throw new Error("execute is not available inside execute");
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const props: unknown = this.ctx.props;
    if (!isSandboxProps(props) || !(await activeAdmin(this.env.DB, props.adminId)))
      throw new Error("credential rejected");
    if (tool.write && props.readOnly)
      throw new Error(`${name} needs write access; this token is read-only`);
    try {
      const env = await resolveEnv(this.env, props.issuer);
      return await tool.handler(
        { db: this.env.DB, env, actor: { adminId: props.adminId, via: "mcp" } },
        args ?? {},
      );
    } catch (e) {
      throw new Error(e instanceof ops.OpError ? e.message : `Internal error: ${errMessage(e)}`, {
        cause: e,
      });
    }
  }
}

const ID_SANDBOX_BOOTSTRAP = `
import { WorkerEntrypoint } from "cloudflare:workers";
import { run } from "./user-code.js";
export class Agent extends WorkerEntrypoint {
  async run() {
    const ID = this.env.ID;
    const logs = [];
    const toolCalls = [];
    let logChars = 0;
    const fmt = (a) => {
      if (typeof a === "string") return a.slice(0, 2000);
      try { return JSON.stringify(a).slice(0, 2000); } catch (e) { return String(a).slice(0, 2000); }
    };
    const captureLog = (line) => {
      if (logs.length >= 100 || logChars >= 32768) return;
      const text = line.slice(0, Math.min(2000, 32768 - logChars));
      logs.push(text);
      logChars += text.length;
    };
    const capture = {
      log(...a) { captureLog(a.map(fmt).join(" ")); },
      info(...a) { captureLog(a.map(fmt).join(" ")); },
      warn(...a) { captureLog("WARN: " + a.map(fmt).join(" ")); },
      error(...a) { captureLog("ERROR: " + a.map(fmt).join(" ")); },
    };
    const id = new Proxy({}, {
      get(t, name) {
        if (name === "then") return undefined;
        const tool = String(name);
        return async (args) => {
          if (toolCalls.length >= 50) throw new Error("execute tool-call limit reached");
          const t0 = Date.now();
          try {
            const r = await ID.callTool(tool, args || {});
            toolCalls.push({ tool, ms: Date.now() - t0 });
            return r;
          } catch (e) {
            toolCalls.push({ tool, ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 500) });
            throw e;
          }
        };
      },
    });
    let outcome;
    try {
      const value = await run(id, capture);
      let out = null;
      try {
        const serialized = JSON.stringify(value);
        if (serialized && serialized.length > 32768) throw new Error("result too large");
        out = serialized === undefined ? null : JSON.parse(serialized);
      } catch (e) { out = "[result omitted: not serializable or too large]"; }
      outcome = { ok: true, value: out, logs, toolCalls };
    } catch (e) {
      outcome = { ok: false, error: String((e && e.message) || e).slice(0, 2000), logs, toolCalls };
    }
    return outcome;
  }
}
`;

function schemaToTs(schema: Record<string, unknown>, indent = ""): string {
  const t = schema.type;
  if (t === "string") {
    return Array.isArray(schema.enum)
      ? schema.enum.map((e) => JSON.stringify(e)).join(" | ")
      : "string";
  }
  if (t === "number" || t === "integer") return "number";
  if (t === "boolean") return "boolean";
  if (t === "array") {
    return `(${isRecord(schema.items) ? schemaToTs(schema.items, indent) : "unknown"})[]`;
  }
  if (t === "object" || isRecord(schema.properties)) {
    const props = isRecord(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const lines = Object.entries(props).map(([k, v]) => {
      const prop = isRecord(v) ? v : {};
      const opt = required.has(k) ? "" : "?";
      const desc = typeof prop.description === "string" ? ` /** ${prop.description} */` : "";
      return `${indent}  ${k}${opt}: ${schemaToTs(prop, indent + " ")};${desc}`;
    });
    return `{\n${lines.join("\n")}\n${indent}}`;
  }
  return "unknown";
}

function toolDeclarations(): string {
  return TOOLS.filter((t) => t.name !== "execute")
    .map((t) => {
      const args = schemaToTs(t.inputSchema);
      return `/** ${t.description}${t.write ? "" : " (read-only)"} */\n${t.name}(args: ${args}): Promise<any>;`;
    })
    .join("\n\n");
}

const EXECUTE_TOOL: ToolDef = {
  name: "execute",
  write: false,
  description:
    "Run JavaScript in an isolated sandbox with a typed `id` proxy for every IdP tool. " +
    "Write one async snippet: `const users = await id.users_list({}); return users.filter(u => !u.passkeys)`. " +
    "Chain calls, filter in code — only your return value comes back. No network, no env. Max 200KB code, 10s, 50 tool calls.\n\n" +
    "Available tools:\n```ts\n" +
    toolDeclarations() +
    "\n```",
  inputSchema: obj(
    {
      code: {
        type: "string",
        description: "JS statements using `id` and `console`; `return` the result.",
      },
    },
    ["code"],
  ),
  handler: async () => {
    throw new Error("execute runs through the sandbox runner");
  },
};
TOOLS.push(EXECUTE_TOOL);

interface ToolCallLog {
  tool: string;
  ms: number;
  error?: string;
}

interface Outcome {
  ok: boolean;
  value?: unknown;
  error?: string;
  logs: unknown[];
  toolCalls: ToolCallLog[];
}

function parseOutcome(v: unknown): Outcome {
  if (!isRecord(v))
    return { ok: false, error: "sandbox returned nothing", logs: [], toolCalls: [] };
  const calls = Array.isArray(v.toolCalls) ? v.toolCalls : [];
  return {
    ok: v.ok === true,
    value: v.value,
    ...(typeof v.error === "string" ? { error: v.error } : {}),
    logs: Array.isArray(v.logs) ? v.logs : [],
    toolCalls: calls.flatMap((tc: unknown) =>
      isRecord(tc) && typeof tc.tool === "string" && typeof tc.ms === "number"
        ? [
            {
              tool: tc.tool,
              ms: tc.ms,
              ...(typeof tc.error === "string" ? { error: tc.error } : {}),
            },
          ]
        : [],
    ),
  };
}

type AgentEntrypoint = WorkerEntrypoint & { run(): Promise<unknown> };

export async function runExecute(
  env: Env,
  ctx: WaitCtx & { exports?: unknown },
  code: string,
  auth: McpAuth,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const started = Date.now();
  const fail = (text: string) => {
    trackCall(ctx, env.DB, "execute", started, text.slice(0, 200), auth.tokenId);
    return { content: [{ type: "text", text }], isError: true };
  };
  if (!code.trim()) return fail("Error: code is required.");
  if (code.length > 200_000) return fail("Error: code exceeds 200KB.");
  if (!env.LOADER)
    return fail("Error: the code-execution sandbox is not configured on this worker.");
  const exportsObj = ctx.exports;
  const sandboxExport = isRecord(exportsObj) ? exportsObj.IdCodeSandbox : undefined;
  if (typeof sandboxExport !== "function") return fail("Error: sandbox entrypoint unavailable.");
  let worker: WorkerStub;
  try {
    const props: SandboxProps = {
      adminId: auth.adminId,
      readOnly: auth.readOnly,
      tokenId: auth.tokenId,
      issuer: env.ISSUER,
    };
    const idStub: unknown = Reflect.apply(sandboxExport, undefined, [{ props }]);
    worker = env.LOADER.load({
      compatibilityDate: "2026-10-06",
      mainModule: "bootstrap.js",
      modules: {
        "bootstrap.js": ID_SANDBOX_BOOTSTRAP,
        "user-code.js": `export async function run(id, console) {\n${code}\n}`,
      },
      env: { ID: idStub },
      globalOutbound: null,
    });
  } catch (e) {
    return fail("Error: failed to start sandbox: " + errMessage(e).slice(0, 300));
  }
  let result: unknown;
  try {
    const entry = worker.getEntrypoint<AgentEntrypoint>("Agent", {
      limits: { cpuMs: 1000, subRequests: 50 },
    });
    const run: Promise<unknown> = Promise.resolve(entry.run());
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("execution timed out after 10s")), 10000);
    });
    try {
      result = await Promise.race([run, timeout]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  } catch (e) {
    return fail("Error: " + errMessage(e).slice(0, 500));
  }
  const r = parseOutcome(result);
  for (const tc of r.toolCalls) {
    trackCall(ctx, env.DB, tc.tool, Date.now() - tc.ms, tc.error ?? null, auth.tokenId);
  }
  if (!r.ok) return fail(`Error: ${r.error ?? "unknown error"}`);
  trackCall(ctx, env.DB, "execute", started, null, auth.tokenId);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ value: r.value, logs: r.logs, toolCalls: r.toolCalls }, null, 2),
      },
    ],
  };
}
