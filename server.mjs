// Nulls Connect — web backend (zero dependencies, Node >= 18)
//
// Serves the static frontend and exposes an internal /app/* API.
//
// Architecture (mirrors the C client's behavior, moved server-side):
//   Browser -> /app/* API -> Nulls Connect / Profiles upstream APIs -> back
//
// The Connect bearer token NEVER reaches the browser: it lives in an in-memory
// session keyed by an HttpOnly cookie. All upstream calls are made here, with
// validation, rate limiting, error mapping, and a per-session activity log.
//
// Env:
//   PORT              listen port (Freebuff injects it; default 3000)
//   NC_CONNECT_API    upstream Connect API base (default https://connect.nulls.gg/api)
//   NC_PROFILES_API   upstream Profiles API base (default https://profiles.dnull.xyz)

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const CONNECT_API = (process.env.NC_CONNECT_API || "https://connect.nulls.gg/api").replace(/\/+$/, "");
const PROFILES_API = (process.env.NC_PROFILES_API || "https://profiles.dnull.xyz").replace(/\/+$/, "");
const PORT = Number(process.env.PORT || 3000);

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_LIMIT = 60;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 6;
const UPSTREAM_TIMEOUT_MS = 15000;
// Fixed image_ref the C client uses when updating a profile (main.c, case 3).
const PROFILE_IMAGE_REF = "83a9523b-d954-4311-a62e-3ca8971403e1";
// Same iPhone user-agent the C client sends (main.c, basic_common_headers).
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".c": "text/plain; charset=utf-8",
  ".h": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/* ---------------------------------- sessions ---------------------------------- */

const sessions = new Map(); // id -> { token, email, pending, activity[], createdAt, lastSeen }

function cookieId(req) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "nc_session") return rest.join("=");
  }
  return null;
}

function getSession(req) {
  const id = cookieId(req);
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.lastSeen > SESSION_TTL_MS) {
    sessions.delete(id);
    return null;
  }
  s.lastSeen = Date.now();
  return s;
}

function newSession(res) {
  const id = randomUUID();
  sessions.set(id, { token: null, email: null, pending: null, activity: [], createdAt: Date.now(), lastSeen: Date.now() });
  res.setHeader("Set-Cookie", `nc_session=${id}; HttpOnly; SameSite=Lax; Path=/`);
  return sessions.get(id);
}

function pushActivity(session, entry) {
  if (!session) return;
  session.activity.unshift(entry);
  if (session.activity.length > ACTIVITY_LIMIT) session.activity.length = ACTIVITY_LIMIT;
}

/* ---------------------------------- helpers ---------------------------------- */

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function ok(res, data) {
  send(res, 200, { ok: true, data });
}

function fail(res, status, code, message, extra = {}) {
  send(res, status, { ok: false, error: { code, message, status, ...extra } });
}

function maskPath(path, query) {
  const MASK = new Set(["pin", "token", "dest_token", "bind_token", "state", "nonce"]);
  const qs = new URLSearchParams();
  for (const [k, v] of query.entries()) qs.set(k, MASK.has(k) && v ? "•••" : v);
  return path + (qs.size ? "?" + qs.toString() : "");
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 100 * 1024) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

/* ---------------------------------- error mapping ---------------------------------- */

// error_type values from the OpenAPI spec ErrorType enum + friendly messages.
const ERROR_MESSAGES = {
  email_flood_limit: "Too many login attempts for this email — wait a few minutes.",
  pin_flood_limit: "Too many PIN attempts — wait a few minutes.",
  email_invalid: "That email address was rejected as invalid.",
  email_failed: "The PIN email could not be delivered.",
  email_host_banned: "The email provider is blocked by the service.",
  link_not_found: "That account link does not exist.",
  link_not_available: "That account cannot be linked right now.",
  bind_not_available: "That bind token is not available for linking.",
  bind_limit_exceeded: "Binding limit reached for this account.",
  transfer_not_available: "Transfer is not available for this account.",
  pin_invalid: "That PIN code is not valid.",
  pin_expired: "The PIN code has expired — request a new one.",
  oauth_invalid_client_id: "OAuth: unknown client_id.",
  oauth_invalid_redirect_uri: "OAuth: redirect_uri does not match the client.",
  oauth_invalid_scope: "OAuth: scope not allowed for this client.",
  unknown_game: "Unknown game identifier.",
  game_change_not_allowed: "The game cannot be changed for this account.",
  profile_not_created: "No profile exists for this account yet.",
  account_not_found: "Account not found.",
  admin_parameters_contradiction: "Admin: contradictory lookup parameters.",
  admin_account_not_found: "Admin: account not found.",
  admin_binding_duplicate: "Admin: this binding already exists.",
  admin_binding_not_available: "Admin: binding not available.",
  admin_access_denied: "Admin: this token has no admin access.",
};

