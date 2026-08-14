// nulls-connect explorer — backend (zero dependencies, Node >= 18)
//
// Serves the app and exposes an internal API. The Null's Connect API sends no
// CORS headers, so ALL upstream traffic goes through this server.
//
// AUTH MODEL (mirrors the C client): a single bearer token obtained from
// /auth/login.v2 (email + PIN). The C client attaches it to every
// authenticated request as "Authorization: Bearer <token>". Here the token
// lives in a server-side session (HttpOnly cookie) and the centralized
// callUpstream() client attaches it AUTOMATICALLY to every request that
// requires auth — individual features can't forget it. Public endpoints
// (login, profile lookup, avatars) pass auth:false explicitly.
//
//   PORT                  listen port (Freebuff injects it; default 3000)
//   NC_API_UPSTREAM       override connect API base (default https://connect.nulls.gg/api)
//   NC_PROFILES_UPSTREAM  override profiles API base (default https://profiles.dnull.xyz)

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const API_UPSTREAM = (process.env.NC_API_UPSTREAM || "https://connect.nulls.gg/api").replace(/\/+$/, "");
const PROFILES_UPSTREAM = (process.env.NC_PROFILES_UPSTREAM || "https://profiles.dnull.xyz").replace(/\/+$/, "");
const FILES_UPSTREAM = "https://files.dnull.xyz";
const PORT = Number(process.env.PORT || 3000);
const SESSION_COOKIE = "nc_session";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_ACTIVITY = 80;
const MAX_BODY = 64 * 1024;
const DEFAULT_IMAGE_REF = "83a9523b-d954-4311-a62e-3ca8971403e1";

/* ------------------------------- error catalog ------------------------------ */

const ERROR_CATALOG = {
  email_flood_limit: { message: "Too many login attempts for this email — wait a bit and retry.", action: "Wait a few minutes, then try again." },
  pin_flood_limit: { message: "Too many PIN attempts — wait a bit and retry.", action: "Wait a few minutes, then request a fresh PIN." },
  email_invalid: { message: "The email address was rejected as invalid.", action: "Check the address and re-submit." },
  email_failed: { message: "The PIN email could not be delivered.", action: "Try again later or use a different address." },
  email_host_banned: { message: "The email provider is blocked by the service.", action: "Use an email provider the service accepts." },
  link_not_found: { message: "That account link does not exist.", action: "Verify the player id / link and retry." },
  link_not_available: { message: "That account cannot be linked right now.", action: "Try again later." },
  bind_not_available: { message: "That bind token is not available for linking.", action: "Generate a fresh bind token in the game client." },
  bind_limit_exceeded: { message: "Binding limit reached for this account.", action: "Remove an existing binding before linking more." },
  transfer_not_available: { message: "Transfer is not available for this account.", action: "Check the account settings — transfer may be disabled." },
  pin_invalid: { message: "Invalid PIN code.", action: "Re-check the 6-digit code from your email." },
  pin_expired: { message: "The PIN has expired.", action: "Request a new PIN email." },
  oauth_invalid_client_id: { message: "OAuth: unknown client_id.", action: "Verify the client_id." },
  oauth_invalid_redirect_uri: { message: "OAuth: redirect_uri does not match the client.", action: "Use the exact redirect_uri the client registered." },
  oauth_invalid_scope: { message: "OAuth: scope not allowed for this client.", action: "Request an allowed scope." },
  unknown_game: { message: "Unknown game identifier.", action: "This game value is not recognized — try another or a verified one." },
  game_change_not_allowed: { message: "The game cannot be changed for this account.", action: "Keep the original game for this binding." },
  profile_not_created: { message: "No profile exists for this account yet.", action: "Create a profile first." },
  account_not_found: { message: "Account not found.", action: "Check the identifier used for the lookup." },
  admin_parameters_contradiction: { message: "Admin: contradictory lookup parameters.", action: "Provide only one of uid / email / scid." },
  admin_account_not_found: { message: "Admin: account not found.", action: "Check the uid / email / scid." },
  admin_binding_duplicate: { message: "Admin: this binding already exists.", action: "The account is already bound to that player." },
  admin_binding_not_available: { message: "Admin: binding not available.", action: "The binding cannot be created right now." },
  admin_access_denied: { message: "Admin: this token has no admin access.", action: "Use a token with admin privileges." },
};

/* ---------------------------------- sessions ---------------------------------- */

const sessions = new Map(); // id -> { email, token, game, locale, authFailed, created, activity }

function parseCookie(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (raw) for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function setSessionCookie(res, id) {
  res.setHeader("set-cookie", `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`);
}

function ensureSession(req, res) {
  const id = parseCookie(req)[SESSION_COOKIE];
  let s = id ? sessions.get(id) : null;
  if (s && Date.now() - s.created > SESSION_TTL_MS) {
    sessions.delete(id);
    s = null;
  }
  if (!s) {
    const nid = randomBytes(24).toString("hex");
    s = { email: "", token: "", game: "laser", locale: "ru", authFailed: false, created: Date.now(), activity: [] };
    sessions.set(nid, s);
    setSessionCookie(res, nid);
  }
  return s;
}

/* ------------------------------- rate limiting ------------------------------- */

const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt < now) buckets.delete(k);
}, 10 * 60 * 1000).unref();

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt < now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return b.count <= limit;
}

const rl = (session, name, limit, windowMs) =>
  rateLimit(`s:${(session && session.token) ? session.token.slice(0, 16) : "anon"}:${name}`, limit, windowMs);

/* ---------------------------------- activity ---------------------------------- */

function maskString(s) {
  if (s.length <= 10) return "••••••";
  return s.slice(0, 6) + "••••••" + s.slice(-4);
}

function maskTokens(value) {
  if (Array.isArray(value)) return value.map(maskTokens);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /token|pin|secret|password|authorization|id_token/i.test(k) && typeof v === "string" ? maskString(v) : maskTokens(v);
    }
    return out;
  }
  return value;
}

function maskUrl(raw) {
  try {
    const u = new URL(raw);
    for (const k of ["token", "pin", "bind_token", "dest_token", "authorization", "id_token"]) {
      if (u.searchParams.has(k)) u.searchParams.set(k, maskString(u.searchParams.get(k)));
    }
    return u.origin === "null" ? u.pathname + u.search : u.pathname + u.search;
  } catch {
    return raw;
  }
}

function recordActivity(session, entry) {
  if (!session) return;
  session.activity.unshift({
    time: new Date().toISOString(),
    path: maskUrl(entry.internal),
    method: entry.method || "GET",
    auth: !!entry.auth,
    upstream: entry.upstream ? maskUrl(entry.upstream) : null,
    status: entry.status,
    ms: entry.ms,
    data: maskTokens(entry.data),
  });
  if (session.activity.length > MAX_ACTIVITY) session.activity.length = MAX_ACTIVITY;
}

/* -------------------------------- json helpers -------------------------------- */

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
const ok = (res, data) => json(res, 200, { ok: true, data });
const fail = (res, status, type, message, extra) =>
  json(res, status, { ok: false, error: { status, type, message, ...(extra || {}) } });

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) return null;
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* --------------------------------- validation --------------------------------- */

