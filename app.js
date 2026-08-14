/* Nulls Connect Explorer — frontend
   Talks only to the same-origin backend (proxy.mjs), which holds the bearer
   token server-side and attaches it to every authenticated upstream request.
   Nothing sensitive is stored in the browser. */

"use strict";

/* --------------------------------- helpers -------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return esc(iso);
  }
}

function fmtDateTime(iso) {
  try {
    return new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "medium" });
  } catch {
    return esc(iso);
  }
}

const EVENT_LABELS = {
  event_login: "Login",
  event_refresh_tokens: "Tokens refreshed",
  event_tg_link: "Telegram linked",
  event_tg_unlink: "Telegram unlinked",
  event_import_vk: "VK import",
  event_transfer: "Transfer",
};

function statusBadge(code) {
  if (code >= 200 && code < 300) return `<span class="badge ok">${code}</span>`;
  if (code >= 400 && code < 500) return `<span class="badge warn">${code}</span>`;
  if (code >= 500) return `<span class="badge err">${code}</span>`;
  return `<span class="badge">${esc(code)}</span>`;
}

function jsonBlock(data) {
  return `<details class="json-details"><summary>View raw JSON</summary><pre class="json">${esc(JSON.stringify(data, null, 2))}</pre></details>`;
}

function resultBox(kind, barHtml, bodyHtml) {
  return `<div class="result ${kind}"><div class="result-bar">${barHtml}</div><div class="result-body">${bodyHtml}</div></div>`;
}

function okBox(label, bodyHtml) {
  return resultBox("success", `<span class="badge ok">ok</span><span>${esc(label)}</span>`, bodyHtml);
}

function kvHtml(obj) {
  return `<div class="kv">${Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(
      ([k, v]) =>
        `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(typeof v === "object" ? JSON.stringify(v) : v)}</span></div>`
    )
    .join("")}</div>`;
}

function errBox(err, operation) {
  const label = err && err.type ? `${err.status || "error"} · ${esc(err.type)}` : "error";
  const action = err && err.action ? `<p class="hint" style="margin:8px 0 0">Suggested action: ${esc(err.action)}</p>` : "";
  const reconnect =
    err && (err.type === "session_required" || err.type === "session_expired" || err.type === "forbidden" || err.authFailed)
      ? `<div style="margin-top:10px"><button class="btn primary" data-goto="session">Reconnect</button></div>`
      : "";
  const opLine = operation ? `<span>${esc(operation)}</span>` : "";
  const raw = err && err.raw ? jsonBlock(err.raw) : "";
  const html = `<div class="result error"><div class="result-bar"><span class="badge err">${esc(label)}</span>${opLine}</div>
    <div class="result-body"><p class="err-text" style="margin:0">${esc(err.message || "Request failed.")}</p>${action}${reconnect}${raw}</div></div>`;
  return html;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard", "success");
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      toast("Copied to clipboard", "success");
    } catch {
      toast("Could not copy — select the text manually.", "error");
    }
    ta.remove();
  }
}

/* ---------------------------------- api ----------------------------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let j = null;
  try {
    j = await res.json();
  } catch {
    j = null;
  }
  if (!res.ok || !j || j.ok !== true) {
    const e = (j && j.error) || { status: res.status, type: `http_${res.status}`, message: `Request failed (HTTP ${res.status}).` };
    const err = new Error(e.message);
    err.status = e.status;
    err.type = e.type;
    err.action = e.action;
    err.authFailed = !!e.authFailed;
    err.raw = j;
    throw err;
  }
  return j.data;
}

/* ------------------------------ toast + modal ----------------------------- */

function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toast-root").appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.3s ease";
    setTimeout(() => el.remove(), 320);
  }, 3800);
}

