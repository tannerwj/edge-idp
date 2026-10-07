import type { Context } from "hono";
import type { Env } from "../config";
import type { User } from "../db";
import { OpError } from "../ops";
import { AppShell, setFlash, uiFor } from "../ui/layout";
import type { Crumb } from "../ui/layout";

export type AdminVars = { Bindings: Env; Variables: { admin: User } };
export type ACtx = Context<AdminVars>;

export function field(
  form: Record<string, string | File | (string | File)[] | undefined>,
  key: string,
): string {
  const v = form[key];
  return typeof v === "string" ? v : "";
}

export function fields(
  form: Record<string, string | File | (string | File)[] | undefined>,
  key: string,
): string[] {
  const v = form[key];
  const list = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return list.filter((x): x is string => typeof x === "string");
}

export function actor(c: ACtx) {
  return { adminId: c.get("admin").id, via: "ui" as const };
}

export async function page(
  c: ACtx,
  opts: { active: string; title: string; crumbs?: Crumb[]; narrow?: boolean; page?: string },
  children: unknown,
) {
  const a = c.get("admin");
  return c.html(
    <AppShell
      ui={await uiFor(c)}
      viewer={{ id: a.id, name: a.name, email: a.email, isAdmin: true }}
      active={opts.active}
      title={opts.title}
      crumbs={opts.crumbs}
      narrow={opts.narrow}
      page={opts.page}
      flash={c.req.query("ok")}
    >
      {children}
    </AppShell>,
  );
}

export async function act(
  c: ACtx,
  back: string,
  ok: string,
  fn: () => Promise<unknown>,
): Promise<Response> {
  try {
    await fn();
    setFlash(c, ok, "ok");
  } catch (e) {
    if (!(e instanceof OpError)) throw e;
    setFlash(c, e.message, "bad");
  }
  return c.redirect(back, 303);
}