const isEmail = (s) => typeof s === "string" && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isPin = (s) => typeof s === "string" && /^\d{6}$/.test(s);
const isInt = (s) => typeof s === "string" && /^-?\d+$/.test(s);
const isUuid = (s) => typeof s === "string" && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);
const isTgIds = (s) => typeof s === "string" && /^[0-9]+(,[0-9]+)*$/.test(s);
const isUri = (s) => {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

/* ------------------------- CENTRALIZED AUTHENTICATED CLIENT ------------------------- */
/* Every upstream call goes through here. The session token is attached automatically
   unless auth:false is passed — public endpoints only. Mirrors the C client, which sets
   "Authorization: Bearer <token>" on every authenticated request. */

async function upstream(base, path, params, { method = "GET", token = null, body } = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== "" && v != null) qs.set(k, String(v));
  const url = base + path + (qs.size ? "?" + qs.toString() : "");
  const headers = { accept: "application/json", "user-agent": "nulls-connect-explorer/1.0" };
  if (token) headers.authorization = "Bearer " + token;
  const opts = { method, headers, redirect: "manual" };
  if (body !== undefined) {
    opts.body = typeof body === "string" ? body : JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const r = await fetch(url, opts);
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: r.status, data };
}

async function callUpstream(session, internalPath, base, upstreamPath, params, opts = {}) {
  // opts.token overrides the session token — used when an operation needs a
  // different credential (e.g. the per-player game token for profiles /update).
  const auth = opts.auth === false ? null : opts.token || session.token || null;
  const t0 = performance.now();
  const r = await upstream(base, upstreamPath, params, { method: opts.method, token: auth, body: opts.body });
  const ms = Math.round(performance.now() - t0);
  // A 403 on a non-admin authenticated endpoint means the token was rejected.
  // opts.noAuthFail suppresses that for calls where a 403 means a different kind
  // of denial (e.g. the profile API rejecting the freshly minted game token).
  if (auth && r.status === 403 && !internalPath.startsWith("/api/admin") && !opts.noAuthFail) session.authFailed = true;
  recordActivity(session, {
    internal: internalPath + (params ? "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null).map(([k, v]) => [k, String(v)])).toString() : ""),
    method: opts.method || "GET",
    auth: !!auth,
    upstream: base + upstreamPath + (params ? "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null).map(([k, v]) => [k, String(v)])).toString() : ""),
    status: r.status,
    ms,
    data: r.data,
  });
  return r;
}

function upError(res, r, session, context = "connect") {
  const d = r.data;
  const authFailed = !!(session && session.authFailed);
  if (r.status === 418 && d && typeof d === "object" && d.error_type) {
    const e = ERROR_CATALOG[d.error_type] || { message: `The API reported an error (${d.error_type}).`, action: "" };
    return fail(res, r.status, d.error_type, e.message, { action: e.action, authFailed });
  }
  if (r.status === 403) {
    return fail(
      res,
      403,
      authFailed ? "session_expired" : "forbidden",
      authFailed
        ? "Session expired — the API rejected the token. Reconnect to continue."
        : context === "connect"
          ? "The API rejected the token — it may be invalid or expired. Reconnect in the Session page."
          : "The profile API rejected the token — it may not be allowed to update profiles.",
      { action: "Reconnect with a fresh token.", authFailed }
    );
  }
  if (r.status === 422) return fail(res, 422, "validation_error", "The API rejected the parameters (validation error).", { action: "Check required parameters.", authFailed });
  return fail(res, r.status, "upstream_error", `Upstream error (HTTP ${r.status}).`, { authFailed });
}

function requireToken(session, res) {
  if (!session || !session.token) {
    const expired = !!(session && session.authFailed);
    fail(
      res,
      401,
      expired ? "session_expired" : "session_required",
      expired ? "Session expired — reconnect to continue." : "Not connected — log in or import a token first.",
      { action: "Go to Session and reconnect." }
    );
    return false;
  }
  return true;
}

/* -------------------------------- route handlers -------------------------------- */

async function login(req, res, session) {
  const ip = req.socket.remoteAddress || "unknown";
  if (!rateLimit(`ip:${ip}:login`, 5, 30000)) return fail(res, 429, "rate_limited", "Too many login attempts — wait 30 seconds.");
  const b = await readJsonBody(req);
  if (b === null) return fail(res, 400, "invalid_json", "Request body must be valid JSON.");
  const email = String(b.email || "").trim().toLowerCase();
  if (!isEmail(email)) return fail(res, 400, "bad_email", "Enter a valid email address.");
  const game = String(b.game || "laser").trim().toLowerCase() || "laser";
  const locale = String(b.locale || "ru").trim() || "ru";
  const params = { email, game, locale };
  if (b.can_register) params.can_register = "true";
  const r = await callUpstream(session, "/session/login", API_UPSTREAM, "/auth/login.v2", params, { auth: false });
  if (r.status === 200 && r.data && r.data.token) {
    session.token = r.data.token;
    session.email = email;
    session.game = game;
    session.locale = locale;
    session.authFailed = false;
    return ok(res, { authenticated: true, email });
  }
  if (r.status === 200 && r.data && r.data.pin_required) {
    session.email = email;
    session.game = game;
    session.locale = locale;
    return ok(res, { pin_required: true, email });
  }
  return upError(res, r, session);
}

async function confirmLogin(req, res, session) {
  const ip = req.socket.remoteAddress || "unknown";
  if (!rateLimit(`ip:${ip}:login`, 5, 30000)) return fail(res, 429, "rate_limited", "Too many login attempts — wait 30 seconds.");
  const b = await readJsonBody(req);
  if (b === null) return fail(res, 400, "invalid_json", "Request body must be valid JSON.");
  const email = String(b.email || "").trim().toLowerCase();
  const pin = String(b.pin || "").trim();
  if (!isEmail(email)) return fail(res, 400, "bad_email", "Enter a valid email address.");
  if (!isPin(pin)) return fail(res, 400, "bad_pin", "The PIN must be a 6-digit code.");
  const game = String(b.game || "laser").trim().toLowerCase() || "laser";
  const locale = String(b.locale || "ru").trim() || "ru";
  const r = await callUpstream(session, "/session/confirm", API_UPSTREAM, "/auth/login.v2", { email, game, locale, pin }, { auth: false });
  if (r.status === 200 && r.data && r.data.token) {
    session.token = r.data.token;
    session.email = email;
    session.game = game;
    session.locale = locale;
    session.authFailed = false;
    return ok(res, { authenticated: true, email });
  }
  return upError(res, r, session);
}

async function importToken(req, res, session) {
  const b = await readJsonBody(req);
  if (b === null) return fail(res, 400, "invalid_json", "Request body must be valid JSON.");
  const token = String(b.token || "").trim();
  if (token.length < 20) return fail(res, 400, "bad_token", "That doesn't look like a token (too short).");
  session.token = token;
  session.email = String(b.email || "").trim() || session.email;
  session.authFailed = false;
  return ok(res, { authenticated: true, email: session.email });
}

function logout(req, res, session) {
  session.token = "";
  session.authFailed = false;
  return ok(res, { authenticated: false });
}

function me(req, res, session) {
  return ok(res, {
    authenticated: !!session.token,
    authFailed: !!session.authFailed,
    email: session.email || null,
    game: session.game || "laser",
    locale: session.locale || "ru",
  });
}

function revealToken(req, res, session) {
  if (!requireToken(session, res)) return;
  recordActivity(session, { internal: "/session/token", method: "GET", auth: true, upstream: null, status: 200, ms: 0, data: { token: session.token } });
  return ok(res, { token: session.token });
}

async function accounts(req, res, session, url) {
  if (!requireToken(session, res)) return;
  const game = url.searchParams.get("game") || "laser";
  const r = await callUpstream(session, "/api/accounts", API_UPSTREAM, "/games/links", { game });
  if (r.status >= 400) return upError(res, r, session);
  return ok(res, r.data);
}

async function accountToken(req, res, session, url) {
  if (!requireToken(session, res)) return;
  const playerId = (url.searchParams.get("player_id") || "").trim();
  if (!playerId) return fail(res, 400, "bad_player_id", "player_id is required.");
  const game = url.searchParams.get("game") || "laser";
  const r = await callUpstream(session, "/api/accounts/token", API_UPSTREAM, "/games/token", { player_id: playerId, game });
  if (r.status >= 400) return upError(res, r, session);
  return ok(res, r.data);
}

async function refreshTokens(req, res, session) {
  if (!requireToken(session, res)) return;
  if (!rl(session, "refresh", 5, 30000)) return fail(res, 429, "rate_limited", "Too many refresh calls — wait 30 seconds.");
  const r = await callUpstream(session, "/api/refresh-tokens", API_UPSTREAM, "/games/refresh_tokens", {});
  if (r.status >= 400) return upError(res, r, session);
  return ok(res, { refreshed: true });
}

async function bindAccount(req, res, session) {
  if (!requireToken(session, res)) return;
  const b = await readJsonBody(req);
  if (b === null) return fail(res, 400, "invalid_json", "Request body must be valid JSON.");
  const bindToken = String(b.bind_token || "").trim();
  if (!bindToken) return fail(res, 400, "bad_bind_token", "A bind token is required.");
  const r = await callUpstream(session, "/api/bind", API_UPSTREAM, "/games/bind", { bind_token: bindToken, game: String(b.game || "laser") });
  if (r.status >= 400) return upError(res, r, session);
  return ok(res, r.data);
}

async function transferBindings(req, res, session) {
  if (!requireToken(session, res)) return;
  const b = await readJsonBody(req);
  if (b === null) return fail(res, 400, "invalid_json", "Request body must be valid JSON.");
  const destToken = String(b.dest_token || "").trim();
  const playerIds = String(b.player_ids || "").trim().replace(/\s+/g, "");
  if (!destToken) return fail(res, 400, "bad_dest_token", "A destination token is required.");
  if (!/^[0-9]+(,[0-9]+)*$/.test(playerIds)) return fail(res, 400, "bad_player_ids", "player_ids must be comma-separated numeric ids.");
  const r = await callUpstream(session, "/api/transfer", API_UPSTREAM, "/games/transfer", { dest_token: destToken, player_ids: playerIds });
  if (r.status >= 400) return upError(res, r, session);
  return ok(res, r.data);
}

async function getSettings(req, res, session) {
  if (!requireToken(session, res)) return;
  const r = await callUpstream(session, "/api/settings", API_UPSTREAM, "/settings/get", {});
  if (r.status >= 400) return upError(res, r, session);
  return ok(res, r.data);
}

async function unlinkTg(req, res, session) {
  if (!requireToken(session, res)) return;
  const r = await callUpstream(session, "/api/settings/unlink-tg", API_UPSTREAM, "/settings/unlink/tg", {});
  if (r.status >= 400) return upError(res, r, session);
  return ok(res, { unlinked: true });
}

async function oauthInfo(req, res, session, url) {
  if (!requireToken(session, res)) return;
  const redirectUri = (url.searchParams.get("redirect_uri") || "").trim();
  const clientId = (url.searchParams.get("client_id") || "").trim();
  if (!isUri(redirectUri)) return fail(res, 400, "bad_redirect_uri", "redirect_uri must be a valid http(s) URL.");
  if (!clientId) return fail(res, 400, "bad_client_id", "client_id is required.");
  const r = await callUpstream(session, "/api/oauth/info", API_UPSTREAM, "/oauth/info", { redirect_uri: redirectUri, client_id: clientId });
  if (r.status >= 400) return upError(res, r, session);
  return ok(res, r.data);
}

async function oauthToken(req, res, session) {
  if (!requireToken(session, res)) return;
  const b = await readJsonBody(req);
  if (b === null) return fail(res, 400, "invalid_json", "Request body must be valid JSON.");
  const scope = String(b.scope || "").trim();
  const clientId = String(b.client_id || "").trim();
  if (!scope) return fail(res, 400, "bad_scope", "A scope is required.");
  if (!clientId) return fail(res, 400, "bad_client_id", "client_id is required.");
  const params = { scope, client_id: clientId, game: String(b.game || "laser") };
  for (const k of ["state", "nonce", "player_id"]) if (b[k] !== undefined && String(b[k]).trim()) params[k] = String(b[k]).trim();
  const r = await callUpstream(session, "/api/oauth/token", API_UPSTREAM, "/oauth/token", params);
  if (r.status >= 400) return upError(res, r, session);
  return ok(res, r.data);
}

async function adminWhois(req, res, session, url) {
  if (!requireToken(session, res)) return;
  const uid = (url.searchParams.get("uid") || "").trim();
  const email = (url.searchParams.get("email") || "").trim();
  const scid = (url.searchParams.get("scid") || "").trim();
  if (!uid && !email && !scid) return fail(res, 400, "bad_params", "Provide at least one of uid, email, or scid.");
  if (uid && !isInt(uid)) return fail(res, 400, "bad_uid", "uid must be an integer.");
  if (email && !isEmail(email)) return fail(res, 400, "bad_email", "Invalid email address.");
  if (scid && !isUuid(scid)) return fail(res, 400, "bad_scid", "scid must be a UUID.");
  const params = {};
  if (uid) params.uid = uid;
  if (email) params.email = email;
  if (scid) params.scid = scid;
  const r = await callUpstream(session, "/api/admin/whois", API_UPSTREAM, "/admin/whois", params);
  if (r.status >= 400) return upError(res, r, session);
  return ok(res, r.data);
}

async function adminEvents(req, res, session, url) {
  if (!requireToken(session, res)) return;
  const uid = (url.searchParams.get("uid") || "").trim();
  if (!uid || !isInt(uid)) return fail(res, 400, "bad_uid", "uid must be an integer.");
  const r = await callUpstream(session, "/api/admin/events", API_UPSTREAM, "/admin/events", { uid });
  if (r.status >= 400) return upError(res, r, session);
  return ok(res, r.data);
}

async function adminFindTg(req, res, session, url) {
  if (!requireToken(session, res)) return;
  const ids = (url.searchParams.get("tg_user_ids") || "").trim().replace(/\s+/g, "");
  if (!isTgIds(ids)) return fail(res, 400, "bad_tg_ids", "tg_user_ids must be comma-separated numeric ids.");
  const r = await callUpstream(session, "/api/admin/find-tg", API_UPSTREAM, "/admin/find.tg", { tg_user_ids: ids });
  if (r.status >= 400) return upError(res, r, session);
  return ok(res, r.data);
}

async function adminFindVk(req, res, session, url) {
  if (!requireToken(session, res)) return;
  const vkId = (url.searchParams.get("vk_user_id") || "").trim();
  if (!isInt(vkId)) return fail(res, 400, "bad_vk_id", "vk_user_id must be an integer.");
  const r = await callUpstream(session, "/api/admin/find-vk", API_UPSTREAM, "/admin/find.vk", { vk_user_id: vkId });
  if (r.status >= 400) return upError(res, r, session);
  return ok(res, r.data);
}

async function adminBind(req, res, session) {
  if (!requireToken(session, res)) return;
  const b = await readJsonBody(req);
  if (b === null) return fail(res, 400, "invalid_json", "Request body must be valid JSON.");
  const uid = String(b.uid || "").trim();
  const playerId = String(b.player_id || "").trim();
  if (!isInt(uid)) return fail(res, 400, "bad_uid", "uid must be an integer.");
  if (!playerId) return fail(res, 400, "bad_player_id", "player_id is required.");
  const sync = String(b.sync ?? "true");
  if (sync !== "true" && sync !== "false") return fail(res, 400, "bad_sync", "sync must be true or false.");
  const r = await callUpstream(session, "/api/admin/bind", API_UPSTREAM, "/admin/bind", {
    uid,
    player_id: playerId,
    sync,
    game: String(b.game || "laser"),
  });
  if (r.status >= 400) return upError(res, r, session);
  return ok(res, r.data);
}

async function adminUnbind(req, res, session) {
  if (!requireToken(session, res)) return;
  const b = await readJsonBody(req);
  if (b === null) return fail(res, 400, "invalid_json", "Request body must be valid JSON.");
  const scid = String(b.scid || "").trim();
  if (!isUuid(scid)) return fail(res, 400, "bad_scid", "scid must be a UUID.");
  const sync = String(b.sync ?? "true");
  if (sync !== "true" && sync !== "false") return fail(res, 400, "bad_sync", "sync must be true or false.");
  const r = await callUpstream(session, "/api/admin/unbind", API_UPSTREAM, "/admin/unbind", { scid, sync });
  if (r.status >= 400) return upError(res, r, session);
  return ok(res, r.data);
}

async function profileSearch(req, res, session, url) {
  const q = (url.searchParams.get("q") || "").trim();
  const rawType = (url.searchParams.get("type") || "handle").trim().toLowerCase();
  const type = rawType === "game_account_id" || rawType === "gameaccountid"
    ? "GameAccountId"
    : rawType === "account_id" || rawType === "accountid"
      ? "AccountId"
      : "Handle";
  const game = (url.searchParams.get("game") || "laser").trim();
  if (!q) return fail(res, 400, "bad_query", "Enter a handle or id to search for.");
  if (q.length > 80) return fail(res, 400, "bad_query", "Search value is too long (max 80 characters).");
  const r = await callUpstream(session, "/api/profile/search", PROFILES_UPSTREAM, `/${encodeURIComponent(game)}/${encodeURIComponent(q)}`, { lookup_type: type }, { auth: false });
  if (r.status === 404) return fail(res, 404, "profile_not_found", "No profile found for that value.", { action: "Try a different handle, id, game or lookup type." });
  if (r.status >= 400) return upError(res, r, session, "profiles");
  return ok(res, r.data);
}

async function profileUpdate(req, res, session) {
  if (!requireToken(session, res)) return;
  const b = await readJsonBody(req);
  if (b === null) return fail(res, 400, "invalid_json", "Request body must be valid JSON.");
  const playerId = String(b.player_id || "").trim();
  const game = String(b.game || "laser").trim().toLowerCase();
  const handle = String(b.handle || "").trim();
  const imageRef = String(b.image_ref || DEFAULT_IMAGE_REF).trim();
  const blockFriends = b.block_friends === undefined || b.block_friends === null || b.block_friends === "" ? null : String(b.block_friends) === "true";
  if (!playerId) return fail(res, 400, "bad_player_id", "player_id is required — the game account whose bound profile to update.");
  if (!handle) return fail(res, 400, "bad_handle", "A new handle is required.");
  if (handle.length > 80) return fail(res, 400, "bad_handle", "Handle is too long (max 80 characters).");
  if (!isUuid(imageRef)) return fail(res, 400, "bad_image_ref", "image_ref must be a UUID.");

  // The profiles API authenticates /update with a per-player GAME token, not the
  // account token (verified live: account token -> 403, game token -> 200). This
  // mirrors the C client, which first fetches the account token for the player
  // (main.c case 3) and then POSTs /update with it as the bearer. The game token
  // is minted here and never exposed to the browser.
  const mint = await callUpstream(session, "/api/profile/update#mint", API_UPSTREAM, "/games/token", { player_id: playerId, game });
  if (mint.status >= 400) return upError(res, mint, session);
  const gameToken = mint.data && mint.data.token;
  if (!gameToken) return fail(res, 502, "mint_failed", "The connect API did not return a game token for that player.");

  const params = { handle, image_ref: imageRef };
  if (blockFriends !== null) params.block_friends = String(blockFriends);
  const r = await callUpstream(session, "/api/profile/update", PROFILES_UPSTREAM, "/update", params, { method: "POST", body: "{}", token: gameToken, noAuthFail: true });
  if (r.status === 403) {
    return fail(res, 403, "not_authenticated", "The profile API rejected the freshly minted game token.", { action: "Reconnect with a fresh account token and retry." });
  }
  if (r.status >= 400) return upError(res, r, session, "profiles");
  return ok(res, { updated: true, player: mint.data.player_info, handle, image_ref: imageRef });
}

async function profileNamespace(req, res, session, url) {
  // Scan the same player across profile namespace segments. Public (no auth): the
  // profiles API serves these lookups without a token. `laser` resolves to the
  // bound profile; any other segment auto-creates an anonymous identity.
  if (!rl(session, "namespace", 12, 60000)) return fail(res, 429, "rate_limited", "Too many namespace scans — wait a minute.");
  const playerId = (url.searchParams.get("player_id") || "").trim();
  const gamesRaw = (url.searchParams.get("games") || "").trim();
  if (!playerId || !/^\d{1,20}$/.test(playerId)) return fail(res, 400, "bad_player_id", "player_id must be a numeric id.");
  const segments = [...new Set(gamesRaw ? gamesRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [])].slice(0, 12);
  if (!segments.length) return fail(res, 400, "bad_games", "Provide at least one namespace segment (comma-separated).");

  const results = [];
  for (const seg of segments) {
    const r = await callUpstream(
      session,
      "/api/profile/namespace",
      PROFILES_UPSTREAM,
      `/${encodeURIComponent(seg)}/${encodeURIComponent(playerId)}`,
      { lookup_type: "GameAccountId" },
      { auth: false }
    );
    if (r.status === 200 && r.data && typeof r.data === "object") {
      const acct = String(r.data.account_id || "");
      const kind = acct.startsWith("profile:") ? "bound" : acct.startsWith("anonymous:") ? "anonymous" : "unknown";
      results.push({
        segment: seg,
        status: 200,
        kind,
        account_id: r.data.account_id || null,
        handle: r.data.handle || null,
        image_ref: r.data.image_ref || null,
        game_account_id: r.data.game_account_id || null,
        allow_update: r.data.allow_update ?? null,
        block_friends: r.data.block_friends ?? null,
        request_friend_deeplink: r.data.request_friend_deeplink || null,
      });
    } else {
      results.push({
        segment: seg,
        status: r.status,
        kind: "error",
        detail: (r.data && (r.data.detail || r.data.error_type)) || "lookup failed",
      });
    }
  }
  recordActivity(session, {
    internal: `/api/profile/namespace?player_id=${playerId}&games=${segments.join(",")}`,
    method: "GET",
    auth: false,
    upstream: `${PROFILES_UPSTREAM}/{segment}/{player_id}?lookup_type=GameAccountId`,
    status: 200,
    ms: 0,
    data: { player_id: playerId, segments, results: results.map((x) => ({ segment: x.segment, status: x.status, kind: x.kind, handle: x.handle, account_id: x.account_id })) },
  });
  return ok(res, { player_id: playerId, scanned: segments, results });
}

/* ------------------------------ discovery registry ------------------------------ */

const KB = {
  version: "1.0.0",
  games: [
    {
      id: "laser",
      status: "verified",
      note: "The only game identifier the Connect API accepts. Every other value probed (/games/links?game=0|nullsbrawl|brawl|...) returns unknown_game. On the profiles API, 'laser' is the namespace that resolves to the bound, editable profile.",
      evidence: [
        "main.c:52 — construct_auth_url: /auth/login.v2?email=...&game=laser&locale=ru",
        "main.c:211 — /games/links?game=laser",
        "main.c:284 — /games/token?player_id=...&game=laser",
        "main.c:36 — profiles.dnull.xyz/laser/{key} (game is the path segment)",
        "live probe — connect /games/links rejects every non-laser value (418 unknown_game)",
      ],
      supportedOps: ["auth", "links", "token", "refresh", "bind", "transfer", "profile lookup", "avatar"],
    },
  ],
  namespaces: [
    {
      id: "laser",
      kind: "bound",
      status: "verified",
      note: "The namespace /update writes to. GameAccountId/AccountId lookups here resolve the bound profile (profile:{n}) the user owns via Connect.",
      evidence: "live probes: /laser/198212843?lookup_type=GameAccountId → profile:288631; /update with a game token → 200",
    },
    {
      id: "<any other segment>",
      kind: "anonymous",
      status: "verified",
      note: "Every other segment auto-creates anonymous:{segment}:{player_id} with a stable per-player auto handle and the same default avatar. '0' aliases 'nullsbrawl' (the numeric game id). Anonymous handles are globally searchable via lookup_type=Handle — even from the laser namespace.",
      evidence: "live probes: /0, /nullsbrawl, /duo, /brawl, ... → anonymous:* (handle Worst_Rate_151 for player 198212843); /laser/Worst_Rate_151?lookup_type=Handle → anonymous:laser:198212843",
    },
  ],
  lookupTypes: [
    { value: "Handle", status: "verified", note: "Used by the C client (lookup_type == 1).", evidence: "main.c:27 + live OpenAPI LookupType enum" },
    { value: "GameAccountId", status: "verified", note: "Used by the C client (lookup_type == 2).", evidence: "main.c:30 + live OpenAPI LookupType enum" },
    { value: "AccountId", status: "hidden", note: "Present in the live API's LookupType enum but NOT used by the C client — a hidden lookup mode.", evidence: "profiles.dnull.xyz/openapi.json LookupType enum" },
  ],
  imageMechanisms: [
    {
      id: "avatar-catalog",
      name: "Avatar catalog",
      endpoint: "GET profiles.dnull.xyz/avatars",
      auth: false,
      description: "Returns the full list of avatar UUIDs mapped to https://files.dnull.xyz/avatars/{uuid}.png. Public — no auth required.",
      evidence: "Live fetch (no auth) returned image_refs map; the hardcoded image_ref from main.c:164 is the first entry.",
    },
    {
      id: "avatar-redirect",
      name: "Avatar content redirect",
      endpoint: "GET profiles.dnull.xyz/avatars/{uuid}.png",
      auth: false,
      description: "307-redirects to the avatar content on files.dnull.xyz. Resolves any catalog avatar.",
      evidence: "Live fetch returned 307 → https://files.dnull.xyz/avatars/{uuid}.png",
    },
    {
      id: "files-cdn",
      name: "Avatar CDN",
      endpoint: "https://files.dnull.xyz/avatars/{uuid}.png",
      auth: false,
      description: "Direct PNG content for avatar refs. Also the probe target for unknown refs.",
      evidence: "Live fetch: 200 image/png, ~33 KB for the default avatar.",
    },
    {
      id: "profile-image-ref",
      name: "Profile image_ref",
      endpoint: "ProfileResponse.image_ref",
      auth: false,
      description: "Every profile response carries an image_ref UUID; feed it to the avatar endpoints above to resolve the avatar.",
      evidence: "main.c:106 reads image_ref from profile lookups; ProfileResponse schema.",
    },
  ],
  hiddenParams: [
    {
      op: "GET /avatars",
      param: "player_id",
      type: "string|null",
      note: "Documented in the live spec. Filters the avatar list by player. Untested against real data (no player id at hand).",
    },
    {
      op: "GET /avatars",
      param: "game",
      type: "string|null",
      note: "Documented in the live spec, but a live call with game=laser returned HTTP 500 'Internal server error' — the upstream currently breaks on this param.",
    },
    {
      op: "GET /{game}/{key}",
      param: "lookup_type",
      type: "enum: Handle | AccountId | GameAccountId",
      note: "AccountId is a hidden mode the C client never uses — it accepts the full 'profile:{n}' format (bare numbers, uids and scids 404). In practice lookup_type is REQUIRED: omitting it returns 422 'Field required' (observed live).",
    },
    {
      op: "POST /update",
      param: "block_friends",
      type: "boolean|null",
      note: "Hidden parameter — the C client never sends it. Controls whether friends can be added to the profile. Accepted by the API (verified live: block_friends=false with a game token → 200).",
    },
    {
      op: "GET /{game}/{key}",
      param: "game",
      type: "string",
      note: "Free-form namespace (verified live): 'laser' → the bound profile; ANY other segment → anonymous:{segment}:{player_id}, an auto-created identity with a stable per-player handle and default avatar. The numeric segment '0' is the game id alias of 'nullsbrawl'.",
    },
    {
      op: "POST /update",
      param: "authentication",
      type: "Bearer game token",
      note: "Verified live: profiles /update authenticates with a per-player GAME token (uid+scid+game+pid claims, no exp), not the account token. The backend mints it from connect /games/token before updating — same flow as the C client.",
    },
    {
      op: "GET /settings/get",
      param: "tg_bind_url",
      type: "string",
      note: "Rotates on every call (observed live: two consecutive /settings/get calls returned different start= nonces). Do not cache it.",
    },
  ],
  operations: [
    {
      id: "login", group: "identity", label: "Authorize or register", method: "GET", path: "/auth/login.v2", auth: false,
      summary: "Login with an email; the API either returns a token directly or requires a 6-digit PIN emailed to you (pin_required). Register new accounts with can_register=true.",
      evidence: "main.c construct_auth_url + live OpenAPI",
      params: [
        { name: "email", required: true, type: "string" },
        { name: "can_register", required: false, type: "boolean", known: ["true", "false"], note: "Defaults to false in the spec; the C client never sends it." },
        { name: "pin", required: false, type: "string", note: "6-digit code from email when pin_required." },
        { name: "locale", required: false, type: "string", known: ["ru", "en"], note: "C client sends ru." },
        { name: "game", required: false, type: "string", known: ["laser"], note: "C client sends laser." },
      ],
      fields: ["email", "token", "pin_required"],
      errors: ["email_flood_limit", "pin_flood_limit", "email_invalid", "email_failed", "email_host_banned", "pin_invalid", "pin_expired"],
    },
    {
      id: "links", group: "games", label: "List linked accounts", method: "GET", path: "/games/links", auth: true,
      summary: "All game accounts bound to the current identity.",
      evidence: "main.c:211 (/games/links?game=laser) + live OpenAPI",
      params: [{ name: "game", required: false, type: "string", known: ["laser"], note: "C client hardcodes laser; probe other values in the Game Registry." }],
      fields: ["links[].game", "links[].player_id", "links[].player_info{tag,name,score}", "links[].is_current"],
      errors: ["unknown_game"],
    },
    {
      id: "game-token", group: "games", label: "Get game token", method: "GET", path: "/games/token", auth: true,
      summary: "Authorization token for a single linked game account (the token the game client uses).",
      evidence: "main.c:284 (/games/token?player_id=...&game=laser) + live OpenAPI",
      params: [
        { name: "player_id", required: true, type: "string" },
        { name: "game", required: false, type: "string", known: ["laser"] },
      ],
      fields: ["player_info{tag,name,score}", "token"],
      errors: ["link_not_found"],
    },
    {
      id: "bind", group: "games", label: "Link new game account", method: "GET", path: "/games/bind", auth: true,
      summary: "Attach a game account using a bind token generated by the game client.",
      evidence: "live OpenAPI (not in the C client)",
      params: [
        { name: "bind_token", required: true, type: "string" },
        { name: "game", required: false, type: "string", known: ["laser"] },
      ],
      fields: ["player_info{tag,name,score}", "token"],
      errors: ["bind_not_available", "bind_limit_exceeded", "link_not_available"],
    },
    {
      id: "refresh", group: "games", label: "Refresh all tokens", method: "GET", path: "/games/refresh_tokens", auth: true,
      summary: "Revokes all existing game tokens and issues new ones. Destructive.",
      evidence: "main.c:205 + live OpenAPI",
      params: [],
      fields: ["(empty)"],
      errors: [],
    },
    {
      id: "transfer", group: "games", label: "Transfer bindings", method: "GET", path: "/games/transfer", auth: true,
      summary: "Move player binding(s) to another Nulls Connect account. Permanent.",
      evidence: "live OpenAPI (not in the C client)",
      params: [
        { name: "dest_token", required: true, type: "string" },
        { name: "player_ids", required: true, type: "string", note: "Comma-separated numeric ids." },
      ],
      fields: ["(empty)"],
      errors: ["transfer_not_available"],
    },
    {
      id: "profile-lookup", group: "profiles", label: "Look up profile", method: "GET", path: "/{game}/{key}", auth: false,
      summary: "Profile lookup by handle / account id / game account id. The game is a path segment — the C client hardcodes 'laser'.",
      evidence: "main.c:36 construct_profile_url + live OpenAPI",
      params: [
        { name: "game", required: true, type: "string", known: ["laser"], note: "Path segment; other values route but match nothing so far." },
        { name: "key", required: true, type: "string", note: "The value to look up." },
        { name: "lookup_type", required: false, type: "enum", known: ["Handle", "AccountId", "GameAccountId"], note: "AccountId is hidden — the C client never uses it." },
      ],
      fields: ["account_id", "game_account_id", "handle", "image_ref", "request_friend_deeplink", "profile_link", "allow_update", "block_friends"],
      errors: [],
    },
    {
      id: "profile-update", group: "profiles", label: "Update profile", method: "POST", path: "/update", auth: true,
      summary: "Change the profile handle and/or avatar (image_ref). Hidden block_friends param controls friend requests. Authenticates with a per-player GAME token minted from connect /games/token — the account token alone is rejected (403, verified live).",
      evidence: "main.c:164 (handle + hardcoded image_ref) + live OpenAPI (block_friends hidden) + live probes (game token → 200, account token → 403, no token → 403)",
      params: [
        { name: "player_id", required: true, type: "string", note: "The game account whose bound profile to update." },
        { name: "handle", required: true, type: "string" },
        { name: "image_ref", required: true, type: "uuid", known: ["83a9523b-d954-4311-a62e-3ca8971403e1"], note: "C client hardcodes the default avatar UUID." },
        { name: "block_friends", required: false, type: "boolean|null", note: "Hidden parameter — not in the C client. Accepted (verified live)." },
      ],
      fields: ["(empty)"],
      errors: ["profile_not_created"],
    },
    {
      id: "profile-namespace", group: "profiles", label: "Identity namespace scan", method: "GET", path: "/{game}/{key} (multi-segment)", auth: false,
      summary: "Scan one player across profile namespace segments: 'laser' returns the bound profile; every other segment returns the auto-generated anonymous identity (stable per-player handle, default avatar). Public.",
      evidence: "live probe sweep (laser, 0, nullsbrawl, brawl, duo, solo, squad, ...) — all non-laser segments return anonymous:{segment}:{player_id}",
      params: [
        { name: "player_id", required: true, type: "string" },
        { name: "games", required: true, type: "string", note: "Comma-separated namespace segments (max 12)." },
      ],
      fields: ["segment", "kind (bound|anonymous)", "account_id", "handle", "image_ref", "request_friend_deeplink"],
      errors: [],
    },
    {
      id: "avatars", group: "images", label: "Avatar catalog", method: "GET", path: "/avatars", auth: false,
      summary: "All avatar UUIDs mapped to their files.dnull.xyz PNG URLs. Public.",
      evidence: "live OpenAPI (not in the C client) + live fetch",
      params: [
        { name: "game", required: false, type: "string|null", note: "Documented, but a live call 500s upstream (observed)." },
        { name: "player_id", required: false, type: "string|null" },
      ],
      fields: ["image_refs{uuid:url}"],
      errors: [],
    },
    {
      id: "avatar-content", group: "images", label: "Avatar content", method: "GET", path: "/avatars/{uuid}.png", auth: false,
      summary: "307-redirects to the avatar PNG on files.dnull.xyz. Public.",
      evidence: "live OpenAPI + live fetch (307 redirect observed)",
      params: [{ name: "uuid", required: true, type: "uuid" }],
      fields: ["(image/png content)"],
      errors: [],
    },
    {
      id: "settings-get", group: "settings", label: "Get settings", method: "GET", path: "/settings/get", auth: true,
      summary: "Identity settings: uid, VK client, Telegram binding URL, transfer allowance.",
      evidence: "live OpenAPI (not in the C client)",
      params: [],
      fields: ["user_id", "vk_client_id", "tg_name", "tg_bind_url", "allow_transfer"],
      errors: [],
    },
    {
      id: "unlink-tg", group: "settings", label: "Unlink Telegram", method: "GET", path: "/settings/unlink/tg", auth: true,
      summary: "Remove the Telegram link from the account.",
      evidence: "live OpenAPI (not in the C client)",
      params: [],
      fields: ["(empty)"],
      errors: [],
    },
    {
      id: "oauth-info", group: "oauth", label: "OAuth client info", method: "GET", path: "/oauth/info", auth: true,
      summary: "What an OAuth client is registered as (display name).",
      evidence: "live OpenAPI (not in the C client)",
      params: [
        { name: "redirect_uri", required: true, type: "uri" },
        { name: "client_id", required: true, type: "string" },
      ],
      fields: ["display_name"],
      errors: ["oauth_invalid_client_id", "oauth_invalid_redirect_uri"],
    },
    {
      id: "oauth-token", group: "oauth", label: "Authorize OAuth client", method: "GET", path: "/oauth/token", auth: true,
      summary: "Authorize an OAuth client with the current session; returns an id_token.",
      evidence: "live OpenAPI (not in the C client)",
      params: [
        { name: "scope", required: true, type: "string" },
        { name: "client_id", required: true, type: "string" },
        { name: "state", required: false, type: "string|null" },
        { name: "nonce", required: false, type: "string|null" },
        { name: "player_id", required: false, type: "string|null" },
        { name: "game", required: false, type: "string", known: ["laser"] },
      ],
      fields: ["id_token", "state"],
      errors: ["oauth_invalid_client_id", "oauth_invalid_redirect_uri", "oauth_invalid_scope"],
    },
    {
      id: "admin-whois", group: "admin", label: "Whois — full account info", method: "GET", path: "/admin/whois", auth: true,
      summary: "Full account information: uid, email, telegram id, and all bindings keyed by scid. Admin only.",
      evidence: "live OpenAPI (not in the C client)",
      params: [
        { name: "uid", required: false, type: "integer" },
        { name: "email", required: false, type: "string" },
        { name: "scid", required: false, type: "uuid" },
      ],
      fields: ["uid", "register_time", "tg_user_id", "email", "links{scid:LinkedGame}"],
      errors: ["admin_parameters_contradiction", "admin_account_not_found", "admin_access_denied"],
    },
    {
      id: "admin-events", group: "admin", label: "Account events", method: "GET", path: "/admin/events", auth: true,
      summary: "Timeline of account events (logins, token refreshes, tg/vk links, transfers). Admin only.",
      evidence: "live OpenAPI (not in the C client)",
      params: [{ name: "uid", required: true, type: "integer" }],
      fields: ["events[].time", "events[].type", "events[].game", "events[].details"],
      errors: ["admin_account_not_found", "admin_access_denied"],
    },
    {
      id: "admin-find-tg", group: "admin", label: "Find by Telegram", method: "GET", path: "/admin/find.tg", auth: true,
      summary: "Account ids for given telegram user ids. Admin only.",
      evidence: "live OpenAPI (not in the C client)",
      params: [{ name: "tg_user_ids", required: true, type: "string", note: "Comma-separated numeric ids." }],
      fields: ["account_ids{tg_id:[uid]}"],
      errors: ["admin_access_denied"],
    },
    {
      id: "admin-find-vk", group: "admin", label: "Find by VK", method: "GET", path: "/admin/find.vk", auth: true,
      summary: "Game accounts linked via legacy VK binding. Admin only.",
      evidence: "live OpenAPI (not in the C client)",
      params: [{ name: "vk_user_id", required: true, type: "integer" }],
      fields: ["links[]"],
      errors: ["admin_access_denied"],
    },
    {
      id: "admin-bind", group: "admin", label: "Admin bind", method: "GET", path: "/admin/bind", auth: true,
      summary: "Bind a player account to a uid directly. Admin only.",
      evidence: "live OpenAPI (not in the C client)",
      params: [
        { name: "uid", required: true, type: "integer" },
        { name: "player_id", required: true, type: "string" },
        { name: "sync", required: false, type: "boolean", known: ["true", "false"] },
        { name: "game", required: false, type: "string", known: ["laser"] },
      ],
      fields: ["scid"],
      errors: ["admin_binding_duplicate", "admin_binding_not_available", "admin_access_denied"],
    },
    {
      id: "admin-unbind", group: "admin", label: "Admin unbind", method: "GET", path: "/admin/unbind", auth: true,
      summary: "Remove a binding by scid. Admin only.",
      evidence: "live OpenAPI (not in the C client)",
      params: [
        { name: "scid", required: true, type: "uuid" },
        { name: "sync", required: false, type: "boolean", known: ["true", "false"] },
      ],
      fields: ["(empty)"],
      errors: ["admin_access_denied"],
    },
  ],
};

let avatarCache = { refs: null, fetchedAt: 0 };
const AVATAR_TTL = 5 * 60 * 1000;

async function fetchAvatars(session) {
  if (avatarCache.refs && Date.now() - avatarCache.fetchedAt < AVATAR_TTL) return avatarCache;
  const r = await callUpstream(session, "/api/discovery/avatars", PROFILES_UPSTREAM, "/avatars", {}, { auth: false });
  if (r.status === 200 && r.data && typeof r.data.image_refs === "object") {
    avatarCache = { refs: r.data.image_refs, fetchedAt: Date.now() };
    return avatarCache;
  }
  return null;
}

async function discoveryAvatars(req, res, session) {
  const av = await fetchAvatars(session);
  if (!av) return fail(res, 502, "avatars_unavailable", "Could not fetch the avatar catalog.");
  return ok(res, { count: Object.keys(av.refs).length, image_refs: av.refs, fetchedAt: av.fetchedAt });
}

async function discoveryRegistry(req, res, session) {
  const avatars = await fetchAvatars(session);
  return ok(res, {
    ...KB,
    avatarCatalog: avatars
      ? { count: Object.keys(avatars.refs).length, image_refs: avatars.refs, fetchedAt: avatars.fetchedAt }
      : null,
  });
}

async function discoveryImage(req, res, session, url) {
  if (!rl(session, "image", 40, 60000)) return fail(res, 429, "rate_limited", "Too many image lookups — wait a minute.");
  const ref = (url.searchParams.get("ref") || "").trim().toLowerCase();
  if (!isUuid(ref)) return fail(res, 400, "bad_ref", "image ref must be a UUID.");
  const avatars = await fetchAvatars(session);
  const catalogUrl = avatars && avatars.refs[ref] ? avatars.refs[ref] : null;
  const redirectUrl = `${PROFILES_UPSTREAM}/avatars/${ref}.png`;
  let resolved = null;
  let probe = null;
  if (catalogUrl) {
    resolved = { source: "avatar-catalog", url: catalogUrl, redirectUrl };
  } else {
    // Probe the CDN directly for refs that aren't in the catalog.
    const t0 = performance.now();
    try {
      const p = await fetch(`${FILES_UPSTREAM}/avatars/${ref}.png`, {
        headers: { range: "bytes=0-0", accept: "image/*" },
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
      });
      probe = { status: p.status, type: p.headers.get("content-type"), ms: Math.round(performance.now() - t0) };
      if (p.status === 200 || p.status === 206 || p.status === 304) {
        resolved = { source: "files-cdn-probe", url: `${FILES_UPSTREAM}/avatars/${ref}.png`, redirectUrl };
      }
    } catch (e) {
      probe = { status: 0, type: null, ms: Math.round(performance.now() - t0), error: "probe failed" };
    }
  }
  recordActivity(session, {
    internal: `/api/discovery/image?ref=${ref}`,
    method: "GET",
    auth: false,
    upstream: `${PROFILES_UPSTREAM}/avatars/${ref}.png`,
    status: resolved ? 200 : 404,
    ms: 0,
    data: { ref, resolved: !!resolved, source: resolved && resolved.source },
  });
  return ok(res, { ref, resolved, probe, inCatalog: !!catalogUrl, redirectUrl });
}

async function probeGame(req, res, session) {
  if (!requireToken(session, res)) return;
  if (!rl(session, "probe-game", 10, 60000)) return fail(res, 429, "rate_limited", "Too many game probes — wait a minute.");
  const b = await readJsonBody(req);
  if (b === null) return fail(res, 400, "invalid_json", "Request body must be valid JSON.");
  const game = String(b.game || "").trim().toLowerCase();
  if (!game || game.length > 40) return fail(res, 400, "bad_game", "Enter a game identifier (1-40 chars).");
  const r = await callUpstream(session, "/api/discovery/probe-game", API_UPSTREAM, "/games/links", { game });
  if (r.status === 403) return upError(res, r, session);
  if (r.status === 418 && r.data && r.data.error_type === "unknown_game") {
    return ok(res, { status: "unknown", game, apiError: "unknown_game", detail: "The API does not recognize this game identifier." });
  }
  if (r.status === 418 && r.data && r.data.error_type) {
    return ok(res, { status: "recognized-error", game, apiError: r.data.error_type, detail: "The game identifier is recognized but the request hit a different error." });
  }
  if (r.status === 200) {
    return ok(res, { status: "recognized", game, links: (r.data && r.data.links || []).length, detail: "The API accepted this game identifier and returned its links." });
  }
  return upError(res, r, session);
}

async function diagnostics(req, res, session) {
  if (!rl(session, "diag", 10, 60000)) return fail(res, 429, "rate_limited", "Too many diagnostics runs — wait a minute.");
  const probe = async (label, base, path, opts) => {
    const t0 = performance.now();
    try {
      const r = await fetch(base + path, {
        ...(opts || {}),
        signal: AbortSignal.timeout(8000),
        redirect: "manual",
      });
      return { label, reachable: true, status: r.status, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { label, reachable: false, error: e.name, ms: Math.round(performance.now() - t0) };
    }
  };
  const connect = await probe("connect", API_UPSTREAM, "/");
  const profiles = await probe("profiles", PROFILES_UPSTREAM, "/avatars");
  let avatarCount = null;
  if (profiles.reachable && profiles.status === 200) {
    try {
      const av = await fetchAvatars(session);
      avatarCount = av ? Object.keys(av.refs).length : null;
    } catch { /* ignore */ }
  }
  const files = await probe("files", `${FILES_UPSTREAM}/avatars/${DEFAULT_IMAGE_REF}.png`, "", { headers: { range: "bytes=0-0" } });
  recordActivity(session, { internal: "/api/diagnostics", method: "GET", auth: false, upstream: null, status: 200, ms: 0, data: { connect, profiles, files } });
  return ok(res, {
    session: {
      authenticated: !!session.token,
      authFailed: !!session.authFailed,
      email: session.email || null,
      game: session.game || "laser",
      locale: session.locale || "ru",
    },
    upstreams: [connect, profiles, files],
    avatarCount,
  });
}

function activity(req, res, session) {
  return ok(res, { entries: session.activity });
}

/* ----------------------------------- router ----------------------------------- */

const ROUTES = [
  ["POST", "/session/login", login],
  ["POST", "/session/confirm", confirmLogin],
  ["POST", "/session/import", importToken],
  ["POST", "/session/logout", logout],
  ["GET", "/session/me", me],
  ["GET", "/session/token", revealToken],
  ["GET", "/api/accounts", accounts],
  ["GET", "/api/accounts/token", accountToken],
  ["GET", "/api/refresh-tokens", refreshTokens],
  ["POST", "/api/bind", bindAccount],
  ["POST", "/api/transfer", transferBindings],
  ["GET", "/api/settings", getSettings],
  ["POST", "/api/settings/unlink-tg", unlinkTg],
  ["GET", "/api/oauth/info", oauthInfo],
  ["POST", "/api/oauth/token", oauthToken],
  ["GET", "/api/admin/whois", adminWhois],
  ["GET", "/api/admin/events", adminEvents],
  ["GET", "/api/admin/find-tg", adminFindTg],
  ["GET", "/api/admin/find-vk", adminFindVk],
  ["POST", "/api/admin/bind", adminBind],
  ["POST", "/api/admin/unbind", adminUnbind],
  ["GET", "/api/profile/search", profileSearch],
  ["POST", "/api/profile/update", profileUpdate],
  ["GET", "/api/profile/namespace", profileNamespace],
  ["GET", "/api/discovery/registry", discoveryRegistry],
  ["GET", "/api/discovery/avatars", discoveryAvatars],
  ["GET", "/api/discovery/image", discoveryImage],
  ["POST", "/api/discovery/probe-game", probeGame],
  ["GET", "/api/diagnostics", diagnostics],
  ["GET", "/api/activity", activity],
];

/* --------------------------------- static files --------------------------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const target = normalize(join(ROOT, rel));
  if (!target.startsWith(ROOT) || rel.includes("..")) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("403 forbidden");
    return;
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, { "content-type": MIME[extname(target)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("404 not found");
  }
}

/* ----------------------------------- server ----------------------------------- */

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/session/");
  if (isApi) {
    const session = ensureSession(req, res);
    const route = ROUTES.find(([m, p]) => m === req.method && p === url.pathname);
    if (!route) return fail(res, 404, "not_found", "Unknown endpoint.");
    try {
      await route[2](req, res, session, url);
    } catch (err) {
      console.error("internal error:", err);
      fail(res, 500, "internal_error", "Internal server error.");
    }
    return;
  }
  await serveStatic(res, url.pathname);
}).listen(PORT, "0.0.0.0", () => {
  console.log(`nulls-connect explorer on http://0.0.0.0:${PORT}`);
  console.log(`  connect API:   ${API_UPSTREAM}`);
  console.log(`  profiles API:  ${PROFILES_UPSTREAM}`);
  console.log(`  files CDN:     ${FILES_UPSTREAM}`);
});