function confirmModal({ title, body, confirmText = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const root = $("#modal-root");
    root.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3>
        <p class="hint">${body}</p>
        <div class="modal-actions">
          <button class="btn" data-act="cancel">Cancel</button>
          <button class="btn ${danger ? "danger" : "primary"}" data-act="ok">${esc(confirmText)}</button>
        </div>
      </div>`;
    root.classList.add("open");
    const close = (val) => {
      root.classList.remove("open");
      root.innerHTML = "";
      resolve(val);
    };
    $("[data-act=cancel]", root).onclick = () => close(false);
    $("[data-act=ok]", root).onclick = () => close(true);
    $(".modal-backdrop", root).onclick = () => close(false);
  });
}

function tokenModal({ title, token, meta }) {
  return new Promise((resolve) => {
    const root = $("#modal-root");
    root.innerHTML = `
      <div class="modal-backdrop"></div>
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3>
        ${meta ? `<p class="hint">${meta}</p>` : ""}
        <p class="hint" style="margin-bottom:4px">Treat this token like a password.</p>
        <div class="token-box">${esc(token)}</div>
        <div class="modal-actions">
          <button class="btn" data-act="copy">Copy token</button>
          <button class="btn primary" data-act="close">Done</button>
        </div>
      </div>`;
    root.classList.add("open");
    const close = () => {
      root.classList.remove("open");
      root.innerHTML = "";
      resolve();
    };
    $("[data-act=close]", root).onclick = close;
    $(".modal-backdrop", root).onclick = close;
    $("[data-act=copy]", root).onclick = () => copyText(token);
  });
}

/* -------------------------------- session --------------------------------- */

let session = { authenticated: false, authFailed: false, email: null, game: "laser", locale: "ru" };
let activity = [];
let kb = null; // discovery registry
let probes = []; // game probe history

async function refreshSession() {
  try {
    session = await api("/session/me");
  } catch {
    session = { authenticated: false, authFailed: false, email: null, game: "laser", locale: "ru" };
  }
  const dot = $("#session-dot");
  const label = $("#session-label");
  if (session.authenticated) {
    dot.className = "dot ok";
    label.textContent = session.email || "connected";
    $("#session-pill").title = `game: ${session.game} · locale: ${session.locale}`;
  } else if (session.authFailed) {
    dot.className = "dot bad";
    label.textContent = "session expired";
    $("#session-pill").title = "The API rejected the token — reconnect";
  } else {
    dot.className = "dot guest";
    label.textContent = "guest";
    $("#session-pill").title = "";
  }
}

/* --------------------------------- router --------------------------------- */

const PAGES = ["overview", "session", "explorer", "account", "profiles", "admin", "history"];
const PAGE_INIT = {};

function showPage(name) {
  if (!PAGES.includes(name)) name = "overview";
  $$(".page").forEach((p) => p.classList.remove("active"));
  $("#page-" + name).classList.add("active");
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  location.hash = name;
  window.scrollTo({ top: 0 });
  const init = PAGE_INIT[name];
  if (init) init();
}

/* ------------------------------ overview ---------------------------------- */

async function overviewStatus() {
  const strip = $("#ov-status");
  let diag = null;
  try {
    diag = await api("/api/diagnostics");
  } catch (e) {
    diag = null;
  }
  const auth = session.authenticated
    ? `<span class="status-chip"><span class="k">session</span><span class="v ok">● connected</span></span>`
    : session.authFailed
      ? `<span class="status-chip"><span class="k">session</span><span class="v bad">● expired</span></span>`
      : `<span class="status-chip"><span class="k">session</span><span class="v warn">○ guest</span></span>`;
  const mk = (label, up) => {
    if (!up) return `<span class="status-chip"><span class="k">${label}</span><span class="v warn">unknown</span></span>`;
    return `<span class="status-chip"><span class="k">${label}</span><span class="v ${up.reachable ? "ok" : "bad"}">${
      up.reachable ? `up · ${up.status} · ${up.ms}ms` : "down"
    }</span></span>`;
  };
  const avatars = diag && diag.avatarCount != null ? `<span class="status-chip"><span class="k">avatars</span><span class="v">${diag.avatarCount}</span></span>` : "";
  strip.innerHTML =
    auth + (diag ? diag.upstreams.map((u) => mk(u.label, u)).join("") : "") + avatars;
}

function overviewCapmap() {
  const box = $("#ov-capmap");
  if (!kb) {
    box.className = "empty-hint";
    box.textContent = "Registry not loaded.";
    return;
  }
  const groups = {};
  for (const op of kb.operations) (groups[op.group] ||= []).push(op);
  box.className = "";
  box.innerHTML = Object.entries(groups)
    .map(
      ([g, ops]) => `<div class="group-name">${esc(g)} · ${ops.length}</div>
        ${ops
          .map(
            (op) => `<button class="op-btn" data-op="${esc(op.id)}"><span class="method-badge">${esc(op.method)}</span><span>${esc(op.label)}</span></button>`
          )
          .join("")}`
    )
    .join("");
  $$("[data-op]", box).forEach((b) => (b.onclick = () => openOp(b.dataset.op)));
}

function overviewRegistry() {
  const box = $("#ov-registry");
  if (!kb) {
    box.className = "empty-hint";
    box.textContent = "Loading…";
    return;
  }
  box.className = "";
  box.innerHTML = `<div class="kv">
    <div class="row"><span class="k">Games discovered</span><span class="v">${kb.games.map((g) => esc(g.id)).join(", ") || "—"}</span></div>
    <div class="row"><span class="k">Lookup types</span><span class="v">${kb.lookupTypes.map((t) => esc(t.value)).join(", ")}</span></div>
    <div class="row"><span class="k">Hidden parameters</span><span class="v">${kb.hiddenParams.length}</span></div>
    <div class="row"><span class="k">Image mechanisms</span><span class="v">${kb.imageMechanisms.length}</span></div>
    <div class="row"><span class="k">Operations mapped</span><span class="v">${kb.operations.length}</span></div>
    <div class="row"><span class="k">Profile namespaces</span><span class="v">${kb.namespaces ? kb.namespaces.length : 0}</span></div>
    <div class="row"><span class="k">Avatar catalog</span><span class="v">${kb.avatarCatalog ? kb.avatarCatalog.count : "unavailable"}</span></div>
  </div>`;
}

function overviewRecent() {
  const box = $("#ov-recent");
  if (!activity.length) {
    box.className = "empty-hint";
    box.textContent = "Nothing logged yet — run an operation and it shows up here.";
    return;
  }
  box.className = "";
  box.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Time</th><th>Method</th><th>Endpoint</th><th>Auth</th><th>Status</th><th>ms</th></tr></thead>
    <tbody>${activity
      .slice(0, 6)
      .map(
        (a) => `<tr>
          <td class="mono">${fmtTime(a.time)}</td>
          <td><span class="badge cyan">${esc(a.method)}</span></td>
          <td class="mono">${esc(a.path)}</td>
          <td>${a.auth ? '<span class="badge accent">token</span>' : '<span class="badge">public</span>'}</td>
          <td>${statusBadge(a.status)}</td>
          <td class="mono">${esc(a.ms)}</td>
        </tr>`
      )
      .join("")}</tbody></table></div>`;
}

PAGE_INIT.overview = async () => {
  overviewStatus();
  overviewCapmap();
  overviewRegistry();
  overviewRecent();
};

/* -------------------------------- session --------------------------------- */

function sessionPanel() {
  const box = $("#ses-panel");
  if (session.authenticated) {
    box.innerHTML = `<div class="result success"><div class="result-bar"><span class="badge ok">connected</span><span>${esc(
      session.email
    )}</span></div><div class="result-body">
      ${kvHtml({ email: session.email, game: session.game, locale: session.locale, authenticated: "yes" })}
      <div style="display:flex;gap:10px;margin-top:12px">
        <button class="btn danger-outline" id="ses-logout">Disconnect</button>
        <button class="btn" data-goto="explorer">Open explorer →</button>
      </div></div></div>`;
    $("#ses-logout").onclick = async () => {
      await api("/session/logout", { method: "POST" });
      await refreshSession();
      toast("Disconnected.", "success");
      sessionPanel();
      $("#ses-expired").classList.add("hidden");
    };
    $$("[data-goto]", box).forEach((b) => (b.onclick = () => showPage(b.dataset.goto)));
  } else {
    box.innerHTML = `<div class="gate">Browsing as a guest. Sign in or import a token to unlock authenticated operations.
      Public operations (profile lookup, avatar catalog, image resolution) work without a session.</div>`;
  }
}

function sessionExpiredBanner() {
  const box = $("#ses-expired");
  if (session.authFailed && !session.authenticated) {
    box.className = "";
    box.innerHTML = `<div class="gate expired"><strong>Session expired.</strong> The API rejected your stored token, so authenticated
      operations now require reconnecting. Your history is preserved. <a data-goto="overview">Dismiss →</a></div>`;
    $$("[data-goto]", box).forEach((b) => (b.onclick = () => showPage(b.dataset.goto)));
  } else {
    box.className = "hidden";
    box.innerHTML = "";
  }
}

function wireSessionForms() {
  const loginForm = $("#login-form");
  const pinForm = $("#pin-form");
  const importForm = $("#import-form");

  loginForm.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#login-submit");
    const email = $("#login-email").value.trim();
    btn.disabled = true;
    btn.textContent = "Requesting PIN…";
    try {
      const data = await api("/session/login", {
        method: "POST",
        body: {
          email,
          game: $("#login-game").value,
          locale: $("#login-locale").value,
          can_register: $("#login-register").checked,
        },
      });
      if (data.pin_required) {
        $("#pin-email").textContent = email;
        $("#pin-box").classList.remove("hidden");
        toast("PIN email sent — check your inbox.", "success");
      } else if (data.authenticated) {
        await refreshSession();
        toast("Connected!", "success");
        sessionPanel();
        showPage("overview");
      }
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Send PIN email";
    }
  };

  pinForm.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#pin-submit");
    btn.disabled = true;
    btn.textContent = "Confirming…";
    try {
      const data = await api("/session/confirm", {
        method: "POST",
        body: {
          email: $("#login-email").value.trim(),
          pin: $("#pin-input").value.trim(),
          game: $("#login-game").value,
          locale: $("#login-locale").value,
        },
      });
      if (data.authenticated) {
        await refreshSession();
        toast("Connected!", "success");
        sessionPanel();
        showPage("overview");
      }
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Confirm and connect";
    }
  };

  importForm.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#import-submit");
    btn.disabled = true;
    btn.textContent = "Importing…";
    try {
      await api("/session/import", {
        method: "POST",
        body: { token: $("#import-token").value.trim(), email: $("#import-email").value.trim() },
      });
      await refreshSession();
      toast("Token imported — session active.", "success");
      sessionPanel();
      showPage("overview");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Import token";
    }
  };

  $("#ses-reveal-token").onclick = async (e) => {
    const btn = e.target;
    const out = $("#ses-token-result");
    btn.disabled = true;
    try {
      const ok = await confirmModal({
        title: "Reveal bearer token?",
        body: "Your session token will be shown on screen. Anyone with it can act as your account.",
        confirmText: "Reveal token",
        danger: true,
      });
      if (!ok) return;
      const data = await api("/session/token");
      out.innerHTML = `<div class="token-box">${esc(data.token)}</div>
        <button class="btn small" id="ses-copy-token">Copy token</button>`;
      $("#ses-copy-token").onclick = () => copyText(data.token);
    } catch (err) {
      out.innerHTML = errBox(err);
    } finally {
      btn.disabled = false;
    }
  };
}

PAGE_INIT.session = () => {
  sessionPanel();
  sessionExpiredBanner();
  wireSessionForms();
};

/* -------------------------------- explorer -------------------------------- */

function explorerTabs() {
  $$("#exp-tabs .tab").forEach((t) => {
    t.onclick = () => {
      $$("#exp-tabs .tab").forEach((x) => x.classList.toggle("active", x === t));
      $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
      $("#exp-" + t.dataset.tab).classList.remove("hidden");
      if (t.dataset.tab === "images") renderImages();
      if (t.dataset.tab === "ops" && !$("#ops-detail").dataset.loaded) renderOpsGroups();
    };
  });
}

/* ----- games tab ----- */

function renderGames() {
  const box = $("#games-list");
  if (!kb) {
    box.className = "empty-hint";
    box.textContent = "Loading…";
    return;
  }
  box.className = "";
  box.innerHTML = kb.games
    .map(
      (g) => `<div class="result success"><div class="result-bar">
        <span class="badge accent">${esc(g.id)}</span>
        <span class="badge ok">verified in source</span></div>
      <div class="result-body">
        <p class="hint" style="margin:0">${esc(g.note)}</p>
        <ul class="evidence">${g.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
        <p class="hint" style="margin:8px 0 0">Supported: ${g.supportedOps.map((s) => esc(s)).join(" · ")}</p>
      </div></div>`
    )
    .join("")
    .concat(
      kb.namespaces && kb.namespaces.length
        ? `<div class="group-name" style="margin:14px 0 6px">Profile namespaces · ${kb.namespaces.length}</div>` +
            kb.namespaces
              .map(
                (n) => `<div class="result"><div class="result-bar">
        <span class="badge accent">${esc(n.id)}</span>
        <span class="badge ${n.kind === "bound" ? "ok" : "cyan"}">${esc(n.kind)}</span></div>
      <div class="result-body">
        <p class="hint" style="margin:0">${esc(n.note)}</p>
        <p class="hint" style="margin:6px 0 0;color:var(--text-faint)">Evidence: ${esc(n.evidence)}</p>
      </div></div>`
              )
              .join("")
        : ""
    );
}

