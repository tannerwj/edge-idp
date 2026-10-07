import { expect, test } from 'e2e';
import { base, getJson, records } from './http';

test('discovery document is well-formed', async () => {
  const { status, body: doc } = await getJson('/.well-known/openid-configuration');
  expect(status).toBe(200);
  expect(doc.issuer).toBe(base);
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
  const { status, body } = await getJson('/jwks');
  expect(status).toBe(200);
  const [key] = records(body.keys);
  expect(key?.kty).toBe('RSA');
  expect(key?.alg).toBe('RS256');
  expect(key?.use).toBe('sig');
  expect(typeof key?.kid).toBe('string');
  expect(typeof key?.n).toBe('string');
  expect(typeof key?.e).toBe('string');
});

test('jwks alias path serves the same key', async () => {
  const { status, body } = await getJson('/.well-known/jwks.json');
  expect(status).toBe(200);
  expect(records(body.keys)[0]?.kid).toBeDefined();
});

test('OAuth metadata advertises what MCP clients need', async () => {
  const { status, body: doc } = await getJson('/.well-known/oauth-authorization-server');
  expect(status).toBe(200);
  expect(doc.issuer).toBe(base);
  // claude.ai only uses CIMD when BOTH of these are present.
  expect(doc.client_id_metadata_document_supported).toBe(true);
  expect(doc.token_endpoint_auth_methods_supported).toContain('none');
  expect(doc.grant_types_supported).toContain('refresh_token');
  expect(doc.scopes_supported).toContain('offline_access');
  expect(doc.registration_endpoint).toBe(`${base}/register`);
  expect(doc.authorization_response_iss_parameter_supported).toBe(true);
});

test('protected resource metadata names this server for /mcp', async () => {
  const { body: prm } = await getJson('/.well-known/oauth-protected-resource/mcp');
  expect(prm.resource).toBe(`${base}/mcp`);
  expect(prm.authorization_servers).toEqual([base]);
});
