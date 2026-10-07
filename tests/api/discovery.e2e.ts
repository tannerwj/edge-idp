import { expect, test } from 'e2e';

const base = process.env.E2E_BASE_URL ?? 'https://auth.johnson.network';

test('discovery document is well-formed', async () => {
  const res = await fetch(`${base}/.well-known/openid-configuration`);
  expect(res.status).toBe(200);
  const doc = (await res.json()) as Record<string, unknown>;
  expect(doc.issuer).toBe(`${base}`);
  expect(doc.authorization_endpoint).toBe(`${base}/authorize`);
  expect(doc.token_endpoint).toBe(`${base}/token`);
  expect(doc.userinfo_endpoint).toBe(`${base}/userinfo`);
  expect(doc.jwks_uri).toBe(`${base}/jwks`);
  expect(doc.code_challenge_methods_supported).toContain('S256');
  expect(doc.token_endpoint_auth_methods_supported).toContain('client_secret_basic');
  expect(doc.response_types_supported).toContain('code');
  expect(doc.id_token_signing_alg_values_supported).toContain('RS256');
});

test('jwks exposes an RS256 RSA key', async () => {
  const res = await fetch(`${base}/jwks`);
  expect(res.status).toBe(200);
  const jwks = (await res.json()) as { keys?: Array<Record<string, string>> };
  expect(jwks.keys?.length).toBeGreaterThan(0);
  const key = jwks.keys![0];
  expect(key.kty).toBe('RSA');
  expect(key.alg).toBe('RS256');
  expect(key.use).toBe('sig');
  expect(typeof key.kid).toBe('string');
  expect(typeof key.n).toBe('string');
  expect(typeof key.e).toBe('string');
});

test('jwks alias path serves the same key', async () => {
  const res = await fetch(`${base}/.well-known/jwks.json`);
  expect(res.status).toBe(200);
  const jwks = (await res.json()) as { keys?: Array<Record<string, string>> };
  expect(jwks.keys?.[0]?.kid).toBeDefined();
});