async function probeGame(game) {
  const out = $("#probe-game-result");
  out.innerHTML = `<div class="empty-hint"><span class="loading"></span> Probing “${esc(game)}”…</div>`;
  try {
    const data = await api("/api/discovery/probe-game", { method: "POST", body: { game } });
    const badge =
      data.status === "recognized"
        ? '<span class="badge ok">recognized</span>'
        : data.status === "unknown"
          ? '<span class="badge warn">unknown</span>'
          : '<span class="badge warn">recognized-error</span>';
    out.innerHTML = okBox(
      `Probe: ${data.game}`,
      `<p style="margin:0">${badge} ${esc(data.detail)}${data.links != null ? ` · ${data.links} linked account(s)` : ""}</p>${jsonBlock(data)}`
    );
    probes.unshift({ game, status: data.status, time: new Date().toISOString() });
    renderProbeHistory();
  } catch (err) {
    out.innerHTML = errBox(err, `probe ${game}`);
  }
}

function renderProbeHistory() {
  const box = $("#probe-history");
  if (!probes.length) {
    box.className = "empty-hint";
    box.textContent = "No probes yet.";
    return;
  }
  box.className = "";
  box.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Game</th><th>Verdict</th><th>Time</th></tr></thead>
    <tbody>${probes
      .map(
        (p) => `<tr>
          <td class="mono">${esc(p.game)}</td>
          <td>${p.status === "recognized" ? '<span class="badge ok">recognized</span>' : p.status === "unknown" ? '<span class="badge warn">unknown</span>' : '<span class="badge warn">recognized-error</span>'}</td>
          <td class="mono">${fmtTime(p.time)}</td>
        </tr>`
      )
      .join("")}</tbody></table></div>`;
}

/* ----- images tab ----- */

async function renderImages() {
  if (!kb) return;
  const mechs = $("#image-mechs");
  mechs.innerHTML = kb.imageMechanisms
    .map(
      (m) => `<div class="result"><div class="result-bar"><span class="badge accent">${esc(m.id)}</span><span>${esc(m.endpoint)}</span></div>
        <div class="result-body"><p class="hint" style="margin:0">${esc(m.description)}</p>
        <p class="hint" style="margin:6px 0 0;color:var(--text-faint)">Evidence: ${esc(m.evidence)}</p></div></div>`
    )
    .join("");

  const grid = $("#avatar-grid");
  if (kb.avatarCatalog) {
    const refs = Object.entries(kb.avatarCatalog.image_refs);
    grid.className = "";
    grid.innerHTML = `<div class="avatar-grid">${refs
      .map(
        ([ref, url]) =>
          `<div class="avatar-cell" data-ref="${esc(ref)}" title="${esc(url)}"><img src="${esc(url)}" alt="" loading="lazy" /><div class="ref">${esc(ref.slice(0, 8))}…</div></div>`
      )
      .join("")}</div>`;
    $$(".avatar-cell", grid).forEach((c) => {
      c.onclick = () => {
        $("#image-input").value = c.dataset.ref;
        $("#image-form").requestSubmit();
      };
    });
  } else {
    grid.className = "empty-hint";
    grid.textContent = "Avatar catalog unavailable.";
  }
}

async function resolveImage(ref) {
  const out = $("#image-result");
  out.innerHTML = `<div class="empty-hint"><span class="loading"></span> Resolving ${esc(ref)}…</div>`;
  try {
    const data = await api("/api/discovery/image?ref=" + encodeURIComponent(ref));
    if (!data.resolved) {
      out.innerHTML = resultBox(
        "error",
        '<span class="badge warn">not resolved</span><span>' + esc(ref) + "</span>",
        `<p class="hint" style="margin:0">This reference is not in the avatar catalog and the CDN probe found nothing at
           <span class="mono">files.dnull.xyz/avatars/${esc(ref)}.png</span>${data.probe ? ` (HTTP ${data.probe.status})` : ""}.</p>${jsonBlock(data)}`
      );
      return;
    }
    out.innerHTML = okBox(
      "Resolved",
      `<div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
        <img src="${esc(data.resolved.url)}" alt="avatar" style="width:110px;height:110px;border-radius:10px;border:1px solid var(--border-strong);background:var(--bg)" />
        <div style="flex:1;min-width:220px">${kvHtml({
          ref: data.ref,
          source: data.resolved.source,
          url: data.resolved.url,
          redirect: data.redirectUrl,
          in_catalog: data.inCatalog ? "yes" : "no",
        })}
        <div style="margin-top:8px"><button class="btn small" id="img-copy-url">Copy URL</button></div></div>
      </div>${jsonBlock(data)}`
    );
    $("#img-copy-url").onclick = () => copyText(data.resolved.url);
  } catch (err) {
    out.innerHTML = errBox(err, "image resolve");
  }
}

/* ----- operations tab ----- */

let currentOpId = null;

function openOp(opId) {
  currentOpId = opId;
  showPage("explorer");
  $$("#exp-tabs .tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === "ops"));
  $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
  $("#exp-ops").classList.remove("hidden");
  renderOpsGroups(opId);
  renderOpDetail(opId);
}

function renderOpsGroups(activeId) {
  const box = $("#ops-groups");
  if (!kb) return;
  const groups = {};
  for (const op of kb.operations) (groups[op.group] ||= []).push(op);
  box.innerHTML = Object.entries(groups)
    .map(
      ([g, ops]) => `<div class="group-name">${esc(g)}</div>
        ${ops
          .map(
            (op) => `<button class="op-btn ${op.id === activeId ? "active" : ""}" data-op="${esc(op.id)}">
              <span class="method-badge">${esc(op.method)}</span><span>${esc(op.label)}</span></button>`
          )
          .join("")}`
    )
    .join("");
  $$("[data-op]", box).forEach((b) => (b.onclick = () => renderOpDetail(b.dataset.op)));
  $("#ops-detail").dataset.loaded = "1";
}

function opInputHtml(p) {
  const known = p.known && p.known.length ? p.known : null;
  const listId = "dl-" + p.name.replace(/[^a-z0-9]/gi, "");
  const type = p.type === "boolean" ? "select" : "text";
  let inner = "";
  if (type === "select") {
    inner = `<select data-name="${esc(p.name)}">
      <option value="">—</option><option value="true">true</option><option value="false">false</option></select>`;
  } else {
    inner = `<input data-name="${esc(p.name)}" ${p.required ? "required" : ""} ${known ? `list="${listId}"` : ""}
      ${p.type === "integer" ? 'inputmode="numeric"' : ""} placeholder="${esc(p.note || p.type || "")}" />
      ${known ? `<datalist id="${listId}">${known.map((k) => `<option value="${esc(k)}"></option>`).join("")}</datalist>` : ""}`;
  }
  return `<label>${esc(p.name)}${p.required ? ' <span class="badge accent">required</span>' : ""}${p.note ? ` <span class="hint" style="display:inline;margin:0">· ${esc(p.note)}</span>` : ""}
    ${inner}</label>`;
}

/* internal-API mapping for each discovered operation */
const OP_BACKEND = {
  login: { m: "POST", path: "/session/login", map: (v) => ({ email: v.email, can_register: v.can_register === "true", game: v.game, locale: v.locale }) },
  links: { m: "GET", path: "/api/accounts", map: (v) => ({ game: v.game }) },
  "game-token": { m: "GET", path: "/api/accounts/token", map: (v) => ({ player_id: v.player_id, game: v.game }) },
  bind: { m: "POST", path: "/api/bind", map: (v) => ({ bind_token: v.bind_token, game: v.game }) },
  refresh: { m: "GET", path: "/api/refresh-tokens", map: () => ({}) },
  transfer: { m: "POST", path: "/api/transfer", map: (v) => ({ dest_token: v.dest_token, player_ids: v.player_ids }) },
  "profile-lookup": {
    m: "GET",
    path: "/api/profile/search",
    map: (v) => ({ q: v.key, type: ({ Handle: "handle", AccountId: "account_id", GameAccountId: "game_account_id" }[v.lookup_type] || "handle"), game: v.game }),
  },
  "profile-update": { m: "POST", path: "/api/profile/update", map: (v) => ({ handle: v.handle, image_ref: v.image_ref, block_friends: v.block_friends === "true" ? true : undefined }) },
  avatars: { m: "GET", path: "/api/discovery/avatars", map: () => ({}) },
  "avatar-content": { m: "GET", path: "/api/discovery/image", map: (v) => ({ ref: v.uuid }) },
  "settings-get": { m: "GET", path: "/api/settings", map: () => ({}) },
  "unlink-tg": { m: "POST", path: "/api/settings/unlink-tg", map: () => ({}) },
  "oauth-info": { m: "GET", path: "/api/oauth/info", map: (v) => ({ client_id: v.client_id, redirect_uri: v.redirect_uri }) },
  "oauth-token": { m: "POST", path: "/api/oauth/token", map: (v) => ({ client_id: v.client_id, scope: v.scope, state: v.state, nonce: v.nonce, player_id: v.player_id, game: v.game }) },
  "admin-whois": { m: "GET", path: "/api/admin/whois", map: (v) => ({ uid: v.uid, email: v.email, scid: v.scid }) },
  "admin-events": { m: "GET", path: "/api/admin/events", map: (v) => ({ uid: v.uid }) },
  "admin-find-tg": { m: "GET", path: "/api/admin/find-tg", map: (v) => ({ tg_user_ids: v.tg_user_ids }) },
  "admin-find-vk": { m: "GET", path: "/api/admin/find-vk", map: (v) => ({ vk_user_id: v.vk_user_id }) },
  "admin-bind": { m: "POST", path: "/api/admin/bind", map: (v) => ({ uid: v.uid, player_id: v.player_id, sync: v.sync, game: v.game }) },
  "admin-unbind": { m: "POST", path: "/api/admin/unbind", map: (v) => ({ scid: v.scid, sync: v.sync }) },
};

function maskParamValue(name, value) {
  if (/token|pin|secret|id_token/i.test(name)) return "••••••";
  return value || "—";
}

function renderOpDetail(opId) {
  const op = kb && kb.operations.find((o) => o.id === opId);
  const box = $("#ops-detail");
  if (!op) {
    box.className = "empty-hint";
    box.textContent = "Unknown operation.";
    return;
  }
  renderOpsGroups(opId);
  const authBadge = op.auth ? '<span class="badge accent">auth: token</span>' : '<span class="badge">auth: public</span>';
  const formHtml = op.params.length
    ? `<form id="op-form" class="form">${op.params.map(opInputHtml).join("")}
        <button type="submit" class="btn primary" id="op-run">Execute</button></form>`
    : `<div style="display:flex;gap:10px;align-items:center;margin-top:4px"><button class="btn primary" id="op-run">Execute</button><span class="hint" style="margin:0">no parameters</span></div>`;
  box.className = "";
  box.dataset.loaded = "1";
  box.innerHTML = `
    <div class="card-head"><h3>${esc(op.label)}</h3>${authBadge}</div>
    <p class="hint" style="margin:0">${esc(op.summary)}</p>
    <p class="op-path">${esc(op.method)} ${esc(op.path)}${op.auth ? " · Authorization: Bearer &lt;session token&gt;" : " · no auth"}</p>
    <p class="hint" style="margin:8px 0 0;color:var(--text-faint)">Evidence: ${esc(op.evidence)}</p>
    ${op.fields.length ? `<p class="hint" style="margin:6px 0 0">Response fields: ${op.fields.map((f) => `<span class="mono">${esc(f)}</span>`).join(" ")}</p>` : ""}
    ${op.errors.length ? `<p class="hint" style="margin:6px 0 0">Errors: ${op.errors.map((e) => `<span class="mono">${esc(e)}</span>`).join(" ")}</p>` : ""}
    <hr />
    ${formHtml}
    <div id="op-preview"></div>
    <div id="op-result"></div>`;

  const collect = () => {
    const values = {};
    $$("[data-name]", box).forEach((inp) => {
      const v = inp.value.trim();
      if (v !== "") values[inp.dataset.name] = v;
    });
    return values;
  };

  const preview = (values) => {
    const b = OP_BACKEND[opId];
    const qs = new URLSearchParams(
      Object.entries(values).filter(([, v]) => v !== "" && v !== undefined).map(([k, v]) => [k, String(v)])
    );
    const preview = $("#op-preview");
    preview.innerHTML = `<div class="req-preview adv-only">
      <div class="line"><span class="k">internal</span>  <span class="v">${esc(b.m)} ${esc(b.path)}${qs.size ? "?" + esc(qs.toString()) : ""}</span></div>
      <div class="line"><span class="k">upstream</span> <span class="v">${esc(op.method)} ${esc(op.path)}${qs.size ? "?" + esc(qs.toString()) : ""}</span></div>
      <div class="line"><span class="k">auth</span>     <span class="v">${op.auth ? "Authorization: Bearer •••••• (session token)" : "none"}</span></div>
      <div class="line"><span class="k">params</span>   <span class="v">${Object.entries(values).length ? Object.entries(values).map(([k, v]) => `${esc(k)}=${esc(maskParamValue(k, v))}`).join(" ") : "—"}</span></div>
    </div>`;
  };

  const run = async () => {
    const b = OP_BACKEND[opId];
    const values = collect();
    preview(values);
    const out = $("#op-result");
    out.innerHTML = `<div class="empty-hint"><span class="loading"></span> Executing ${esc(op.label)}…</div>`;
    try {
      const params = b.map(values);
      const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
      const path = b.m === "GET" ? b.path + (qs.size ? "?" + qs.toString() : "") : b.path;
      const data = await api(path, b.m === "GET" ? {} : { method: b.m, body: params });
      out.innerHTML = renderResponse(op, data);
      const copyBtn = $("#resp-copy-token");
      if (copyBtn) copyBtn.onclick = () => copyText(data.token || data.id_token || "");
      if (opId === "refresh" || opId === "transfer" || opId === "unlink-tg" || opId === "profile-update" || opId === "admin-bind" || opId === "admin-unbind" || opId === "bind") {
        toast("Operation completed.", "success");
      }
    } catch (err) {
      out.innerHTML = errBox(err, op.label);
      if (err.authFailed || err.type === "session_expired") {
        session.authFailed = true;
        refreshSession();
      }
    }
  };

  $("#op-run").onclick = run;
  if (op.params.length) $("#op-form").onsubmit = (e) => { e.preventDefault(); run(); };
}

function renderResponse(op, data) {
  switch (op.id) {
    case "links": {
      const links = data.links || [];
      if (!links.length) return okBox(op.label, '<p class="hint" style="margin:0">No linked accounts for this game.</p>');
      return okBox(
        op.label,
        `<div class="table-wrap"><table><thead><tr><th>player_id</th><th>name</th><th>tag</th><th>score</th><th></th></tr></thead>
        <tbody>${links
          .map(
            (l) => `<tr>
              <td class="mono">${esc(l.player_id)}</td>
              <td>${esc((l.player_info && (l.player_info.name || l.player_info.tag)) || "—")}${l.is_current ? ' <span class="badge accent">current</span>' : ""}</td>
              <td class="mono">${esc((l.player_info && l.player_info.tag) || "—")}</td>
              <td class="mono">${esc((l.player_info && l.player_info.score) ?? "—")}</td>
              <td>${esc(l.game || "—")}</td>
            </tr>`
          )
          .join("")}</tbody></table></div>${jsonBlock(data)}`
      );
    }
    case "game-token":
    case "bind": {
      const pi = data.player_info;
      return okBox(
        op.label,
        `${pi ? kvHtml({ name: pi.name || "—", tag: pi.tag || "—", score: pi.score ?? "—" }) : ""}
        <div class="token-box">${esc(data.token || "")}</div>
        <button class="btn small" id="resp-copy-token">Copy token</button>${jsonBlock(data)}`
      ) + (data.token ? "" : "");
    }
    case "settings-get":
    case "oauth-info":
      return okBox(op.label, kvHtml(data) + jsonBlock(data));
    case "oauth-token":
      return okBox(op.label, `<p class="hint" style="margin:0">id_token issued${data.state ? ` · state ${esc(data.state)}` : ""}.</p>
        <div class="token-box">${esc(data.id_token || "")}</div><button class="btn small" id="resp-copy-token">Copy id_token</button>${jsonBlock(data)}`);
    case "admin-whois": {
      const links = data.links || {};
      const rows = Object.entries(links)
        .map(
          ([scid, l]) => `<tr><td class="mono">${esc(scid)}</td><td class="mono">${esc(l.player_id)}</td>
            <td>${esc((l.player_info && l.player_info.name) || "—")}</td>
            <td class="mono">${esc((l.player_info && l.player_info.tag) || "—")}</td>
            <td class="mono">${esc((l.player_info && l.player_info.score) ?? "—")}</td></tr>`
        )
        .join("");
      return okBox(
        op.label,
        kvHtml({ uid: data.uid, email: data.email, tg_user_id: data.tg_user_id, register_time: data.register_time ? fmtDateTime(data.register_time) : undefined }) +
          (rows ? `<div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>scid</th><th>player_id</th><th>name</th><th>tag</th><th>score</th></tr></thead><tbody>${rows}</tbody></table></div>` : "") +
          jsonBlock(data)
      );
    }
    case "admin-events": {
      const events = data.events || [];
      if (!events.length) return okBox(op.label, '<p class="hint" style="margin:0">No events.</p>');
      return okBox(
        op.label,
        `<div class="timeline">${events
          .map(
            (ev) => `<div class="ev"><div class="t">${fmtDateTime(ev.time)}</div><div class="d">
              <span class="badge">${esc(EVENT_LABELS[ev.type] || ev.type)}</span>${ev.game ? ` <span class="badge">${esc(ev.game)}</span>` : ""}
              ${ev.details && Object.keys(ev.details).length ? `<div class="mono" style="font-size:11px;color:var(--text-faint);margin-top:3px">${esc(JSON.stringify(ev.details))}</div>` : ""}
            </div></div>`
          )
          .join("")}</div>${jsonBlock(data)}`
      );
    }
    case "admin-find-tg": {
      const map = data.account_ids || {};
      const rows = Object.entries(map)
        .map(([tg, ids]) => `<tr><td class="mono">${esc(tg)}</td><td class="mono">${(ids || []).map(esc).join(", ") || "—"}</td></tr>`)
        .join("");
      return okBox(op.label, `<div class="table-wrap"><table><thead><tr><th>tg_user_id</th><th>account ids</th></tr></thead><tbody>${rows}</tbody></table></div>${jsonBlock(data)}`);
    }
    case "admin-find-vk": {
      const links = data.links || [];
      const rows = links
        .map(
          (l) => `<tr><td class="mono">${esc(l.player_id)}</td><td>${esc((l.player_info && l.player_info.name) || "—")}</td><td class="mono">${esc((l.player_info && l.player_info.tag) || "—")}</td></tr>`
        )
        .join("");
      return okBox(op.label, `<div class="table-wrap"><table><thead><tr><th>player_id</th><th>name</th><th>tag</th></tr></thead><tbody>${rows}</tbody></table></div>${jsonBlock(data)}`);
    }
    case "profile-lookup":
      return okBox(
        op.label,
        kvHtml({
          account_id: data.account_id,
          game_account_id: data.game_account_id,
          handle: data.handle,
          image_ref: data.image_ref,
          request_friend_deeplink: data.request_friend_deeplink,
          profile_link: data.profile_link,
          allow_update: data.allow_update != null ? String(data.allow_update) : undefined,
          block_friends: data.block_friends != null ? String(data.block_friends) : undefined,
        }) + jsonBlock(data)
      );
    case "avatar-content": {
      if (!data.resolved) return okBox(op.label, `<p class="hint" style="margin:0">Not resolved.${jsonBlock(data)}</p>`);
      return okBox(
        op.label,
        `<img src="${esc(data.resolved.url)}" alt="avatar" style="width:96px;height:96px;border-radius:10px;border:1px solid var(--border-strong);background:var(--bg)" />
        ${kvHtml({ ref: data.ref, source: data.resolved.source, url: data.resolved.url })}${jsonBlock(data)}`
      );
    }
    case "avatars":
      return okBox(op.label, `<p class="hint" style="margin:0">${data.count} avatar refs in the catalog (see the Image refs tab to browse them).</p>${jsonBlock(data)}`);
    case "login":
      return okBox(op.label, data.authenticated ? "<p class='hint' style='margin:0'>Authenticated — token stored server-side.</p>" : "<p class='hint' style='margin:0'>PIN required — complete the flow in the Session page.</p>");
    case "refresh":
      return okBox(op.label, "<p class='hint' style='margin:0'>All game tokens were revoked and re-issued.</p>");
    case "unlink-tg":
      return okBox(op.label, "<p class='hint' style='margin:0'>Telegram link removed.</p>");
    case "profile-update":
      return okBox(op.label, `<p class='hint' style='margin:0'>Profile updated.</p>${jsonBlock(data)}`);
    case "admin-bind":
      return okBox(op.label, `<p class='hint' style='margin:0'>Bound — scid: <span class="mono">${esc(data.scid)}</span></p>${jsonBlock(data)}`);
    case "admin-unbind":
      return okBox(op.label, `<p class='hint' style='margin:0'>Binding removed.</p>${jsonBlock(data)}`);
    default:
      return okBox(op.label, kvHtml(data) + jsonBlock(data));
  }
}

PAGE_INIT.explorer = () => {
  explorerTabs();
  renderGames();
  if (!kb) return;
  if (!$("#exp-ops").classList.contains("hidden") || currentOpId) {
    renderOpsGroups(currentOpId);
    if (currentOpId) renderOpDetail(currentOpId);
  }
};

/* -------------------------------- account --------------------------------- */

function accountGate() {
  const gate = $("#acc-gate");
  const body = $("#acc-body");
  if (!session.authenticated) {
    gate.innerHTML = `<div class="gate ${session.authFailed ? "expired" : ""}">${session.authFailed ? "<strong>Session expired.</strong>" : "Authentication required."} This operation requires a connected session.
      <a data-goto="session">Go to Session →</a></div>`;
    $$("[data-goto]", gate).forEach((b) => (b.onclick = () => showPage(b.dataset.goto)));
    body.classList.add("hidden");
  } else {
    gate.innerHTML = "";
    body.classList.remove("hidden");
  }
}

async function loadAccounts() {
  const list = $("#acc-links");
  const count = $("#acc-count");
  list.className = "empty-hint";
  list.innerHTML = `<span class="loading"></span> Loading linked accounts…`;
  try {
    const data = await api("/api/accounts?game=" + encodeURIComponent($("#acc-game").value));
    const links = data.links || [];
    count.textContent = `${links.length} account${links.length === 1 ? "" : "s"} linked`;
    if (!links.length) {
      list.className = "empty-hint";
      list.textContent = "No linked accounts yet. Link one with a bind token below.";
      return;
    }
    list.className = "";
    list.innerHTML = links
      .map((link) => {
        const pi = link.player_info;
        const initial = (pi && (pi.name || pi.tag) ? (pi.name || pi.tag)[0] : "?").toUpperCase();
        return `<div class="account-card">
          <div class="main">
            <div class="avatar">${esc(initial)}</div>
            <div>
              <div class="name">${esc((pi && (pi.name || pi.tag)) || "unknown")}
                ${link.is_current ? ' <span class="badge accent">current</span>' : ""}
                ${link.game ? ` <span class="badge">${esc(link.game)}</span>` : ""}
              </div>
              <div class="meta">player_id ${esc(link.player_id)}${pi && pi.tag ? ` · tag ${esc(pi.tag)}` : ""}${pi && typeof pi.score === "number" ? ` · score ${esc(pi.score)}` : ""}</div>
            </div>
          </div>
          <div class="actions"><button class="btn small" data-token="${esc(link.player_id)}">Get token</button></div>
        </div>`;
      })
      .join("");
    $$("[data-token]", list).forEach((btn) => {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const data = await api(
            `/api/accounts/token?player_id=${encodeURIComponent(btn.dataset.token)}&game=${encodeURIComponent($("#acc-game").value)}`
          );
          const pi = data.player_info;
          const meta = pi
            ? `Account <strong>${esc(pi.name || pi.tag || "unknown")}</strong> (player_id ${esc(btn.dataset.token)}) · tag ${esc(pi.tag || "—")} · score ${esc(pi.score ?? "—")}`
            : `player_id ${esc(btn.dataset.token)}`;
          await tokenModal({ title: "Game token", token: data.token, meta });
        } catch (err) {
          toast(err.message, "error");
        } finally {
          btn.disabled = false;
        }
      };
    });
  } catch (err) {
    list.className = "empty-hint";
    list.textContent = err.message;
  }
}

PAGE_INIT.account = () => {
  accountGate();
  if (!session.authenticated) return;
  $("#acc-reload").onclick = loadAccounts;
  $("#acc-game").onchange = loadAccounts;
  $("#acc-refresh-all").onclick = async () => {
    const ok = await confirmModal({
      title: "Refresh all tokens?",
      body: "Revokes every existing game token and issues new ones. Existing game sessions using old tokens will stop working.",
      confirmText: "Refresh all tokens",
      danger: true,
    });
    if (!ok) return;
    try {
      await api("/api/refresh-tokens");
      toast("All tokens refreshed.", "success");
      loadAccounts();
    } catch (err) {
      toast(err.message, "error");
    }
  };

  $("#acc-settings-load").onclick = async (e) => {
    const btn = e.target;
    const out = $("#acc-settings-result");
    btn.disabled = true;
    out.innerHTML = `<div class="empty-hint"><span class="loading"></span> Loading…</div>`;
    try {
      const s = await api("/api/settings");
      out.innerHTML = okBox("Settings", kvHtml({ user_id: s.user_id, vk_client_id: s.vk_client_id, tg_name: s.tg_name, tg_bind_url: s.tg_bind_url, allow_transfer: s.allow_transfer != null ? String(s.allow_transfer) : undefined }) + jsonBlock(s));
    } catch (err) {
      out.innerHTML = errBox(err, "settings");
    } finally {
      btn.disabled = false;
    }
  };

  $("#acc-bind-form").onsubmit = async (e) => {
    e.preventDefault();
    const out = $("#acc-bind-result");
    out.innerHTML = `<div class="empty-hint"><span class="loading"></span> Linking…</div>`;
    try {
      const data = await api("/api/bind", { method: "POST", body: { bind_token: $("#acc-bind-token").value.trim(), game: $("#acc-game").value } });
      const pi = data.player_info;
      out.innerHTML = okBox("Linked", `<p style="margin:0">${pi ? `Linked <strong>${esc(pi.name || pi.tag || "account")}</strong>` : "Account linked."}</p>${jsonBlock(data)}`);
      toast("Account linked.", "success");
      loadAccounts();
    } catch (err) {
      out.innerHTML = errBox(err, "bind");
    }
  };

  $("#acc-transfer-form").onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#acc-transfer-submit");
    btn.disabled = true;
    try {
      const ok = await confirmModal({
        title: "Transfer bindings?",
        body: "Permanently moves the selected player bindings to the destination account. Not undoable from here.",
        confirmText: "Transfer",
        danger: true,
      });
      if (!ok) return;
      const data = await api("/api/transfer", {
        method: "POST",
        body: { dest_token: $("#acc-transfer-dest").value.trim(), player_ids: $("#acc-transfer-ids").value.trim() },
      });
      $("#acc-transfer-result").innerHTML = okBox("Transferred", `<p style="margin:0">Bindings moved.${jsonBlock(data)}</p>`);
      toast("Bindings transferred.", "success");
      loadAccounts();
    } catch (err) {
      $("#acc-transfer-result").innerHTML = errBox(err, "transfer");
    } finally {
      btn.disabled = false;
    }
  };

  $("#acc-unlink-tg").onclick = async (e) => {
    const btn = e.target;
    const out = $("#acc-unlink-result");
    const ok = await confirmModal({
      title: "Unlink Telegram?",
      body: "Removes the Telegram link from your account. Re-link later via the bot's bind URL.",
      confirmText: "Unlink Telegram",
      danger: true,
    });
    if (!ok) return;
    btn.disabled = true;
    out.innerHTML = `<div class="empty-hint"><span class="loading"></span> Unlinking…</div>`;
    try {
      const data = await api("/api/settings/unlink-tg", { method: "POST" });
      out.innerHTML = okBox("Unlinked", `<p style="margin:0">Telegram link removed.${jsonBlock(data)}</p>`);
      toast("Telegram unlinked.", "success");
    } catch (err) {
      out.innerHTML = errBox(err, "unlink tg");
    } finally {
      btn.disabled = false;
    }
  };

  loadAccounts();
};

/* -------------------------------- profiles --------------------------------- */

const AVATAR_CDN = "https://files.dnull.xyz/avatars/";
const avatarUrl = (ref) => (ref ? `${AVATAR_CDN}${ref}.png` : "");

PAGE_INIT.profiles = () => {
  wireProfileLookup();
  wireManualProfileUpdate();
  wireNamespaceExplorer();
  renderProfileEditor();
};

function wireProfileLookup() {
  const lookupForm = $("#prof-lookup-form");
  if (!lookupForm) return;
  $("#prof-type").onchange = () => {
    const t = $("#prof-type").value;
    $("#prof-key-label").firstChild.textContent =
      t === "handle" ? " Key — handle" : t === "account_id" ? " Key — account id (profile:{n})" : " Key — game account id";
  };
  lookupForm.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#prof-lookup-submit");
    const out = $("#prof-lookup-result");
    btn.disabled = true;
    out.innerHTML = `<div class="empty-hint"><span class="loading"></span> Looking up…</div>`;
    try {
      const key = $("#prof-key").value.trim();
      const type = $("#prof-type").value;
      const game = $("#prof-game").value;
      const data = await api(`/api/profile/search?q=${encodeURIComponent(key)}&type=${encodeURIComponent(type)}&game=${encodeURIComponent(game)}`);
      out.innerHTML = okBox(
        "Profile found",
        `<div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
          ${data.image_ref ? `<img src="${esc(avatarUrl(data.image_ref))}" alt="avatar" style="width:88px;height:88px;border-radius:10px;border:1px solid var(--border-strong);background:var(--bg)" />` : ""}
          <div style="flex:1;min-width:220px">${kvHtml({
            account_id: data.account_id,
            game_account_id: data.game_account_id,
            handle: data.handle,
            image_ref: data.image_ref,
            request_friend_deeplink: data.request_friend_deeplink,
            profile_link: data.profile_link,
            allow_update: data.allow_update != null ? String(data.allow_update) : undefined,
            block_friends: data.block_friends != null ? String(data.block_friends) : undefined,
          })}</div></div>${jsonBlock(data)}`
      );
    } catch (err) {
      out.innerHTML = errBox(err, "profile lookup");
    } finally {
      btn.disabled = false;
      btn.textContent = "Look up";
    }
  };
}

function wireManualProfileUpdate() {
  const updateForm = $("#prof-update-form");
  if (!updateForm) return;
  updateForm.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#prof-update-submit");
    const out = $("#prof-update-result");
    btn.disabled = true;
    out.innerHTML = `<div class="empty-hint"><span class="loading"></span> Minting game token + updating…</div>`;
    try {
      const body = {
        player_id: $("#prof-update-player").value.trim(),
        handle: $("#prof-update-handle").value.trim(),
        image_ref: $("#prof-update-image").value.trim(),
      };
      if ($("#prof-update-block").checked) body.block_friends = true;
      const data = await api("/api/profile/update", { method: "POST", body });
      out.innerHTML = okBox(
        "Profile updated",
        `<p style="margin:0">Bound profile for <strong>${esc(body.handle)}</strong> (player_id ${esc(body.player_id)}) saved via a freshly minted game token.</p>${jsonBlock(data)}`
      );
      toast("Profile updated.", "success");
    } catch (err) {
      out.innerHTML = errBox(err, "profile update");
    } finally {
      btn.disabled = false;
    }
  };
}

function wireNamespaceExplorer() {
  const form = $("#ns-form");
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#ns-submit");
    const out = $("#ns-result");
    const playerId = $("#ns-player").value.trim();
    const games = $("#ns-games").value.trim();
    if (!playerId || !games) return;
    btn.disabled = true;
    out.innerHTML = `<div class="empty-hint"><span class="loading"></span> Scanning namespaces for player ${esc(playerId)}…</div>`;
    try {
      const data = await api(`/api/profile/namespace?player_id=${encodeURIComponent(playerId)}&games=${encodeURIComponent(games)}`);
      const rows = data.results
        .map((r) => {
          const kindBadge =
            r.kind === "bound"
              ? '<span class="badge accent">bound</span>'
              : r.kind === "anonymous"
                ? '<span class="badge cyan">anonymous</span>'
                : `<span class="badge err">HTTP ${esc(r.status)}</span>`;
          const img = r.image_ref
            ? `<img src="${esc(avatarUrl(r.image_ref))}" alt="" style="width:34px;height:34px;border-radius:6px;border:1px solid var(--border-strong);background:var(--bg)" />`
            : "";
          return `<tr>
            <td class="mono">${esc(r.segment)}</td>
            <td>${kindBadge}</td>
            <td class="mono">${esc(r.account_id || r.detail || "—")}</td>
            <td class="mono">${esc(r.handle || "—")}</td>
            <td>${img}</td>
            <td class="mono" style="font-size:11px;color:var(--text-faint)">${r.request_friend_deeplink ? esc(r.request_friend_deeplink) : "—"}</td>
            <td>${r.allow_update != null ? (r.allow_update ? '<span class="badge ok">yes</span>' : '<span class="badge warn">no</span>') : "—"}</td>
          </tr>`;
        })
        .join("");
      out.innerHTML = okBox(
        `Namespace scan · player ${playerId}`,
        `<div class="table-wrap"><table>
          <thead><tr><th>segment</th><th>kind</th><th>account_id</th><th>handle</th><th>avatar</th><th>friend deeplink</th><th>allow_update</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
          <p class="hint" style="margin:10px 0 0">Bound profiles (laser) are what the profile editor writes. Anonymous identities are auto-generated per (segment, player) with the same stable handle and default avatar, and are globally searchable by that handle.</p>${jsonBlock(data)}`
      );
    } catch (err) {
      out.innerHTML = errBox(err, "namespace scan");
    } finally {
      btn.disabled = false;
    }
  };
}

async function renderProfileEditor() {
  const root = $("#prof-editor");
  if (!root) return;
  if (!session.authenticated) {
    root.innerHTML = `<div class="card"><div class="gate ${session.authFailed ? "expired" : ""}">${session.authFailed ? "<strong>Session expired.</strong>" : "Requires a connected session."} The editor mints a per-player game token server-side (the same auth the C client uses) — the token never reaches the browser.
      <a data-goto="session">Go to Session →</a></div></div>`;
    $$("[data-goto]", root).forEach((b) => (b.onclick = () => showPage(b.dataset.goto)));
    return;
  }
  root.innerHTML = `<div class="card">
    <div class="card-head"><h3>Profile editor</h3><span class="badge accent">game token auth</span></div>
    <p class="hint">Pick a linked game account, choose a handle and avatar, save. The backend mints a per-player <span class="mono">game token</span> and updates the bound (laser) profile with it — exactly what the C client does in <span class="mono">main.c</span> case 3.</p>
    <form id="pedit-form" class="form" autocomplete="off">
      <label>Linked account <select id="pedit-player"></select></label>
      <div class="form-row">
        <label>Current handle <input id="pedit-current" disabled /></label>
        <label>New handle <input id="pedit-handle" maxlength="80" placeholder="new-handle" required /></label>
      </div>
      <label>Avatar (image_ref) <input id="pedit-image" required /></label>
      <div class="avatar-grid" id="pedit-avatars"><span class="empty-hint"><span class="loading"></span> Loading avatar catalog…</span></div>
      <label class="check" title="Hidden parameter — blocks incoming friend requests"><input id="pedit-block" type="checkbox" /> block_friends (hidden param)</label>
      <button type="submit" class="btn primary" id="pedit-submit">Save profile</button>
    </form>
    <div id="pedit-result"></div>
  </div>`;

  const playerSel = $("#pedit-player");
  const paintSelectedAvatar = () => {
    const ref = $("#pedit-image").value.trim();
    $$("#pedit-avatars .avatar-cell").forEach((c) => c.classList.toggle("selected", c.dataset.ref === ref));
  };
  const loadCurrentProfile = async () => {
    const pid = playerSel.value;
    if (!pid) return;
    try {
      const p = await api(`/api/profile/search?q=${encodeURIComponent(pid)}&type=game_account_id&game=laser`);
      $("#pedit-current").value = p.handle || "";
      $("#pedit-handle").value = p.handle || "";
      $("#pedit-image").value = p.image_ref || "";
      $("#pedit-block").checked = !!p.block_friends;
      paintSelectedAvatar();
    } catch (e) {
      $("#pedit-current").value = "";
      $("#pedit-handle").value = "";
      $("#pedit-image").value = "83a9523b-d954-4311-a62e-3ca8971403e1";
      $("#pedit-block").checked = false;
      paintSelectedAvatar();
    }
  };
  const load = async () => {
    try {
      const data = await api("/api/accounts?game=laser");
      const links = data.links || [];
      if (!links.length) {
        playerSel.innerHTML = `<option value="">No linked accounts — link one in the Account page first</option>`;
        return;
      }
      playerSel.innerHTML = links
        .map(
          (l) =>
            `<option value="${esc(l.player_id)}">${esc((l.player_info && (l.player_info.name || l.player_info.tag)) || l.player_id)} — ${esc(l.player_id)}${l.is_current ? " (current)" : ""}</option>`
        )
        .join("");
      await loadCurrentProfile();
    } catch (err) {
      playerSel.innerHTML = `<option value="">${esc(err.message)}</option>`;
    }
  };

  playerSel.onchange = loadCurrentProfile;

  try {
    const reg = await api("/api/discovery/avatars");
    const refs = Object.entries(reg.image_refs || {});
    const grid = $("#pedit-avatars");
    grid.innerHTML = refs
      .map(
        ([ref, url]) =>
          `<div class="avatar-cell" data-ref="${esc(ref)}" title="${esc(url)}"><img src="${esc(url)}" alt="" loading="lazy" /><div class="ref">${esc(ref.slice(0, 8))}…</div></div>`
      )
      .join("");
    $$("#pedit-avatars .avatar-cell").forEach((c) => {
      c.onclick = () => {
        $("#pedit-image").value = c.dataset.ref;
        paintSelectedAvatar();
      };
    });
    paintSelectedAvatar();
  } catch {
    $("#pedit-avatars").innerHTML = `<span class="empty-hint">Avatar catalog unavailable — paste an image_ref UUID manually.</span>`;
  }

  $("#pedit-form").onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#pedit-submit");
    const out = $("#pedit-result");
    const pid = playerSel.value;
    if (!pid) {
      out.innerHTML = errBox({ message: "No linked account selected — link one in the Account page first." });
      return;
    }
    btn.disabled = true;
    out.innerHTML = `<div class="empty-hint"><span class="loading"></span> Minting game token + updating profile…</div>`;
    try {
      const body = {
        player_id: pid,
        game: "laser",
        handle: $("#pedit-handle").value.trim(),
        image_ref: $("#pedit-image").value.trim(),
      };
      if ($("#pedit-block").checked) body.block_friends = true;
      const data = await api("/api/profile/update", { method: "POST", body });
      $("#pedit-current").value = body.handle;
      out.innerHTML = okBox(
        "Profile saved",
        `<p style="margin:0">Bound profile for <strong>${esc(body.handle)}</strong> (player_id ${esc(pid)}) updated via a freshly minted game token.</p>${jsonBlock(data)}`
      );
      toast("Profile updated.", "success");
    } catch (err) {
      out.innerHTML = errBox(err, "profile editor");
    } finally {
      btn.disabled = false;
    }
  };

  await load();
}

/* --------------------------------- admin ----------------------------------- */

function adminGate() {
  const gate = $("#admin-gate");
  const body = $("#admin-body");
  if (!session.authenticated) {
    gate.innerHTML = `<div class="gate ${session.authFailed ? "expired" : ""}">${session.authFailed ? "<strong>Session expired.</strong>" : "Authentication required."} Admin endpoints need a connected session with admin privileges.
      <a data-goto="session">Go to Session →</a></div>`;
    $$("[data-goto]", gate).forEach((b) => (b.onclick = () => showPage(b.dataset.goto)));
    body.classList.add("hidden");
  } else {
    gate.innerHTML = "";
    body.classList.remove("hidden");
  }
}

function adminForm(id, path) {
  const form = $(id);
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    const out = $(id.replace("-form", "-result"));
    btn.disabled = true;
    out.innerHTML = `<div class="empty-hint"><span class="loading"></span> Working…</div>`;
    try {
      const params = {};
      $$("[data-admin]", form).forEach((inp) => {
        const v = inp.value.trim();
        if (v !== "") params[inp.dataset.admin] = v;
      });
      const data = await api(path, { method: "POST", body: params });
      out.innerHTML = okBox("Done", kvHtml(data) + jsonBlock(data));
      toast("Done.", "success");
    } catch (err) {
      out.innerHTML = errBox(err, "admin");
    } finally {
      btn.disabled = false;
    }
  };
}

PAGE_INIT.admin = () => {
  adminGate();
  if (!session.authenticated) return;

  // whois / events / find.tg / find.vk are GETs with query params
  const getForm = (id, path) => {
    const form = $(id);
    if (!form) return;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector("button");
      const out = $(id.replace("-form", "-result"));
      btn.disabled = true;
      out.innerHTML = `<div class="empty-hint"><span class="loading"></span> Working…</div>`;
      try {
        const qs = new URLSearchParams();
        $$("[data-admin]", form).forEach((inp) => {
          const v = inp.value.trim();
          if (v !== "") qs.set(inp.dataset.admin, v);
        });
        const data = await api(path + "?" + qs.toString());
        out.innerHTML = okBox("Result", kvHtml(data) + jsonBlock(data));
      } catch (err) {
        out.innerHTML = errBox(err, "admin");
      } finally {
        btn.disabled = false;
      }
    };
  };

  getForm("#admin-whois-form", "/api/admin/whois");
  getForm("#admin-events-form", "/api/admin/events");
  getForm("#admin-tg-form", "/api/admin/find-tg");
  getForm("#admin-vk-form", "/api/admin/find-vk");
  adminForm("#admin-bind-form", "/api/admin/bind");
  adminForm("#admin-unbind-form", "/api/admin/unbind");

  // tag form inputs with data-admin attributes
  const tag = (id, name) => {
    const el = $(id);
    if (el) el.dataset.admin = name;
  };
  tag("#admin-whois-uid", "uid"); tag("#admin-whois-email", "email"); tag("#admin-whois-scid", "scid");
  tag("#admin-events-uid", "uid");
  tag("#admin-tg-ids", "tg_user_ids");
  tag("#admin-vk-id", "vk_user_id");
  tag("#admin-bind-uid", "uid"); tag("#admin-bind-player", "player_id"); tag("#admin-bind-game", "game"); tag("#admin-bind-sync", "sync");
  tag("#admin-unbind-scid", "scid"); tag("#admin-unbind-sync", "sync");
};

/* -------------------------------- history --------------------------------- */

async function loadHistory() {
  const log = $("#hist-log");
  const count = $("#hist-count");
  try {
    const data = await api("/api/activity");
    activity = data.entries || [];
    count.textContent = `${activity.length} entries`;
    renderHistory(activity);
  } catch (err) {
    log.className = "empty-hint";
    log.textContent = err.message;
  }
}

function renderHistory(entries) {
  const log = $("#hist-log");
  const filter = ($("#hist-filter").value || "").toLowerCase();
  const filtered = filter
    ? entries.filter(
        (a) =>
          a.path.toLowerCase().includes(filter) ||
          a.upstream?.toLowerCase().includes(filter) ||
          String(a.status).includes(filter) ||
          a.method.toLowerCase().includes(filter) ||
          (a.auth ? "token" : "public").includes(filter)
      )
    : entries;
  if (!filtered.length) {
    log.className = "empty-hint";
    log.textContent = filter ? "No entries match the filter." : "Nothing logged yet — run any operation and it appears here (tokens masked).";
    return;
  }
  log.className = "";
  log.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Time</th><th>Method</th><th>Endpoint</th><th>Upstream</th><th>Auth</th><th>Status</th><th>ms</th><th></th></tr></thead>
    <tbody>${filtered
      .map(
        (a) => `<tr>
          <td class="mono">${fmtTime(a.time)}</td>
          <td><span class="badge cyan">${esc(a.method)}</span></td>
          <td class="mono">${esc(a.path)}</td>
          <td class="mono">${a.upstream ? esc(a.upstream) : "—"}</td>
          <td>${a.auth ? '<span class="badge accent">token</span>' : '<span class="badge">public</span>'}</td>
          <td>${statusBadge(a.status)}</td>
          <td class="mono">${esc(a.ms)}</td>
          <td><details class="json-details"><summary>response</summary><pre class="json">${esc(JSON.stringify(a.data, null, 2))}</pre></details></td>
        </tr>`
      )
      .join("")}</tbody></table></div>`;
}