const STATUS_MESSAGES = {
  401: "Not authorized for this operation.",
  403: "Forbidden — this token doesn't have access to that operation.",
  404: "Not found.",
  422: "Validation error — one of the parameters is invalid.",
  429: "Too many requests — slow down and retry shortly.",
  502: "Could not reach the upstream API.",
  503: "The upstream API is unavailable right now.",
};

function upstreamError(status, data) {
  if (status === 418 && data && typeof data === "object" && data.error_type) {
    const code = data.error_type;
    return { code, message: ERROR_MESSAGES[code] || `API error: ${code}`, status, raw: data };
  }
  if (data && typeof data === "object" && data.detail && status === 404) {
    return { code: "not_found", message: String(data.detail), status, raw: data };
  }
  return { code: "upstream_" + status, message: STATUS_MESSAGES[status] || `Request failed (HTTP ${status}).`, status, raw: data };
}

/* ---------------------------------- upstream ---------------------------------- */

async function upstream({ session, base = CONNECT_API, path, params = {}, method = "GET", body = null, auth = true, storeRaw = true, logParams }) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const url = base + path + (qs.size ? "?" + qs.toString() : "");

  const headers = { accept: "application/json", "user-agent": UA, origin: "https://connect.nulls.gg", referer: "https://connect.nulls.gg/" };
  if (auth && session && session.token) headers.authorization = "Bearer " + session.token;
  if (body) headers["content-type"] = "application/json";

  const t0 = Date.now();
  let res;
  let data = null;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
  } catch (err) {
    pushActivity(session, {
      at: new Date().toISOString(),
      method,
      path: maskPath(logParams ? logParams.path : path, logParams ? logParams.query : qs),
      status: 502,
      ms: Date.now() - t0,
      errorCode: "upstream_unreachable",
    });
    return { ok: false, error: { code: "upstream_unreachable", message: "Could not reach the upstream API.", status: 502 } };
  }

  const ms = Date.now() - t0;
  pushActivity(session, {
    at: new Date().toISOString(),
    method,
    path: maskPath(logParams ? logParams.path : path, logParams ? logParams.query : qs),
    status: res.status,
    ms,
    errorCode: res.status === 418 && data && data.error_type ? data.error_type : null,
    ...(storeRaw && data !== null && data !== undefined ? { raw: JSON.stringify(data).slice(0, 4000) } : {}),
  });

  if (!res.ok) {
    return { ok: false, error: upstreamError(res.status, data), ms };
  }
  return { ok: true, data, ms };
}

/* ---------------------------------- validation ---------------------------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PIN_RE = /^\d{1,6}$/;

function valString(v, { required = false, max = 256, min = 0 } = {}) {
  if (v === undefined || v === null || v === "") {
    if (required) return { error: "missing" };
    return { value: "" };
  }
  const s = String(v).trim();
  if (s.length > max) return { error: `too long (max ${max})` };
  if (s.length < min) return { error: "too short" };
  return { value: s };
}

/* ---------------------------------- rate limiting ---------------------------------- */

const loginAttempts = new Map(); // "ip|email" -> [timestamps]

