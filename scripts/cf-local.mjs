import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export function stageConfig(stage = "production", configPath = "cloudflare.config.ts") {
  const src = readFileSync(configPath, "utf8");
  const start = src.indexOf(`\n  ${stage}: {`);
  if (start < 0) throw new Error(`no stage "${stage}" in ${configPath}`);
  const block = src.slice(start, src.indexOf("\n  },", start));
  const pick = (re) => {
    const m = re.exec(block);
    if (!m) throw new Error(`stage "${stage}" in ${configPath} is missing ${re}`);
    return m[1];
  };
  return {
    stage,
    name: pick(/\bname:\s*"([^"]+)"/),
    issuer: pick(/\bissuer:\s*"([^"]+)"/),
    d1Id: pick(/\bd1:\s*\{[^}]*\bid:\s*"([^"]+)"/),
  };
}

export function d1Id(stage = "production") {
  return stageConfig(stage).d1Id;
}

export function stageArg(argv = process.argv) {
  const m = argv.map((a) => /^--stage=(.+)$/.exec(a)).find(Boolean);
  return m ? m[1] : "production";
}

export function stopGroup(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const hard = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 5000);
    child.once("exit", () => {
      clearTimeout(hard);
      resolve();
    });
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      clearTimeout(hard);
      resolve();
    }
  });
}

export function cfJson(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["cf", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let out = "";
    let err = "";
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void stopGroup(child).then(() => fn(v));
    };
    const tryParse = () => {
      const start = out.search(/[[{]/);
      if (start < 0) return;
      try {
        finish(resolve, JSON.parse(out.slice(start)));
      } catch {}
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`cf ${args.join(" ")} timed out\n${err.slice(-2000)}`)),
      timeoutMs,
    );
    child.stdout.on("data", (d) => {
      out += d;
      tryParse();
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => {
      tryParse();
      if (!done)
        finish(
          code === 0 ? resolve : reject,
          code === 0 ? null : new Error(`cf ${args.join(" ")} exited ${code}\n${err.slice(-2000)}`),
        );
    });
  });
}

export function migrateLocal(persistTo) {
  return cfJson([
    "d1",
    "migrations",
    "apply",
    d1Id(),
    "--local",
    ...(persistTo ? ["--persist-to", persistTo] : []),
  ]);
}

export async function sqlRows(sql, { local = true, persistTo, stage = "production" } = {}) {
  const res = await cfJson([
    "d1",
    "raw",
    d1Id(stage),
    "--sql",
    sql,
    "--mode",
    stage,
    ...(local ? ["--local"] : []),
    ...(local && persistTo ? ["--persist-to", persistTo] : []),
  ]);
  const last = Array.isArray(res) ? res[res.length - 1] : res;
  const { columns = [], rows = [] } = last?.results ?? {};
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}
