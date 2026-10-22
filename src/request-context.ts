import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "./config";

export interface RequestScope {
  env: Env;
  wait(p: Promise<unknown>): void;
}

const scope = new AsyncLocalStorage<RequestScope>();

export function withScope<T>(s: RequestScope, fn: () => T): T {
  return scope.run(s, fn);
}

export function currentScope(): RequestScope | undefined {
  return scope.getStore();
}