function rateLimited(ip, email) {
  const key = `${ip}|${email.toLowerCase()}`;
  const now = Date.now();
  const list = (loginAttempts.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (list.length >= LOGIN_MAX_ATTEMPTS) {
    loginAttempts.set(key, list);
    return true;
  }
  list.push(now);
  loginAttempts.set(key, list);
  return false;
}

/* ---------------------------------- route handlers ---------------------------------- */

const handlers = {};

// ---- session ----
handlers["GET /app/session"] = async ({ req, res, session }) => {
  if (!session) return ok(res, { connected: false, email: null, since: null });
  ok(res, { connected: !!session.token, email: session.email, since: session.createdAt });
};

handlers["POST /app/connect"] = async ({ req, res, session, body }) => {
  const email = valString(body && body.email, { required: true, max: 120 });
  if (email.error) return fail(res, 400, "invalid_email", "Enter a valid email address.");
  if (!EMAIL_RE.test(email.value)) return fail(res, 400, "invalid_email", "That doesn't look like a valid email address.");

  const locale = valString(body && body.locale, { max: 8 }).value || "ru";
  if (!["ru", "en"].includes(locale)) return fail(res, 400, "invalid_locale", "Locale must be 'ru' or 'en'.");
  const game = valString(body && body.game, { max: 40 }).value || "laser";
  const canRegister = Boolean(body && body.canRegister);

  const ip = req.socket.remoteAddress || "?";
  if (rateLimited(ip, email.value)) {
    return fail(res, 429, "rate_limited", "Too many login attempts for this email — wait a few minutes.");
  }

  session = session || newSession(res);

  const params = { email: email.value, game, locale };
  if (canRegister) params.can_register = "true";
  const r = await upstream({
    session,
    path: "/auth/login.v2",
    params,
    auth: false,
    storeRaw: false,
    logParams: { path: "/auth/login.v2", query: new URLSearchParams(params) },
  });

  if (!r.ok) return fail(res, 418, r.error.code, r.error.message, { raw: r.error.raw });

  if (r.data && r.data.token) {
    session.token = r.data.token;
    session.email = email.value;
    session.pending = null;
    return ok(res, { status: "connected", email: email.value });
  }
  if (r.data && r.data.pin_required) {
    session.pending = { email: email.value, game, locale };
    return ok(res, { status: "pin_required", email: email.value });
  }
  return fail(res, 502, "unexpected_response", "The API returned neither a token nor a PIN request.");
};

handlers["POST /app/connect/pin"] = async ({ req, res, session, body }) => {
  if (!session || !session.pending) return fail(res, 400, "no_pending_login", "Start the login flow first (enter your email).");
  const pin = valString(body && body.pin, { required: true, max: 6 });
  if (pin.error || !PIN_RE.test(pin.value)) return fail(res, 400, "invalid_pin", "The PIN must be 1-6 digits.");

  const ip = req.socket.remoteAddress || "?";
  if (rateLimited(ip, session.pending.email)) {
    return fail(res, 429, "rate_limited", "Too many PIN attempts — wait a few minutes.");
  }

  const p = session.pending;
  const r = await upstream({
    session,
    path: "/auth/login.v2",
    params: { email: p.email, game: p.game, locale: p.locale, pin: pin.value },
    auth: false,
    storeRaw: false,
    logParams: { path: "/auth/login.v2", query: new URLSearchParams({ email: p.email, game: p.game, locale: p.locale, pin: pin.value }) },
  });

  if (!r.ok) return fail(res, 418, r.error.code, r.error.message, { raw: r.error.raw });

  if (r.data && r.data.token) {
    session.token = r.data.token;
    session.email = p.email;
    session.pending = null;
    return ok(res, { status: "connected", email: p.email });
  }
  return fail(res, 502, "unexpected_response", "The API did not return a token for this PIN.");
};

handlers["POST /app/disconnect"] = async ({ res, session }) => {
  if (session) {
    session.token = null;
    session.email = null;
    session.pending = null;
  }
  ok(res, { status: "disconnected" });
};

// ---- auth gate ----
function requireAuth(handler) {
  return async (ctx) => {
    const { res, session } = ctx;
    if (!session || !session.token) {
      return fail(res, 401, "connect_required", "Connect first — this operation needs your session token.");
    }
    return handler(ctx);
  };
}

// ---- games ----
handlers["GET /app/links"] = requireAuth(async ({ res, session, query }) => {
  const game = valString(query.get("game"), { max: 40 }).value || "laser";
  const r = await upstream({ session, path: "/games/links", params: { game } });
  if (!r.ok) return fail(res, r.error.status, r.error.code, r.error.message, { raw: r.error.raw });
  const links = (r.data && Array.isArray(r.data.links) ? r.data.links : []).map((l) => ({
    game: l.game,
    playerId: l.player_id,
    isCurrent: Boolean(l.is_current),
    playerInfo: l.player_info
      ? { tag: l.player_info.tag ?? null, name: l.player_info.name ?? null, score: l.player_info.score ?? null }
      : null,
  }));
  ok(res, { links });
});

handlers["GET /app/account-token"] = requireAuth(async ({ res, session, query }) => {
  const playerId = valString(query.get("playerId"), { required: true, max: 120 });
  if (playerId.error) return fail(res, 400, "invalid_player_id", "player_id is required.");
  const game = valString(query.get("game"), { max: 40 }).value || "laser";
  const r = await upstream({ session, path: "/games/token", params: { player_id: playerId.value, game }, storeRaw: false });
  if (!r.ok) return fail(res, r.error.status, r.error.code, r.error.message);
  ok(res, {
    token: r.data && r.data.token ? r.data.token : null,
    player: r.data && r.data.player_info ? { tag: r.data.player_info.tag, name: r.data.player_info.name, score: r.data.player_info.score } : null,
  });
});

handlers["POST /app/refresh-tokens"] = requireAuth(async ({ res, session }) => {
  const r = await upstream({ session, path: "/games/refresh_tokens" });
  if (!r.ok) return fail(res, r.error.status, r.error.code, r.error.message, { raw: r.error.raw });
  ok(res, { refreshed: true });
});

handlers["POST /app/bind"] = requireAuth(async ({ res, session, body }) => {
  const bindToken = valString(body && body.bindToken, { required: true, max: 200 });
  if (bindToken.error) return fail(res, 400, "invalid_bind_token", "bind_token is required.");
  const game = valString(body && body.game, { max: 40 }).value || "laser";
  const r = await upstream({ session, path: "/games/bind", params: { bind_token: bindToken.value, game } });
  if (!r.ok) return fail(res, r.error.status, r.error.code, r.error.message, { raw: r.error.raw });
  ok(res, { bound: true, data: r.data });
});

handlers["POST /app/transfer"] = requireAuth(async ({ res, session, body }) => {
  const destToken = valString(body && body.destToken, { required: true, max: 4000 });
  if (destToken.error) return fail(res, 400, "invalid_dest_token", "dest_token is required.");
  const playerIds = valString(body && body.playerIds, { required: true, max: 2000 });
  if (playerIds.error) return fail(res, 400, "invalid_player_ids", "player_ids is required.");
  const r = await upstream({ session, path: "/games/transfer", params: { dest_token: destToken.value, player_ids: playerIds.value } });
  if (!r.ok) return fail(res, r.error.status, r.error.code, r.error.message, { raw: r.error.raw });
  ok(res, { transferred: true });
});

// ---- settings ----
handlers["GET /app/settings"] = requireAuth(async ({ res, session }) => {
  const r = await upstream({ session, path: "/settings/get" });
  if (!r.ok) return fail(res, r.error.status, r.error.code, r.error.message, { raw: r.error.raw });
  ok(res, {
    userId: r.data.user_id ?? null,
    vkClientId: r.data.vk_client_id ?? null,
    tgName: r.data.tg_name ?? null,
    tgBindUrl: r.data.tg_bind_url ?? null,
    allowTransfer: Boolean(r.data.allow_transfer),
  });
});

handlers["POST /app/unlink-tg"] = requireAuth(async ({ res, session }) => {
  const r = await upstream({ session, path: "/settings/unlink/tg" });
  if (!r.ok) return fail(res, r.error.status, r.error.code, r.error.message, { raw: r.error.raw });
  ok(res, { unlinked: true });
});

// ---- oauth ----
handlers["GET /app/oauth-info"] = requireAuth(async ({ res, session, query }) => {
  const redirectUri = valString(query.get("redirectUri"), { required: true, max: 512 });
  if (redirectUri.error) return fail(res, 400, "invalid_redirect_uri", "redirect_uri is required.");
  const clientId = valString(query.get("clientId"), { required: true, max: 200 });
  if (clientId.error) return fail(res, 400, "invalid_client_id", "client_id is required.");
  const r = await upstream({ session, path: "/oauth/info", params: { redirect_uri: redirectUri.value, client_id: clientId.value } });
  if (!r.ok) return fail(res, r.error.status, r.error.code, r.error.message, { raw: r.error.raw });
  ok(res, { displayName: r.data.display_name ?? null });
});

handlers["POST /app/oauth-token"] = requireAuth(async ({ res, session, body }) => {
  const scope = valString(body && body.scope, { required: true, max: 400 });
  if (scope.error) return fail(res, 400, "invalid_scope", "scope is required.");
  const clientId = valString(body && body.clientId, { required: true, max: 200 });
  if (clientId.error) return fail(res, 400, "invalid_client_id", "client_id is required.");
  const params = {
    scope: scope.value,
    client_id: clientId.value,
    state: valString(body && body.state, { max: 400 }).value || null,
    nonce: valString(body && body.nonce, { max: 400 }).value || null,
    player_id: valString(body && body.playerId, { max: 120 }).value || null,
    game: valString(body && body.game, { max: 40 }).value || null,
  };
  const r = await upstream({ session, path: "/oauth/token", params, storeRaw: false });
  if (!r.ok) return fail(res, r.error.status, r.error.code, r.error.message);
  ok(res, { idToken: r.data.id_token ?? null, state: r.data.state ?? null });
});

// ---- admin ----
handlers["GET /app/admin/whois"] = requireAuth(async ({ res, session, query }) => {
  const params = {
    uid: valString(query.get("uid"), { max: 20 }).value || null,
    email: valString(query.get("email"), { max: 120 }).value || null,
    scid: valString(query.get("scid"), { max: 64 }).value || null,
  };
  if (!params.uid && !params.email && !params.scid) {
    return fail(res, 400, "invalid_params", "Provide uid, email, or scid.");
  }
  const r = await upstream({ session, path: "/admin/whois", params });
  if (!r.ok) return fail(res, r.error.status, r.error.code, r.error.message, { raw: r.error.raw });
  ok(res, {
    uid: r.data.uid ?? null,
    registerTime: r.data.register_time ?? null,
    tgUserId: r.data.tg_user_id ?? null,
    email: r.data.email ?? null,
    links: r.data.links
      ? Object.entries(r.data.links).map(([scid, link]) => ({ scid, game: link.game, playerId: link.player_id, isCurrent: Boolean(link.is_current) }))
      : [],
  });
});

handlers["GET /app/admin/events"] = requireAuth(async ({ res, session, query }) => {
  const uid = valString(query.get("uid"), { required: true, max: 20 });
  if (uid.error) return fail(res, 400, "invalid_uid", "uid is required.");
  const r = await upstream({ session, path: "/admin/events", params: { uid: uid.value } });
  if (!r.ok) return fail(res, r.error.status, r.error.code, r.error.message, { raw: r.error.raw });
  ok(res, { events: Array.isArray(r.data.events) ? r.data.events : [] });
});

handlers["GET /app/admin/find-tg"] = requireAuth(async ({ res, session, query }) => {
  const tgUserIds = valString(query.get("tgUserIds"), { required: true, max: 2000 });
  if (tgUserIds.error) return fail(res, 400, "invalid_tg_ids", "tg_user_ids is required.");
  const r = await upstream({ session, path: "/admin/find.tg", params: { tg_user_ids: tgUserIds.value } });
  if (!r.ok) return fail(res, r.error.status, r.error.code, r.error.message, { raw: r.error.raw });
  ok(res, { accountIds: r.data.account_ids ?? {} });
});

handlers["GET /app/admin/find-vk"] = requireAuth(async ({ res, session, query }) => {
  const vkUserId = valString(query.get("vkUserId"), { required: true, max: 20 });
  if (vkUserId.error) return fail(res, 400, "invalid_vk_id", "vk_user_id is required.");
  const r = await upstream({ session, path: "/admin/find.vk", params: { vk_user_id: vkUserId.value } });
  if (!r.ok) return fail(res, r.error.status, r.error.code, r.error.message, { raw: r.error.raw });
  ok(res, { links: Array.isArray(r.data.links) ? r.data.links : [] });
});

handlers["POST /app/admin/bind"] = requireAuth(async ({ res, session, body }) => {
  const uid = valString(body && body.uid, { required: true, max: 20 });
  if (uid.error) return fail(res, 400, "invalid_uid", "uid is required.");
  const playerId = valString(body && body.playerId, { required: true, max: 120 });
  if (playerId.error) return fail(res, 400, "invalid_player_id", "player_id is required.");
  const game = valString(body && body.game, { max: 40 }).value || "laser";
  const sync = body && body.sync !== undefined ? String(body.sync) : "true";
  const r = await upstream({ session, path: "/admin/bind", params: { uid: uid.value, player_id: playerId.value, sync, game } });
  if (!r.ok) return fail(res, r.error.status, r.error.code, r.error.message, { raw: r.error.raw });
  ok(res, { scid: r.data.scid ?? null });
});

handlers["POST /app/admin/unbind"] = requireAuth(async ({ res, session, body }) => {
  const scid = valString(body && body.scid, { required: true, max: 64 });
  if (scid.error) return fail(res, 400, "invalid_scid", "scid is required.");
  const sync = body && body.sync !== undefined ? String(body.sync) : "true";
  const r = await upstream({ session, path: "/admin/unbind", params: { scid: scid.value, sync } });
  if (!r.ok) return fail(res, r.error.status, r.error.code, r.error.message, { raw: r.error.raw });
  ok(res, { unbound: true });
});

// ---- profiles (the separate profiles.dnull.xyz service from the C client) ----
handlers["GET /app/profile/lookup"] = async ({ res, session, query }) => {
  const q = valString(query.get("q"), { required: true, max: 120 });
  if (q.error) return fail(res, 400, "invalid_query", "Enter a handle or game account id.");
  const type = valString(query.get("type"), { max: 20 }).value || "handle";
  if (!["handle", "game_account_id"].includes(type)) return fail(res, 400, "invalid_type", "type must be 'handle' or 'game_account_id'.");
  const lookupType = type === "handle" ? "Handle" : "GameAccountId";
  const r = await upstream({
    session: session || undefined,
    base: PROFILES_API,
    path: `/laser/${encodeURIComponent(q.value)}`,
    params: { lookup_type: lookupType },
    auth: false,
    logParams: { path: `/laser/{q}`, query: new URLSearchParams({ lookup_type: lookupType }) },
  });
  if (!r.ok) {
    const message = r.error.status === 404 ? "Profile not found — check the handle and try again." : r.error.message;
    return fail(res, r.error.status === 404 ? 404 : r.error.status, r.error.code, message, { raw: r.error.raw });
  }
  ok(res, {
    accountId: r.data.account_id ?? null,
    gameAccountId: r.data.game_account_id ?? null,
    handle: r.data.handle ?? null,
    imageRef: r.data.image_ref ?? null,
  });
};

handlers["POST /app/profile/update"] = requireAuth(async ({ res, session, body }) => {
  const handle = valString(body && body.handle, { required: true, max: 80 });
  if (handle.error) return fail(res, 400, "invalid_handle", "Enter the new handle.");
  const imageRef = valString(body && body.imageRef, { max: 64 }).value || PROFILE_IMAGE_REF;
  const r = await upstream({
    session,
    base: PROFILES_API,
    path: "/update",
    params: { handle: handle.value, image_ref: imageRef },
    method: "POST",
    body: {},
    logParams: { path: "/update", query: new URLSearchParams({ handle: handle.value, image_ref: imageRef }) },
  });
  if (!r.ok) return fail(res, r.error.status, r.error.code, r.error.message, { raw: r.error.raw });
  ok(res, { updated: true, response: r.data });
});

// ---- developer ----
handlers["GET /app/activity"] = requireAuth(async ({ res, session }) => {
  ok(res, { entries: session.activity });
});

handlers["GET /app/diagnostics"] = async ({ res }) => {
  const ping = async (base, path) => {
    try {
      const r = await fetch(base + path, { headers: { accept: "application/json", "user-agent": UA }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      return { status: r.status, reachable: true };
    } catch {
      return { status: 0, reachable: false };
    }
  };
  const [connect, profiles] = await Promise.all([
    ping(CONNECT_API, "/auth/login.v2"), // 422 = reachable, validation error expected
    ping(PROFILES_API, "/laser/__probe__?lookup_type=Handle"), // 404 = reachable
  ]);
  ok(res, {
    connectApi: { base: CONNECT_API, ...connect, note: connect.status === 422 ? "reachable" : connect.status ? "reachable" : "unreachable" },
    profilesApi: { base: PROFILES_API, ...profiles, note: profiles.status === 404 ? "reachable" : profiles.status ? "reachable" : "unreachable" },
    sessionTtlHours: SESSION_TTL_MS / 3600000,
    defaultGame: "laser",
    defaultImageRef: PROFILE_IMAGE_REF,
  });
};

/* ---------------------------------- static ---------------------------------- */

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

/* ---------------------------------- router ---------------------------------- */

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (!url.pathname.startsWith("/app/")) {
    return serveStatic(res, url.pathname);
  }

  let body = null;
  if (req.method === "POST") {
    const raw = await readBody(req);
    if (raw === null) return fail(res, 413, "body_too_large", "Request body too large.");
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return fail(res, 400, "invalid_json", "Request body must be valid JSON.");
    }
  }

  const key = `${req.method} ${url.pathname}`;
  const handler = handlers[key];
  if (!handler) return fail(res, 404, "not_found", "Unknown endpoint.");

  try {
    await handler({ req, res, url, query: url.searchParams, body, session: getSession(req) });
  } catch (err) {
    console.error("handler error", key, err);
    fail(res, 500, "internal", "Internal error.");
  }
}).listen(PORT, "0.0.0.0", () => {
  console.log(`nulls-connect backend on http://0.0.0.0:${PORT} (connect: ${CONNECT_API}, profiles: ${PROFILES_API})`);
});
