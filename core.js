/* nulls-connect web client — core (router, api, toasts, modal, utils) */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}
function fmtDateTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return isNaN(d) ? String(ts) : d.toLocaleString([], { hour12: false });
}

/* --------------------------------- api --------------------------------- */

class ApiError extends Error {
  constructor(status, code, message, data) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

// client-side dev history (request log). Never persisted.
const devHistory = [];
const SENSITIVE_KEY = /token|secret|authorization|bearer/i;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? "••••••" : redact(v);
    return out;
  }
  return value;
}

async function api(path, { method = "GET", body } = {}) {
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    devHistory.unshift({ time: Date.now(), path, method, status: "ERR", ms: 0, payload: null, body, network: true });
    trimHistory();
    throw new ApiError(0, "NETWORK", "Cannot reach the app server.");
  }
  const ms = Math.round(performance.now() - t0);
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  devHistory.unshift({ time: Date.now(), path, method, status: res.status, ms, payload, body });
  trimHistory();

  if (!payload || typeof payload !== "object") {
    throw new ApiError(res.status, "BAD_RESPONSE", "Unexpected server response.");
  }
  if (!payload.ok) {
    const e = payload.error || {};
    throw new ApiError(res.status, e.code || "ERROR", e.message || "Request failed.", e);
  }
  return payload.data;
}

function trimHistory() {
  while (devHistory.length > 100) devHistory.pop();
}

/* --------------------------------- toasts --------------------------------- */

function toast(message, kind = "info", ms = 3800) {
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  $("#toasts").appendChild(el);
  setTimeout(() => el.classList.add("toast-out"), ms - 300);
  setTimeout(() => el.remove(), ms);
}

/* --------------------------------- modal --------------------------------- */

function confirmModal({ title, message, confirmText = "Continue", danger = false }) {
  return new Promise((resolve) => {
    const root = $("#modalRoot");
    root.innerHTML = "";
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3>
        <p>${esc(message)}</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-act="cancel">cancel</button>
          <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-act="ok">${esc(confirmText)}</button>
        </div>
      </div>`;
    const close = (val) => {
      overlay.remove();
      root.innerHTML = "";
      resolve(val);
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });
    overlay.querySelector('[data-act="cancel"]').addEventListener("click", () => close(false));
    overlay.querySelector('[data-act="ok"]').addEventListener("click", () => close(true));
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close(false);
    });
    root.appendChild(overlay);
    overlay.querySelector('[data-act="ok"]').focus();
  });
}

/* --------------------------------- copy --------------------------------- */

async function copyText(text, btn, label = "copied") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = label;
    setTimeout(() => (btn.textContent = old), 1200);
  }
}

/* ------------------------------- session UI ------------------------------- */

let sessionState = { authenticated: false };

async function refreshSession(silent = true) {
  try {
    sessionState = await api("/app/session", { method: "GET" });
  } catch {
    sessionState = { authenticated: false };
  }
  const chip = $("#sessionChip");
  const logout = $("#logoutBtn");
  if (sessionState.authenticated) {
    chip.textContent = sessionState.email || "connected";
    chip.className = "badge badge-on";
    chip.title = "Bearer token is held server-side in this session";
    logout.classList.remove("hidden");
  } else {
    chip.textContent = "offline";
    chip.className = "badge badge-off";
    logout.classList.add("hidden");
  }
  if (!silent && window.currentView) window.currentView();
}

$("#logoutBtn").addEventListener("click", async () => {
  await api("/app/session/logout", { method: "POST", body: {} });
  sessionState = { authenticated: false };
  toast("Disconnected.", "info");
  refreshSession();
  location.hash = "#/dashboard";
});

/* --------------------------------- router --------------------------------- */

const routes = {
  dashboard: { title: "Dashboard", render: () => window.renderDashboard() },
  connect: { title: "Connect", render: () => window.renderConnect() },
  accounts: { title: "Accounts", render: () => window.renderAccounts() },
  profiles: { title: "Profiles", render: () => window.renderProfiles() },
  admin: { title: "Admin", render: () => window.renderAdmin() },
  developer: { title: "Developer", render: () => window.renderDeveloper() },
};

function navigate() {
  const name = (location.hash.replace(/^#\/?/, "") || "dashboard").split("?")[0];
  const route = routes[name] || routes.dashboard;
  document.title = `${route.title} · nulls-connect`;
  $$(".nav-link").forEach((a) => a.classList.toggle("active", a.dataset.nav === (routes[name] ? name : "dashboard")));
  const view = $("#view");
  view.innerHTML = '<div class="loading"><span class="spinner"></span> loading…</div>';
  try {
    const html = route.render();
    view.innerHTML = html;
    if (window.afterRender && typeof window.afterRender[name] === "function") window.afterRender[name]();
  } catch (err) {
    view.innerHTML = `<div class="card"><div class="err">Failed to render: ${esc(err.message)}</div></div>`;
  }
  window.currentView = () => navigate();
  window.scrollTo({ top: 0 });
}

window.addEventListener("hashchange", navigate);
window.addEventListener("DOMContentLoaded", () => {
  refreshSession(true).then(navigate);
});
