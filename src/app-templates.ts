export const CLIENT_SECRET = "${CLIENT_SECRET}";
const SCOPES = "openid profile email groups";

export interface ConnectInfo {
  issuer: string;
  clientId: string;
  baseUrl: string;
}

export interface AppConfig {
  api?: { method: "PUT" | "POST" | "PATCH"; path: string; body: unknown };
  env?: Record<string, string>;
  fields?: Record<string, string>;
}

export interface AppTemplate {
  id: string;
  name: string;
  icon: string;
  docs: string;
  pkce: boolean;
  apply: "api" | "env" | "ui";
  redirects: (baseUrl: string) => string[];
  config: (i: ConnectInfo) => AppConfig;
  notes: string[];
}

const discovery = (issuer: string) => `${issuer}/.well-known/openid-configuration`;

const GRAFANA_ROLES =
  "contains(roles[*], 'admin') && 'Admin' || contains(roles[*], 'writer') && 'Editor' || 'Viewer'";

const grafana: AppTemplate = {
  id: "grafana",
  name: "Grafana",
  icon: "📈",
  docs: "https://grafana.com/docs/grafana/latest/setup-grafana/configure-access/configure-authentication/generic-oauth/",
  pkce: true,
  apply: "env",
  redirects: (b) => [`${b}/login/generic_oauth`],
  config: (i) => {
    const s = {
      enabled: true,
      name: "Johnson ID",
      clientId: i.clientId,
      clientSecret: CLIENT_SECRET,
      scopes: SCOPES,
      authUrl: `${i.issuer}/authorize`,
      tokenUrl: `${i.issuer}/token`,
      apiUrl: `${i.issuer}/userinfo`,
      usePkce: true,
      autoLogin: true,
      allowSignUp: true,
      emailAttributePath: "email",
      loginAttributePath: "preferred_username",
      nameAttributePath: "name",
      roleAttributePath: GRAFANA_ROLES,
      roleAttributeStrict: false,
    };
    return {
      api: { method: "PUT", path: "/api/v1/sso-settings/generic_oauth", body: { settings: s } },
      env: {
        GF_SERVER_ROOT_URL: `${i.baseUrl}/`,
        GF_AUTH_GENERIC_OAUTH_ENABLED: "true",
        GF_AUTH_GENERIC_OAUTH_NAME: s.name,
        GF_AUTH_GENERIC_OAUTH_CLIENT_ID: s.clientId,
        GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
        GF_AUTH_GENERIC_OAUTH_SCOPES: s.scopes,
        GF_AUTH_GENERIC_OAUTH_AUTH_URL: s.authUrl,
        GF_AUTH_GENERIC_OAUTH_TOKEN_URL: s.tokenUrl,
        GF_AUTH_GENERIC_OAUTH_API_URL: s.apiUrl,
        GF_AUTH_GENERIC_OAUTH_USE_PKCE: "true",
        GF_AUTH_GENERIC_OAUTH_AUTO_LOGIN: "true",
        GF_AUTH_GENERIC_OAUTH_ALLOW_SIGN_UP: "true",
        GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH: GRAFANA_ROLES,
      },
    };
  },
  notes: [
    "Usually applied as container environment: Grafana builds its redirect URI from root_url, which must equal the base URL and can only be set in server config, so GF_SERVER_ROOT_URL is required and a restart follows.",
    "The SSO settings API (the api block) needs a Grafana server admin signing in with basic auth; service account tokens are org-level and get 403. GF_AUTH_GENERIC_OAUTH_* environment variables override API settings.",
    "Roles map admin → Admin, writer → Editor, anything else → Viewer. /login?disableAutoLogin=true still reaches the local login form.",
  ],
};

const openWebui: AppTemplate = {
  id: "open-webui",
  name: "Open WebUI",
  icon: "💬",
  docs: "https://docs.openwebui.com/features/auth/sso/",
  pkce: false,
  apply: "env",
  redirects: (b) => [`${b}/oauth/oidc/callback`],
  config: (i) => ({
    env: {
      WEBUI_URL: i.baseUrl,
      ENABLE_OAUTH_PERSISTENT_CONFIG: "false",
      OAUTH_CLIENT_ID: i.clientId,
      OAUTH_CLIENT_SECRET: CLIENT_SECRET,
      OPENID_PROVIDER_URL: discovery(i.issuer),
      OPENID_REDIRECT_URI: `${i.baseUrl}/oauth/oidc/callback`,
      OAUTH_PROVIDER_NAME: "Johnson ID",
      OAUTH_SCOPES: SCOPES,
      ENABLE_OAUTH_SIGNUP: "true",
      OAUTH_MERGE_ACCOUNTS_BY_EMAIL: "true",
      ENABLE_OAUTH_ROLE_MANAGEMENT: "true",
      OAUTH_ROLES_CLAIM: "roles",
      OAUTH_ALLOWED_ROLES: "admin,writer,reader",
      OAUTH_ADMIN_ROLES: "admin",
    },
  }),
  notes: [
    "Restart the container after changing the environment. WEBUI_URL must be set or OAuth sign-in fails; ENABLE_OAUTH_PERSISTENT_CONFIG=false keeps these variables in charge over settings saved in the database.",
    "OAUTH_MERGE_ACCOUNTS_BY_EMAIL links an existing local account only when its email equals the Johnson ID email; change the local email first if they differ.",
    "Confidential client authenticated by its secret; PKCE is off for this template.",
    "Anyone with access but no role is refused by Open WebUI; grant admin, writer or reader.",
    "Set ENABLE_LOGIN_FORM=false once Johnson ID sign-in works to hide local passwords.",
  ],
};

