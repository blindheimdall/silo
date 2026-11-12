// Single sign-on with OpenID Connect: Microsoft Entra ID, Google Workspace, Okta, Auth0, Keycloak, authentik and
// any other provider with discovery. Authorization code with PKCE, a nonce and a state bound to the browser.
// The id_token is checked here: signature against the provider's published keys, issuer, audience, time, nonce.
import crypto from 'node:crypto';

const err = (message, status = 400) => Object.assign(new Error(message), { status });
const b64u = b => Buffer.from(b).toString('base64url');
export const SSO_ROLES = ['owner', 'operator', 'viewer'];

// https, or plain http only for a provider on this computer (a test or a local Keycloak).
export function checkIssuer(issuer) {
  let u; try { u = new URL(String(issuer || '').trim()); } catch { throw err('Write the issuer address, like https://login.microsoftonline.com/<tenant>/v2.0.'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw err('The issuer needs an https address.');
  if (u.search || u.hash || u.username) throw err('The issuer address has no query, fragment or credentials.');
  return u.href.replace(/\/$/, '');
}
async function getJson(url, what) {
  let r; try { r = await fetch(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
  catch (e) { throw err(`${what} cannot be reached: ${e.cause?.code || e.message}.`, 502); }
  if (!r.ok) throw err(`${what} answered ${r.status}.`, 502);
  const text = await r.text(); if (text.length > 500000) throw err(`${what} sent too much.`, 502);
  try { return JSON.parse(text); } catch { throw err(`${what} did not send JSON.`, 502); }
}
const cache = new Map();
export function clearSsoCache() { cache.clear(); }
// The provider's settings from /.well-known/openid-configuration. Kept for an hour.
export async function discover(issuer) {
  const iss = checkIssuer(issuer), hit = cache.get('d:' + iss);
  if (hit && Date.now() - hit.at < 3600000) return hit.v;
  const m = await getJson(iss + '/.well-known/openid-configuration', 'The provider');
  if (String(m.issuer || '').replace(/\/$/, '') !== iss) throw err(`The provider calls itself ${String(m.issuer).slice(0, 120)}, not ${iss}. Use exactly that issuer.`, 502);
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) { if (!m[k]) throw err(`The provider gives no ${k}.`, 502); const u = new URL(m[k]); if (u.protocol !== 'https:' && !(u.protocol === 'http:' && new URL(iss).protocol === 'http:')) throw err(`The provider's ${k} is not https.`, 502); }
  if (m.response_types_supported && !m.response_types_supported.includes('code')) throw err('The provider does not offer the authorization code flow.', 502);
  cache.set('d:' + iss, { at: Date.now(), v: m });
  return m;
}
// The keys the provider signs with. Asked again when a token names a key not seen yet, at most once a minute.
async function keyFor(meta, kid, alg) {
  const k = 'j:' + meta.jwks_uri; let hit = cache.get(k);
  const find = () => (hit?.v.keys || []).filter(j => (!kid || j.kid === kid) && (!j.use || j.use === 'sig') && (!j.alg || j.alg === alg));
  if (!hit || Date.now() - hit.at > 3600000 || !find().length && Date.now() - hit.at > 60000) { hit = { at: Date.now(), v: await getJson(meta.jwks_uri, 'The provider keys') }; cache.set(k, hit); }
  const found = find(); if (found.length !== 1) throw err(found.length ? 'The provider has more than one key that fits this token.' : 'The token is signed with a key the provider does not publish.', 401);
  try { return crypto.createPublicKey({ key: found[0], format: 'jwk' }); } catch { throw err('The provider key cannot be read.', 502); }
}
const ALGS = { RS256: ['sha256'], RS384: ['sha384'], RS512: ['sha512'], PS256: ['sha256', 'pss'], PS384: ['sha384', 'pss'], PS512: ['sha512', 'pss'], ES256: ['sha256', 'ec'], ES384: ['sha384', 'ec'], ES512: ['sha512', 'ec'], EdDSA: [null] };
export async function verifyIdToken(token, { meta, issuer, clientId, nonce, now = Date.now(), skew = 120 }) {
  const parts = String(token || '').split('.'); if (parts.length !== 3) throw err('The provider did not send a valid id_token.', 401);
  let head, claims; try { head = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw err('The id_token cannot be read.', 401); }
  const a = ALGS[head.alg]; if (!a) throw err(`The id_token uses ${String(head.alg).slice(0, 20)}, which SILO does not accept.`, 401);
  const key = await keyFor(meta, head.kid, head.alg), data = Buffer.from(parts[0] + '.' + parts[1]), sig = Buffer.from(parts[2], 'base64url');
  const opts = a[1] === 'pss' ? { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST } : a[1] === 'ec' ? { key, dsaEncoding: 'ieee-p1363' } : key;
  let ok = false; try { ok = crypto.verify(a[0], data, opts, sig); } catch {}
  if (!ok) throw err('The id_token signature does not check out.', 401);
  const t = Math.floor(now / 1000), aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (String(claims.iss || '').replace(/\/$/, '') !== checkIssuer(issuer)) throw err('The id_token comes from another issuer.', 401);
  if (!aud.includes(clientId)) throw err('The id_token is for another application.', 401);
  if (aud.length > 1 && claims.azp && claims.azp !== clientId) throw err('The id_token was given to another application.', 401);
  if (!Number.isFinite(claims.exp) || claims.exp + skew < t) throw err('The id_token has expired. Sign in again.', 401);
  if (Number.isFinite(claims.nbf) && claims.nbf - skew > t) throw err('The id_token is not valid yet. Check the clock of this computer.', 401);
  if (!Number.isFinite(claims.iat) || claims.iat - skew > t || claims.iat + 86400 < t) throw err('The id_token has an odd issue time. Check the clock of this computer.', 401);
  if (!nonce || claims.nonce !== nonce) throw err('The sign-in does not match the one SILO started. Start again.', 401);
  if (!claims.sub) throw err('The id_token names no user.', 401);
  return claims;
}
export function pkce() { const verifier = b64u(crypto.randomBytes(32)); return { verifier, challenge: b64u(crypto.createHash('sha256').update(verifier).digest()) }; }
export function authUrl(meta, { clientId, redirectUri, state, nonce, challenge, scopes = '' }) {
  const u = new URL(meta.authorization_endpoint);
  const scope = [...new Set(['openid', 'email', 'profile', ...String(scopes).split(/[\s,]+/).filter(s => /^[\w.:/-]{1,100}$/.test(s))])].join(' ');
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope, state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' })) u.searchParams.set(k, v);
  return u.href;
}
export async function exchangeCode(meta, { clientId, clientSecret, code, redirectUri, verifier }) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier }), headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  const methods = meta.token_endpoint_auth_methods_supported || ['client_secret_basic'];
  if (clientSecret && methods.includes('client_secret_basic')) headers.Authorization = 'Basic ' + Buffer.from(encodeURIComponent(clientId) + ':' + encodeURIComponent(clientSecret)).toString('base64');
  else { body.set('client_id', clientId); if (clientSecret) body.set('client_secret', clientSecret); }
  let r; try { r = await fetch(meta.token_endpoint, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(15000) }); } catch (e) { throw err('The provider cannot be reached: ' + (e.cause?.code || e.message), 502); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id_token) throw err('The provider refused the sign-in' + (j.error ? `: ${String(j.error_description || j.error).slice(0, 200)}` : '.'), 401);
  return j;
}
// Who this is, in the words SILO uses.
export function identity(claims) {
  const email = String(claims.email || claims.preferred_username || claims.upn || '').trim().toLowerCase();
  return { sub: String(claims.sub), email: /^[^\s@]+@[^\s@]+$/.test(email) ? email : '', verified: claims.email_verified !== false && claims.email_verified !== 'false', name: String(claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || email.split('@')[0] || 'SSO user').slice(0, 80) };
}
export function domainAllowed(email, domains) {
  const list = (domains || []).map(d => String(d).trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  if (!list.length) return true;
  const d = String(email || '').split('@')[1] || '';
  return list.includes(d);
}
// The role a group claim gives. Owner wins over operator, operator over viewer. null when no group matches.
export function roleFromClaims(claims, { claim = 'groups', groups = {} } = {}) {
  let v = claim.split('.').reduce((o, k) => o?.[k], claims);
  const have = new Set((Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : []).map(x => String(x).toLowerCase()));
  for (const role of SSO_ROLES) if ((groups[role] || []).some(g => have.has(String(g).toLowerCase()))) return role;
  return null;
}
