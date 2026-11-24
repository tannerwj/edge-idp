import { bindings, defineConfig, triggers } from "cf/config";

import { deployment } from "./scripts/deployment.mjs";

const STAGES = {
  production: {
    name: "identity",
    issuer: "https://auth.example.com",
    d1: { name: "identity", id: "832a3094-2375-47b8-aa06-7f146c56eb25" },
    route: { pattern: "auth.example.com/*", zone: "example.com" },
    previewUrls: false,
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

function consoleOrigin(stage: "staging" | "production") {
  if (deployment.maintainerAccess?.[stage]) return undefined;
  return deployment.maintainerConsole?.[stage];
}

export default defineConfig(({ mode }) => {
  const staging = mode === "staging" || mode === "maintainer-staging";
  const stageName = staging ? "staging" : "production";
  const stage = { ...STAGES[stageName], ...deployment.stages?.[stageName] };
  const origin = consoleOrigin(stageName);
  if (mode === "maintainer" || mode === "maintainer-staging") {
    const access = deployment.maintainerAccess?.[stageName];
    const name = staging ? "edge-idp-feedback-staging" : "edge-idp-feedback";
    return {
      accountId: deployment.accountId ?? "00000000000000000000000000000000",
      worker: {
        name,
        entrypoint: "src/maintainer/index.tsx",
        compatibilityDate: "2026-10-06",
        previewUrls: false,
        workersDev: false,
        domains: [
          staging ? "edge-idp-feedback-staging.tannerwj.dev" : "edge-idp-feedback.tannerwj.dev",
          ...(deployment.receiverAliases?.[stageName] ?? []),
        ],
        env: {
          DB: bindings.d1({ name }),
          ...(access
            ? {
                CONSOLE_AUD: bindings.text(access.consoleAudience),
                AGENT_AUD: bindings.text(access.agentAudience),
              }
            : {
                AUTHORITY: bindings.worker({
                  worker: stage.name,
                  exportName: "MaintainerAuthority",
                }),
              }),
          INTAKE_LIMITER: bindings.rateLimit({
            namespace: staging ? "3002" : "3001",
            simple: { limit: 30, period: 60 },
          }),
        },
      },
    };
  }
  return {
    accountId: deployment.accountId ?? "00000000000000000000000000000000",
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
        RP_NAME: bindings.text(deployment.name ?? "Identity"),
        SIGNING_KEY_JWK: bindings.secret(),
        SETUP_TOKEN: bindings.secret(),
        DB: bindings.d1(stage.d1),
        ...(origin ? { MAINTAINER_CONSOLE_URL: bindings.text(origin) } : {}),
        ...(mode === "staging"
          ? {
              FEEDBACK_INBOX_URL: bindings.text("https://edge-idp-feedback-staging.tannerwj.dev"),
            }
          : {}),
        AUTH_LIMITER: bindings.rateLimit({
          namespace: stage.limiters.auth,
          simple: { limit: 30, period: 60 },
        }),
        API_LIMITER: bindings.rateLimit({
          namespace: stage.limiters.api,
          simple: { limit: 300, period: 60 },
        }),
        LOADER: bindings.workerLoader(),
        EMAIL: bindings.sendEmail(),
      },
    },
  };
});