PAGE_INIT.history = () => {
  $("#hist-filter").oninput = () => renderHistory(activity);
  $("#hist-rerun-diag").onclick = async (e) => {
    const btn = e.target;
    btn.disabled = true;
    try {
      await api("/api/diagnostics");
      toast("Diagnostics run complete.", "success");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
    loadHistory();
  };
  loadHistory();
};

/* ------------------------------ global search ------------------------------ */

let searchIndex = [];

function buildSearchIndex() {
  const idx = [];
  if (!kb) return;
  for (const op of kb.operations) {
    idx.push({ kind: "Operation", title: op.label, sub: `${op.method} ${op.path}`, page: "explorer", op: op.id });
    for (const p of op.params) idx.push({ kind: "Parameter", title: `${op.label} — ${p.name}`, sub: p.type || "", page: "explorer", op: op.id });
    for (const f of op.fields) idx.push({ kind: "Field", title: `${op.label} — ${f}`, sub: "response field", page: "explorer", op: op.id });
    for (const er of op.errors) idx.push({ kind: "Error", title: er, sub: op.label, page: "explorer", op: op.id });
  }
  for (const g of kb.games) idx.push({ kind: "Game", title: g.id, sub: "game identifier", page: "explorer", tab: "games" });
  for (const t of kb.lookupTypes) idx.push({ kind: "Lookup type", title: t.value, sub: t.status, page: "explorer", tab: "ops", op: "profile-lookup" });
  for (const m of kb.imageMechanisms) idx.push({ kind: "Image mechanism", title: m.id, sub: m.endpoint, page: "explorer", tab: "images" });
  for (const h of kb.hiddenParams) idx.push({ kind: "Hidden param", title: `${h.op} — ${h.param}`, sub: h.type, page: "explorer", tab: "ops", op: "profile-update" });
  for (const [k, v] of Object.entries(kb.errorCatalog || {})) idx.push({ kind: "Error", title: k, sub: v.message, page: "explorer" });
  for (const a of activity) idx.push({ kind: "History", title: a.path, sub: `${a.status} · ${a.ms}ms`, page: "history" });
  searchIndex = idx;
}

function renderSearch(q) {
  const box = $("#search-results");
  if (!q) {
    box.classList.add("hidden");
    return;
  }
  const needle = q.toLowerCase();
  const hits = searchIndex.filter((h) => (h.title + " " + h.sub).toLowerCase().includes(needle)).slice(0, 14);
  if (!hits.length) {
    box.classList.remove("hidden");
    box.innerHTML = `<div class="sd-head">no matches</div>`;
    return;
  }
  const groups = {};
  for (const h of hits) (groups[h.kind] ||= []).push(h);
  box.classList.remove("hidden");
  box.innerHTML = Object.entries(groups)
    .map(
      ([kind, items]) =>
        `<div class="sd-head">${esc(kind)}</div>` +
        items.map((h) => `<div class="sd-item" data-idx="${searchIndex.indexOf(h)}"><span class="sd-title">${esc(h.title)}</span><span class="sd-sub">${esc(h.sub)}</span></div>`).join("")
    )
    .join("");
  $$(".sd-item", box).forEach((el) => {
    el.onclick = () => {
      const h = searchIndex[Number(el.dataset.idx)];
      box.classList.add("hidden");
      $("#global-search").value = "";
      if (h.kind === "History") {
        showPage("history");
        return;
      }
      if (h.tab) {
        openExplorerTab(h.tab);
        if (h.op) renderOpDetail(h.op);
      } else if (h.op) {
        openOp(h.op);
      } else if (h.kind === "Error" && !h.op) {
        const e = kb.errorCatalog[h.title];
        toast(`${h.title}: ${e ? e.message : ""}`, "error");
      } else {
        showPage(h.page || "overview");
      }
    };
  });
}

function openExplorerTab(tab) {
  showPage("explorer");
  $$("#exp-tabs .tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === tab));
  $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
  $("#exp-" + tab).classList.remove("hidden");
  if (tab === "images") renderImages();
  if (tab === "ops") renderOpsGroups();
}

/* ----------------------------------- boot ----------------------------------- */

function wireNav() {
  $$(".nav-btn").forEach((btn) => (btn.onclick = () => showPage(btn.dataset.page)));
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-goto]");
    if (t) showPage(t.dataset.goto);
  });
  $("#session-pill").onclick = () => showPage("session");

  const adv = localStorage.getItem("nc_adv") === "1";
  $("#adv-toggle").checked = adv;
  document.body.classList.toggle("adv", adv);
  $("#adv-toggle").onchange = (e) => {
    document.body.classList.toggle("adv", e.target.checked);
    localStorage.setItem("nc_adv", e.target.checked ? "1" : "0");
  };

  $("#global-search").oninput = (e) => renderSearch(e.target.value);
  $("#global-search").onkeydown = (e) => {
    if (e.key === "Enter") {
      const first = $(".sd-item");
      if (first) first.click();
    }
  };
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrap")) $("#search-results").classList.add("hidden");
  });

  // game probe + image resolve wiring (explorer)
  $("#probe-game-form").onsubmit = (e) => {
    e.preventDefault();
    if (!session.authenticated) {
      toast("Probing requires a connected session.", "error");
      return;
    }
    probeGame($("#probe-game-input").value.trim());
  };
  $("#image-form").onsubmit = (e) => {
    e.preventDefault();
    resolveImage($("#image-input").value.trim());
  };
}

async function boot() {
  wireNav();
  await refreshSession();
  try {
    kb = await api("/api/discovery/registry");
  } catch (e) {
    toast("Could not load the discovery registry: " + e.message, "error");
  }
  await loadHistory();
  buildSearchIndex();
  const initial = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
  showPage(initial);
}

boot();