const immich: AppTemplate = {
  id: "immich",
  name: "Immich",
  icon: "🖼️",
  docs: "https://docs.immich.app/administration/oauth",
  pkce: false,
  apply: "ui",
  redirects: (b) => [`${b}/auth/login`, `${b}/user-settings`, "app.immich:///oauth-callback"],
  config: (i) => ({
    fields: {
      "Issuer URL": i.issuer,
      "Client ID": i.clientId,
      "Client Secret": CLIENT_SECRET,
      Scope: SCOPES,
      "Signing Algorithm": "RS256",
      "Button Text": "Sign in with Johnson ID",
      "Auto Register": "on",
      "Auto Launch": "on",
    },
  }),
  notes: [
    "Administration → Settings → Authentication Settings → OAuth.",
    "Immich reads its role from a single immich_role claim, so admins are still managed inside Immich.",
  ],
};

const paperless: AppTemplate = {
  id: "paperless-ngx",
  name: "Paperless-ngx",
  icon: "📄",
  docs: "https://docs.paperless-ngx.com/advanced_usage/#openid-connect-and-social-authentication",
  pkce: true,
  apply: "env",
  redirects: (b) => [`${b}/accounts/oidc/johnson-id/login/callback/`],
  config: (i) => ({
    env: {
      PAPERLESS_APPS: "allauth.socialaccount.providers.openid_connect",
      PAPERLESS_SOCIALACCOUNT_PROVIDERS: JSON.stringify({
        openid_connect: {
          APPS: [
            {
              provider_id: "johnson-id",
              name: "Johnson ID",
              client_id: i.clientId,
              secret: CLIENT_SECRET,
              settings: {
                server_url: i.issuer,
                token_auth_method: "client_secret_basic",
                oauth_pkce_enabled: true,
              },
            },
          ],
        },
      }),
      PAPERLESS_SOCIAL_AUTO_SIGNUP: "true",
      PAPERLESS_REDIRECT_LOGIN_TO_SSO: "true",
    },
  }),
  notes: ["Restart the container after changing the environment."],
};

const litellm: AppTemplate = {
  id: "litellm",
  name: "LiteLLM",
  icon: "🧠",
  docs: "https://docs.litellm.ai/docs/proxy/admin_ui_sso",
  pkce: false,
  apply: "env",
  redirects: (b) => [`${b}/sso/callback`],
  config: (i) => ({
    env: {
      PROXY_BASE_URL: i.baseUrl,
      GENERIC_CLIENT_ID: i.clientId,
      GENERIC_CLIENT_SECRET: CLIENT_SECRET,
      GENERIC_AUTHORIZATION_ENDPOINT: `${i.issuer}/authorize`,
      GENERIC_TOKEN_ENDPOINT: `${i.issuer}/token`,
      GENERIC_USERINFO_ENDPOINT: `${i.issuer}/userinfo`,
      GENERIC_SCOPE: SCOPES,
      GENERIC_USER_ID_ATTRIBUTE: "sub",
      GENERIC_USER_EMAIL_ATTRIBUTE: "email",
      GENERIC_USER_DISPLAY_NAME_ATTRIBUTE: "name",
    },
  }),
  notes: [
    "Admin UI sign-in only; API keys are unaffected. LiteLLM's SSO is free for up to 5 users.",
    "LiteLLM roles come from its own names (proxy_admin, internal_user, …), so set PROXY_ADMIN_ID to the admin's Johnson ID user id (the sub claim); everyone else gets LiteLLM's default internal user role.",
    "Restart the container after changing the environment. UI_USERNAME/UI_PASSWORD keep working as a fallback until disable_env_credential_login is set.",
  ],
};

const generic: AppTemplate = {
  id: "generic",
  name: "Any OIDC app",
  icon: "🔑",
  docs: "https://openid.net/specs/openid-connect-discovery-1_0.html",
  pkce: true,
  apply: "ui",
  redirects: () => [],
  config: (i) => ({
    fields: {
      "Discovery URL": discovery(i.issuer),
      Issuer: i.issuer,
      "Authorization endpoint": `${i.issuer}/authorize`,
      "Token endpoint": `${i.issuer}/token`,
      "Userinfo endpoint": `${i.issuer}/userinfo`,
      "JWKS URI": `${i.issuer}/jwks`,
      "Client ID": i.clientId,
      "Client secret": CLIENT_SECRET,
      Scopes: SCOPES,
      "Roles claim": "roles (array: admin, writer, reader or the app's own names)",
    },
  }),
  notes: ["Pass redirect_uris: the app's OAuth callback URL(s), exactly as the app sends them."],
};

export const TEMPLATES: AppTemplate[] = [grafana, openWebui, litellm, immich, paperless, generic];

export function templateById(id: string): AppTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
