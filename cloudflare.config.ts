import { bindings, defineConfig, triggers } from "cf/config";

const STAGES = {
  production: {
    name: "identity",
    issuer: "https://auth.johnson.network",
    d1: { name: "identity", id: "832a3094-2375-47b8-aa06-7f146c56eb25" },
    route: { pattern: "auth.johnson.network/*", zone: "johnson.network" },
    previewUrls: true,
    limiters: { auth: "1001", api: "1002" },
  },
  staging: {
    name: "identity-staging",
    issuer: "https://identity-staging.twj.workers.dev",
    d1: { name: "identity-staging", id: "ec5d745d-3e6d-47d8-aa7f-a6026b3a2f5e" },
    route: null,
    previewUrls: false,
    limiters: { auth: "2001", api: "2002" },
  },
} as const;

export default defineConfig(({ mode }) => {
  const stage = mode === "staging" ? STAGES.staging : STAGES.production;
  return {
    accountId: "83c27d7f9b8764a53148888203d434cb",
    worker: {
      name: stage.name,
      compatibilityDate: "2026-10-06",
      compatibilityFlags: ["nodejs_compat"],
      entrypoint: "src/index.tsx",
      observability: { enabled: true },
      workersDev: true,
      previewUrls: stage.previewUrls,
      triggers: [
        ...(stage.route ? [triggers.fetch(stage.route)] : []),
        triggers.scheduled({ schedule: "17 * * * *" }),
      ],
      env: {
        ISSUER: bindings.text(stage.issuer),
        RP_NAME: bindings.text("Johnson ID"),
        SIGNING_KEY_JWK: bindings.secret(),
        DB: bindings.d1(stage.d1),
        AUTH_LIMITER: bindings.rateLimit({
          namespace: stage.limiters.auth,
          simple: { limit: 30, period: 60 },
        }),
        API_LIMITER: bindings.rateLimit({
          namespace: stage.limiters.api,
          simple: { limit: 300, period: 60 },
        }),
        LOADER: bindings.workerLoader(),
      },
    },
  };
});
