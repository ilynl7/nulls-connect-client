/* nulls-connect web client — views (rendered by the core router) */

/* ------------------------------ shared helpers ------------------------------ */

function field({ id, label, type = "text", value = "", placeholder = "", required = false, hint = "", autocomplete }) {
  const attrs = [
    `id="${id}"`,
    `type="${type}"`,
    `value="${esc(value)}"`,
    placeholder ? `placeholder="${esc(placeholder)}"` : "",
    required ? "required" : "",
    autocomplete ? `autocomplete="${autocomplete}"` : "",
  ].join(" ");
  return `<label class="field">${esc(label)}${required ? ' <span class="req">*</span>' : ""}
    <input ${attrs}/>
    ${hint ? `<span class="hint">${esc(hint)}</span>` : ""}
  </label>`;
}

function btnState(btn, busy, label) {
  if (!btn) return;
  btn.disabled = busy;
  if (busy) {
    btn.dataset.old = btn.textContent;
    btn.textContent = label || "…";
  } else {
    btn.textContent = btn.dataset.old || btn.textContent;
  }
}

function kv(list) {
  return `<table class="kv">${list
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v === null || v === undefined || v === "" ? '<span class="muted">—</span>' : esc(v)}</td></tr>`)
    .join("")}</table>`;
}

function rawBlock(data, cls = "") {
  return `<pre class="raw ${cls}">${esc(JSON.stringify(data, null, 2))}</pre>`;
}

function notAuthedCard(what = "This section needs an active session") {
  return `<div class="card empty">
    <div class="empty-icon">◉</div>
    <h3>Not connected</h3>
    <p class="muted">${esc(what)}. Sign in with your email to continue.</p>
    <a class="btn btn-primary" href="#/connect">Go to connect</a>
  </div>`;
}

function errCard(message, detail) {
  return `<div class="card"><div class="err">${esc(message)}</div>${detail ? rawBlock(detail, "err-raw") : ""}</div>`;
}

/* ------------------------------ operation cards ------------------------------ */
// Generic builder for single-purpose forms (bind, transfer, oauth, admin…)

function opCard({ id, name, path, note, params = [], confirmText, danger = false, run }) {
  const fieldsHtml = params
    .map((p, i) =>
      field({
        id: `${id}_${i}`,
        label: p.label || p.name,
        type: p.type || "text",
        value: p.def || "",
        placeholder: p.placeholder || p.name,
        required: !!p.required,
        hint: p.hint || "",
      })
    )
    .join("");
  return `<div class="card op-card" data-op="${id}">
    <div class="card-head"><h2>${esc(name)}</h2><code class="chip">${esc(path)}</code></div>
    ${note ? `<p class="muted">${esc(note)}</p>` : ""}
    ${params.length ? `<div class="grid-2">${fieldsHtml}</div>` : ""}
    <div class="row-actions">
      <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-run="${id}">${esc(name.toLowerCase())}</button>
    </div>
    <div class="op-result hidden"></div>
  </div>`;
}

function bindOpCards() {
  $$(".op-card").forEach((card) => {
    const id = card.dataset.op;
    const cfg = opConfigs.find((c) => c.id === id);
    const btn = card.querySelector(`[data-run="${id}"]`);
    const result = card.querySelector(".op-result");
    btn.addEventListener("click", async () => {
      const params = {};
      for (let i = 0; i < cfg.params.length; i++) {
        const input = card.querySelector(`#${id}_${i}`);
        const v = input.value.trim();
        if (cfg.params[i].required && !v) {
          result.className = "op-result";
          result.innerHTML = `<div class="err">Required: ${esc(cfg.params[i].label || cfg.params[i].name)}.</div>`;
          return;
        }
        params[cfg.params[i].name] = v;
      }
      if (cfg.confirmText && !(await confirmModal({ title: cfg.name, message: cfg.confirmText, confirmText: "Continue", danger: cfg.danger }))) return;
      btnState(btn, true);
      try {
        const data = await cfg.run(params);
        result.className = "op-result";
        result.innerHTML = `<div class="ok-msg">Success.</div>${data ? rawBlock(data) : ""}`;
        toast(`${cfg.name} — done.`, "success");
        if (cfg.onSuccess) cfg.onSuccess(data);
      } catch (err) {
        result.className = "op-result";
        result.innerHTML = errCard(err.message, err.data && err.data.upstream ? err.data.upstream : null);
      } finally {
        btnState(btn, false);
      }
    });
  });
}

/* --------------------------------- dashboard --------------------------------- */

window.renderDashboard = () => {
  if (!sessionState.authenticated) {
    return `<section class="hero">
      <p class="hero-kicker">NULL'S CONNECT · API 1.2.1 · GAME <code>laser</code></p>
      <h1>Your Null's Connect accounts, <span class="accent">in the browser.</span></h1>
      <p class="hero-sub">A web reimplementation of the C client: sign in by email + PIN, manage linked game accounts, mint game tokens, look up and update profiles, and inspect every request. The bearer token never leaves the server.</p>
      <div class="hero-actions">
        <a class="btn btn-primary" href="#/connect">Connect with email</a>
        <a class="btn" href="#/profiles">Search a profile</a>
        <a class="btn" href="#/developer">Open developer tools</a>
      </div>
    </section>`;
  }
  return `<div class="loading"><span class="spinner"></span> loading your account…</div>`;
};

window.afterRender = window.afterRender || {};

window.afterRender.dashboard = async () => {
  const view = $("#view");
  const [me, health] = await Promise.all([
    api("/app/me").catch((e) => ({ __error: e })),
    api("/app/health").catch((e) => ({ __error: e })),
  ]);
  if (me.__error) {
    view.innerHTML = errCard(me.__error.message);
    return;
  }
  const user = me.user;
  const accounts = me.accounts || [];
  const healthOk = health && !health.__error ? health : null;

  const stat = (label, value, cls = "") =>
    `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value ${cls}">${value}</div></div>`;

  view.innerHTML = `
    <div class="view-head">
      <h1>Dashboard</h1>
      <p class="muted">Signed in as <b>${esc(sessionState.email || "?")}</b> — the session token is held by the server.</p>
    </div>

    <section class="stat-grid">
      ${stat("Service", healthOk ? (healthOk.upstream === "ok" ? "online" : "unreachable") : "unknown", healthOk && healthOk.upstream === "ok" ? "yes" : "no")}
      ${healthOk ? stat("Latency", `${healthOk.latencyMs}ms`) : stat("Latency", "—")}
      ${stat("Connect user id", user && user.user_id != null ? user.user_id : "—")}
      ${stat("Linked accounts", accounts.length)}
    </section>

    <section class="grid-2">
      <div class="card">
        <div class="card-head"><h2>Account</h2><a class="btn btn-sm" href="#/accounts">manage</a></div>
        ${
          user
            ? kv([
                ["user_id", user.user_id],
                ["allow_transfer", user.allow_transfer ? "yes" : "no"],
                ["Telegram", user.tg_name || "not linked"],
                ["tg_bind_url", user.tg_bind_url],
                ["vk_client_id", user.vk_client_id],
              ])
            : `<div class="err">${esc(me.userError || "Settings unavailable.")}</div>`
        }
      </div>

      <div class="card">
        <div class="card-head"><h2>Linked accounts</h2><a class="btn btn-sm" href="#/accounts">open</a></div>
        ${
          accounts.length
            ? accounts
                .map(
                  (a) => `<div class="acc-row">
                    <div>
                      <div class="acc-name">${esc((a.player_info && (a.player_info.tag || a.player_info.name)) || "untagged")}</div>
                      <div class="muted acc-id">${esc(a.player_id)}</div>
                    </div>
                    <div class="acc-right">
                      ${a.is_current ? '<span class="chip chip-green">current</span>' : ""}
                      <span class="muted">${a.player_info && a.player_info.score != null ? esc(a.player_info.score) : ""}</span>
                    </div>
                  </div>`
                )
                .join("")
            : `<p class="muted">No linked accounts yet. Use <b>bind</b> in the Accounts view.</p>`
        }
      </div>
    </section>

    <section class="grid-3 quick">
      <a class="quick-card" href="#/accounts"><span>⇄</span><b>Accounts</b><small>links · game tokens · bind · transfer · refresh</small></a>
      <a class="quick-card" href="#/profiles"><span>⌕</span><b>Profiles</b><small>lookup by handle or game account id · update</small></a>
      <a class="quick-card" href="#/developer"><span>▤</span><b>Developer</b><small>request history · diagnostics · API reference</small></a>
    </section>`;
};

/* --------------------------------- connect --------------------------------- */

window.renderConnect = () => {
  if (sessionState.authenticated) {
    return `<div class="view-head"><h1>Connect</h1></div>
      <div class="card">
        <div class="card-head"><h2>Session</h2><span class="chip chip-green">active</span></div>
        ${kv([
          ["email", sessionState.email],
          ["token storage", "server-side only (HttpOnly session cookie)"],
          ["idle timeout", "6 hours"],
        ])}
        <div class="row-actions"><button class="btn btn-ghost" id="disconnectBtn">disconnect</button></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Import an existing token</h2></div>
        <p class="muted">Equivalent to the C client's "Account management → enter your auth token": paste a Connect bearer token to start a session with it.</p>
        <div class="grid-2">
          ${field({ id: "importEmail", label: "email (optional label)", type: "email" })}
          ${field({ id: "importToken", label: "bearer token", type: "password", required: true, autocomplete: "off" })}
        </div>
        <div class="row-actions"><button class="btn btn-primary" id="importBtn">import token</button></div>
        <div id="importResult" class="hidden"></div>
      </div>`;
  }
  return `<div class="view-head"><h1>Connect</h1>
      <p class="muted">Login reproduces the C client's flow: the API emails a 6-digit PIN, you submit it, and the server keeps the resulting bearer token out of the browser.</p>
    </div>
    <section class="grid-2">
      <div class="card">
        <div class="card-head"><h2>Sign in with email</h2><span class="chip">/auth/login.v2</span></div>
        <div class="grid-2">
          ${field({ id: "loginEmail", label: "email", type: "email", required: true, autocomplete: "email" })}
          ${field({ id: "loginGame", label: "game", value: "laser" })}
        </div>
        <div class="row-options">
          <label class="check"><input id="loginCanRegister" type="checkbox"/> can_register (register if new)</label>
          <label class="check">locale
            <select id="loginLocale"><option value="ru">ru</option><option value="en">en</option></select>
          </label>
        </div>
        <div class="row-actions"><button class="btn btn-primary" id="loginBtn">send code</button></div>
        <div id="loginMsg" class="hidden"></div>
        <div id="pinBlock" class="hidden pin-block">
          <div class="pin-row">
            <input id="loginPin" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code"/>
            <button class="btn btn-primary" id="pinBtn">verify pin</button>
            <button class="btn btn-ghost" id="pinCancelBtn">cancel</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Import an existing token</h2></div>
        <p class="muted">Equivalent to the C client's "Account management → enter your auth token".</p>
        <div class="grid-2">
          ${field({ id: "importEmail2", label: "email (optional label)", type: "email" })}
          ${field({ id: "importToken2", label: "bearer token", type: "password", required: true, autocomplete: "off" })}
        </div>
        <div class="row-actions"><button class="btn btn-primary" id="importBtn2">import token</button></div>
        <div id="importResult2" class="hidden"></div>
      </div>
    </section>`;
};

window.afterRender.connect = () => {
  const msg = $("#loginMsg");
  const show = (text, kind = "err") => {
    msg.innerHTML = `<div class="${kind === "ok" ? "ok-msg" : "err"}">${esc(text)}</div>`;
    msg.classList.remove("hidden");
  };

  const startLogin = async () => {
    msg.classList.add("hidden");
    const email = $("#loginEmail").value.trim();
    if (!email) return show("Enter an email address first.");
    const btn = $("#loginBtn");
    btnState(btn, true, "sending…");
    try {
      const data = await api("/app/session/start", {
        method: "POST",
        body: {
          email,
          game: $("#loginGame").value.trim() || "laser",
          locale: $("#loginLocale").value,
          can_register: $("#loginCanRegister").checked,
        },
      });
      if (data.pin_required) {
        $("#pinBlock").classList.remove("hidden");
        $("#loginPin").focus();
        show(`PIN sent to ${esc(email)} — enter the 6-digit code.`, "ok");
      } else if (data.authenticated) {
        show("Authenticated.", "ok");
        refreshSession(false);
        location.hash = "#/dashboard";
      }
    } catch (err) {
      show(err.message);
    } finally {
      btnState(btn, false);
    }
  };

  const verifyPin = async () => {
    const pin = $("#loginPin").value.trim();
    if (!/^\d{6}$/.test(pin)) return show("The PIN is a 6-digit code.");
    const btn = $("#pinBtn");
    btnState(btn, true, "verifying…");
    try {
      const data = await api("/app/session/verify", { method: "POST", body: { pin, locale: $("#loginLocale").value } });
      if (data.authenticated) {
        $("#pinBlock").classList.add("hidden");
        $("#loginPin").value = "";
        show("Authenticated. Session is active.", "ok");
        refreshSession(false);
        location.hash = "#/dashboard";
      }
    } catch (err) {
      show(err.message);
    } finally {
      btnState(btn, false);
    }
  };

  const wireImport = (emailId, tokenId, btnId, resId) => {
    $(btnId).addEventListener("click", async () => {
      const res = $(resId);
      res.classList.add("hidden");
      const token = $(tokenId).value.trim();
      if (!token) return;
      const btn = $(btnId);
      btnState(btn, true, "importing…");
      try {
        await api("/app/session/import", { method: "POST", body: { token, email: $(emailId).value.trim() || undefined } });
        toast("Session started with the imported token.", "success");
        refreshSession(false);
        location.hash = "#/dashboard";
      } catch (err) {
        res.innerHTML = errCard(err.message);
        res.classList.remove("hidden");
      } finally {
        btnState(btn, false);
      }
    });
  };

  $("#loginBtn").addEventListener("click", startLogin);
  $("#loginEmail").addEventListener("keydown", (e) => e.key === "Enter" && startLogin());
  $("#pinBtn").addEventListener("click", verifyPin);
  $("#loginPin").addEventListener("keydown", (e) => e.key === "Enter" && verifyPin());
  $("#pinCancelBtn").addEventListener("click", () => {
    $("#pinBlock").classList.add("hidden");
    $("#loginPin").value = "";
    msg.classList.add("hidden");
  });
  const d = $("#disconnectBtn");
  if (d) d.addEventListener("click", () => $("#logoutBtn").click());
  if ($("#importBtn")) wireImport("importEmail", "importToken", "importBtn", "importResult");
  if ($("#importBtn2")) wireImport("importEmail2", "importToken2", "importBtn2", "importResult2");
};

/* --------------------------------- accounts --------------------------------- */

let accountsCache = [];

window.renderAccounts = () => {
  if (!sessionState.authenticated) return notAuthedCard("The accounts view needs a session (it lists your linked game accounts).");
  return `<div class="view-head"><h1>Accounts</h1>
      <p class="muted">Linked game accounts for <code>game=laser</code> — equivalent to the C client's "Account management".</p>
    </div>
    <div id="accountsRoot"><div class="loading"><span class="spinner"></span> loading…</div></div>`;
};

window.afterRender.accounts = async () => {
  const root = $("#accountsRoot");
  try {
    const data = await api("/app/accounts");
    accountsCache = data.accounts || [];
    renderAccountsView(root);
  } catch (err) {
    root.innerHTML = errCard(err.message);
  }
};

function renderAccountsView(root) {
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Linked accounts</h2><button class="btn btn-sm" id="reloadAccounts">reload</button></div>
      <label class="field">filter <input id="accountFilter" placeholder="tag, name or player_id…"/></label>
      <div id="accountsList"></div>
    </div>
    <section class="grid-2">
      ${opCard(ops.bind)}
      ${opCard(ops.transfer)}
      ${opCard(ops.refresh)}
      ${opCard(ops.unlinkTg)}
    </section>
    <div id="tokenModal"></div>`;
  bindOpCards();
  $("#reloadAccounts").addEventListener("click", () => window.afterRender.accounts());
  $("#accountFilter").addEventListener("input", () => paintAccounts($("#accountFilter").value));
  paintAccounts("");
}

function paintAccounts(query) {
  const q = query.trim().toLowerCase();
  const list = accountsCache.filter((a) => {
    if (!q) return true;
    const info = a.player_info || {};
    return [a.player_id, info.tag, info.name].some((v) => v && String(v).toLowerCase().includes(q));
  });
  const wrap = $("#accountsList");
  if (!list.length) {
    wrap.innerHTML = `<div class="empty"><h3>${accountsCache.length ? "No matches." : "No linked accounts"}</h3>
      <p class="muted">${accountsCache.length ? "Try a different search." : "Link one with the bind form below."}</p></div>`;
    return;
  }
  wrap.innerHTML = `<table class="mono-table">
    <thead><tr><th>tag</th><th>name</th><th>score</th><th>player_id</th><th>current</th><th></th></tr></thead>
    <tbody>${list
      .map(
        (a, i) => `<tr>
          <td>${esc((a.player_info && a.player_info.tag) || "—")}</td>
          <td>${esc((a.player_info && a.player_info.name) || "—")}</td>
          <td class="num">${a.player_info && a.player_info.score != null ? esc(a.player_info.score) : "—"}</td>
          <td class="cell-id">${esc(a.player_id)}</td>
          <td class="${a.is_current ? "yes" : "no"}">${a.is_current ? "yes" : ""}</td>
          <td style="text-align:right"><button class="btn btn-sm" data-tok="${i}">game token</button></td>
        </tr>`
      )
      .join("")}
    </tbody></table>`;
  wrap.querySelectorAll("[data-tok]").forEach((b) => {
    b.addEventListener("click", async () => {
      const acc = list[Number(b.dataset.tok)];
      b.disabled = true;
      try {
        const data = await api(`/app/accounts/${encodeURIComponent(acc.player_id)}/token`);
        const info = data.player_info || {};
        showTokenModal(
          `Game token · ${info.tag || acc.player_id}`,
          data.token || "(empty token in response)",
          `player_id: ${acc.player_id} · refresh tokens to revoke it`
        );
      } catch (err) {
        toast(err.message, "error");
      } finally {
        b.disabled = false;
      }
    });
  });
}

function showTokenModal(title, token, subtitle) {
  const root = $("#modalRoot");
  root.innerHTML = "";
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <h3>${esc(title)}</h3>
      ${subtitle ? `<p class="muted">${esc(subtitle)}</p>` : ""}
      <pre class="raw token-raw">${esc(token)}</pre>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-act="close">close</button>
        <button class="btn btn-primary" data-act="copy">copy</button>
      </div>
    </div>`;
  overlay.querySelector('[data-act="close"]').addEventListener("click", () => overlay.remove());
  overlay.querySelector('[data-act="copy"]').addEventListener("click", (e) => copyText(token, e.currentTarget));
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
  root.appendChild(overlay);
}

/* --------------------------------- profiles --------------------------------- */

window.renderProfiles = () => `<div class="view-head"><h1>Profiles</h1>
    <p class="muted">The profile service (<code>profiles.dnull.xyz</code>) — equivalent to the C client's "Profile API" menu.</p>
  </div>
  <div class="card">
    <div class="card-head"><h2>Look up a profile</h2><span class="chip">public</span></div>
    <div class="grid-2">
      ${field({ id: "pfQ", label: "value", required: true, placeholder: "handle or game account id" })}
      <label class="field">lookup type
        <select id="pfBy">
          <option value="handle">Handle</option>
          <option value="game_account_id">GameAccountId</option>
        </select>
      </label>
    </div>
    <div class="row-actions"><button class="btn btn-primary" id="pfSearchBtn">search profile</button></div>
    <div id="pfResult"></div>
  </div>
  <div class="card">
    <div class="card-head"><h2>Update profile handle</h2><span class="chip">needs account token</span></div>
    <p class="muted">Equivalent to the C client's "Update Profile": changes the handle using the game-account bearer token (the one you get from <a href="#/accounts">Accounts → game token</a>). The image reference sent is the same constant the C client hardcodes.</p>
    <div class="grid-2">
      ${field({ id: "pfNewHandle", label: "new handle", required: true })}
      ${field({ id: "pfAccToken", label: "account token", type: "password", required: true, autocomplete: "off" })}
    </div>
    <div class="row-actions"><button class="btn btn-danger" id="pfUpdateBtn">update handle</button></div>
    <div id="pfUpdateResult"></div>
  </div>`;

window.afterRender.profiles = () => {
  $("#pfSearchBtn").addEventListener("click", async () => {
    const q = $("#pfQ").value.trim();
    const by = $("#pfBy").value;
    if (!q) return;
    const btn = $("#pfSearchBtn");
    btnState(btn, true, "searching…");
    const res = $("#pfResult");
    try {
      const data = await api(`/app/profiles/search?q=${encodeURIComponent(q)}&by=${by}`);
      const profile = data && data.account_id ? data : null;
      res.innerHTML = profile
        ? `<div class="ok-msg">Profile found.</div>
           ${kv([
             ["account_id", profile.account_id],
             ["game_account_id", profile.game_account_id],
             ["handle", profile.handle],
             ["image_ref", profile.image_ref],
           ])}
           <details class="advanced"><summary>view raw response</summary>${rawBlock(data)}</details>`
        : `<div class="err">The service did not return a profile for this value.</div>${rawBlock(data, "err-raw")}`;
    } catch (err) {
      res.innerHTML = errCard(err.message, err.data && err.data.upstream ? err.data.upstream : null);
    } finally {
      btnState(btn, false);
    }
  });

  $("#pfUpdateBtn").addEventListener("click", async () => {
    const handle = $("#pfNewHandle").value.trim();
    const token = $("#pfAccToken").value.trim();
    if (!handle || !token) return toast("Enter a new handle and the account token.", "error");
    if (
      !(await confirmModal({
        title: "Update profile handle",
        message: `This changes the handle of the profile that owns this account token to "${handle}". Continue?`,
        confirmText: "Update",
        danger: true,
      }))
    )
      return;
    const btn = $("#pfUpdateBtn");
    btnState(btn, true, "updating…");
    const res = $("#pfUpdateResult");
    try {
      const data = await api("/app/profiles/update", { method: "POST", body: { handle, token } });
      res.innerHTML = `<div class="ok-msg">Profile updated.</div>${rawBlock(data)}`;
      toast("Profile updated.", "success");
    } catch (err) {
      res.innerHTML = errCard(err.message, err.data && err.data.upstream ? err.data.upstream : null);
    } finally {
      btnState(btn, false);
    }
  });
};

/* --------------------------------- admin --------------------------------- */

window.renderAdmin = () => {
  if (!sessionState.authenticated) return notAuthedCard("Admin endpoints need a session.");
  return `<div class="view-head"><h1>Admin</h1>
      <p class="muted">Admin-only endpoints from the API spec. They run server-side with your session token — the service rejects them with <code>403</code> unless the token is an admin token.</p>
    </div>
    <section class="grid-2">
      ${opCard(ops.whois)}${opCard(ops.events)}
      ${opCard(ops.findTg)}${opCard(ops.findVk)}
      ${opCard(ops.adminBind)}${opCard(ops.adminUnbind)}
    </section>`;
};

window.afterRender.admin = () => bindOpCards();

/* --------------------------------- developer --------------------------------- */

const OPS_REF = [
  ["session/start", "POST", "email · game · locale · can_register", "Start login; returns pin_required or authenticated."],
  ["session/verify", "POST", "pin", "Complete login with the emailed PIN."],
  ["session/import", "POST", "token · email?", "Start a session from a pasted bearer token (C: 'enter ur auth token')."],
  ["accounts", "GET", "—", "Linked game accounts (C: Linked accounts)."],
  ["accounts/:player_id/token", "GET", "—", "Game token for an account (C: Account token)."],
  ["refresh", "POST", "—", "Refresh all bindings, revoking existing tokens (C: Refresh tokens)."],
  ["bind", "POST", "bind_token · game", "Link a new game account."],
  ["transfer", "POST", "dest_token · player_ids", "Transfer bindings to another account."],
  ["settings", "GET", "—", "Account settings (user_id, allow_transfer, tg)."],
  ["settings/unlink-tg", "POST", "—", "Remove Telegram binding."],
  ["oauth/info", "POST", "redirect_uri · client_id", "OAuth client display info."],
  ["oauth/token", "POST", "scope · client_id · state? · nonce? · player_id? · game", "OAuth authorization, returns id_token."],
  ["profiles/search", "GET", "q · by=handle|game_account_id", "Profile lookup (C: Search by Handle/GameAccountId)."],
  ["profiles/update", "POST", "handle · token", "Update profile handle (C: Update Profile)."],
  ["admin/whois", "GET", "uid? · email? · scid?", "Full account information."],
  ["admin/events", "GET", "uid", "Account event history."],
  ["admin/find-tg", "GET", "ids", "Account ids for telegram ids."],
  ["admin/find-vk", "GET", "vk_user_id", "Accounts linked via legacy VK binding."],
  ["admin/bind", "POST", "uid · player_id · sync · game", "Create a binding."],
  ["admin/unbind", "POST", "scid · sync", "Remove a binding."],
];

window.renderDeveloper = () => `<div class="view-head"><h1>Developer</h1>
    <p class="muted">Diagnostics, request history, and a reference for every operation the backend exposes.</p>
  </div>
  <section class="grid-2">
    <div class="card">
      <div class="card-head"><h2>Service diagnostics</h2><button class="btn btn-sm" id="diagBtn">re-check</button></div>
      <div id="diagBody"><div class="loading"><span class="spinner"></span> checking…</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Session</h2></div>
      ${kv([
        ["authenticated", sessionState.authenticated ? "yes" : "no"],
        ["email", sessionState.email || "—"],
        ["bearer token in browser", "no — server-side HttpOnly session"],
      ])}
    </div>
  </section>
  <div class="card">
    <div class="card-head"><h2>Request history</h2><button class="btn btn-ghost btn-sm" id="clearHist">clear</button></div>
    <p class="muted">Requests made from this browser session. Token-shaped values are masked by default; reveal per entry.</p>
    <div id="histList"></div>
  </div>
  <div class="card">
    <div class="card-head"><h2>Operations</h2><span class="chip">/app/*</span></div>
    <table class="mono-table">
      <thead><tr><th>path</th><th>method</th><th>parameters</th><th>purpose</th></tr></thead>
      <tbody>${OPS_REF.map(
        ([path, m, p, note]) =>
          `<tr><td class="cell-id">${esc(path)}</td><td>${esc(m)}</td><td class="muted">${esc(p)}</td><td class="muted">${esc(note)}</td></tr>`
      ).join("")}</tbody>
    </table>
  </div>
  <div class="card">
    <div class="card-head"><h2>API errors</h2></div>
    <table class="mono-table">
      <thead><tr><th>error_type</th><th>meaning</th></tr></thead>
      <tbody>${Object.entries({
        email_flood_limit: "Too many logins for this email — wait.",
        pin_flood_limit: "Too many PIN attempts — wait.",
        pin_invalid: "Wrong PIN.",
        pin_expired: "PIN expired, request a new one.",
        email_invalid: "Email rejected.",
        email_failed: "PIN email could not be delivered.",
        link_not_found: "Link does not exist.",
        bind_not_available: "Bind token not available.",
        bind_limit_exceeded: "Binding limit reached.",
        transfer_not_available: "Transfer not allowed.",
        unknown_game: "Unknown game.",
        oauth_invalid_client_id: "Unknown OAuth client.",
        oauth_invalid_scope: "Scope not allowed.",
        admin_access_denied: "Token is not an admin token.",
        admin_account_not_found: "Account not found.",
        admin_binding_duplicate: "Binding already exists.",
      })
        .map(([k, v]) => `<tr><td class="cell-id">${esc(k)}</td><td class="muted">${esc(v)}</td></tr>`)
        .join("")}</tbody>
    </table>
  </div>`;

window.afterRender.developer = () => {
  const paintHistory = () => {
    const wrap = $("#histList");
    if (!devHistory.length) {
      wrap.innerHTML = `<p class="muted">No requests yet — use the app and they'll show up here.</p>`;
      return;
    }
    wrap.innerHTML = devHistory
      .map((h, i) => {
        const cls = h.status === "ERR" ? "bad" : h.status >= 500 ? "bad" : h.status >= 400 ? "warn" : "ok";
        return `<div class="log-entry ${cls}" data-hi="${i}">
          <div class="log-head">
            <span class="log-time">${fmtTime(h.time)}</span>
            <span class="log-status">${h.status}</span>
            <span class="log-url">${esc(h.method)} ${esc(h.path)}</span>
            <span class="log-ms">${h.ms}ms</span>
          </div>
          <div class="log-body"><pre class="raw">${esc(JSON.stringify(redact(h.payload), null, 2))}</pre>
            <button class="btn btn-ghost btn-sm" data-reveal="${i}">reveal raw</button></div>
        </div>`;
      })
      .join("");
    wrap.querySelectorAll(".log-entry").forEach((entry) => {
      entry.addEventListener("click", (e) => {
        if (e.target.closest("[data-reveal]")) return;
        entry.classList.toggle("open");
      });
    });
    wrap.querySelectorAll("[data-reveal]").forEach((b) => {
      b.addEventListener("click", () => {
        const h = devHistory[Number(b.dataset.reveal)];
        const pre = b.parentElement.querySelector("pre");
        pre.textContent = JSON.stringify(h.payload, null, 2);
        b.remove();
      });
    });
  };
  paintHistory();
  $("#clearHist").addEventListener("click", () => {
    devHistory.length = 0;
    paintHistory();
  });
  $("#diagBtn").addEventListener("click", async () => {
    $("#diagBody").innerHTML = '<div class="loading"><span class="spinner"></span> checking…</div>';
    try {
      const h = await api("/app/health");
      $("#diagBody").innerHTML = kv([
        ["upstream", h.upstream],
        ["latency", `${h.latencyMs}ms`],
      ]);
    } catch (err) {
      $("#diagBody").innerHTML = errCard(err.message);
    }
  });
  api("/app/health")
    .then((h) => {
      $("#diagBody").innerHTML = kv([
        ["upstream", h.upstream],
        ["latency", `${h.latencyMs}ms`],
        ["connect base", "connect.nulls.gg/api"],
        ["profiles base", "profiles.dnull.xyz"],
      ]);
    })
    .catch((err) => {
      $("#diagBody").innerHTML = errCard(err.message);
    });
};

/* ------------------------------ operation configs ------------------------------ */

const ops = {
  // accounts
  bind: {
    id: "bind",
    name: "Bind account",
    path: "POST /app/bind",
    note: "Link a new game account. The bind_token usually comes from the game side.",
    params: [{ name: "bind_token", label: "bind token", required: true }, { name: "game", def: "laser" }],
    run: (p) => api("/app/bind", { method: "POST", body: p }),
  },
  transfer: {
    id: "transfer",
    name: "Transfer bindings",
    path: "POST /app/transfer",
    note: "Moves the given player binding(s) to the account that owns the destination token.",
    params: [
      { name: "dest_token", label: "destination token", required: true },
      { name: "player_ids", label: "player ids (comma separated)", required: true },
    ],
    confirmText: "This transfers the binding(s) to another account. Continue?",
    danger: true,
    run: (p) => api("/app/transfer", { method: "POST", body: p }),
  },
  refresh: {
    id: "refresh",
    name: "Refresh tokens",
    path: "POST /app/refresh",
    note: "Refreshes all bindings — REVOKES every existing game token.",
    confirmText: "This revokes ALL existing game tokens for every linked account. Continue?",
    danger: true,
    params: [],
    run: () => api("/app/refresh", { method: "POST", body: {} }),
    onSuccess: () => window.afterRender.accounts(),
  },
  unlinkTg: {
    id: "unlinkTg",
    name: "Unlink Telegram",
    path: "POST /app/settings/unlink-tg",
    note: "Removes the Telegram binding from this account.",
    confirmText: "Remove the Telegram binding from this account?",
    danger: true,
    params: [],
    run: () => api("/app/settings/unlink-tg", { method: "POST", body: {} }),
  },
  // oauth
  oauthInfo: {
    id: "oauthInfo",
    name: "OAuth · app info",
    path: "POST /app/oauth/info",
    note: "Basic information about an OAuth client (display name).",
    params: [
      { name: "redirect_uri", required: true },
      { name: "client_id", required: true },
    ],
    run: (p) => api("/app/oauth/info", { method: "POST", body: p }),
  },
  oauthToken: {
    id: "oauthToken",
    name: "OAuth · authorize",
    path: "POST /app/oauth/token",
    note: "Authorize the user with the given client; returns an id_token.",
    params: [
      { name: "scope", required: true },
      { name: "client_id", required: true },
      { name: "state" },
      { name: "nonce" },
      { name: "player_id" },
      { name: "game", def: "laser" },
    ],
    run: (p) => api("/app/oauth/token", { method: "POST", body: p }),
  },
  // admin
  whois: {
    id: "whois",
    name: "Whois",
    path: "GET /app/admin/whois",
    note: "Full account information by uid, email, or scid.",
    params: [
      { name: "uid", hint: "integer id" },
      { name: "email" },
      { name: "scid", hint: "uuid" },
    ],
    run: (p) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(p)) if (v) qs.set(k, v);
      return api(`/app/admin/whois?${qs.toString()}`);
    },
  },
  events: {
    id: "events",
    name: "Events",
    path: "GET /app/admin/events",
    note: "Account event history (logins, transfers, tg links…).",
    params: [{ name: "uid", required: true, hint: "integer id" }],
    run: (p) => api(`/app/admin/events?uid=${encodeURIComponent(p.uid)}`),
  },
  findTg: {
    id: "findTg",
    name: "Find by Telegram",
    path: "GET /app/admin/find-tg",
    note: "Account ids related to the given telegram user ids.",
    params: [{ name: "ids", label: "tg user ids (comma separated)", required: true }],
    run: (p) => api(`/app/admin/find-tg?ids=${encodeURIComponent(p.ids)}`),
  },
  findVk: {
    id: "findVk",
    name: "Find by VK",
    path: "GET /app/admin/find-vk",
    note: "Game accounts linked using legacy VK binding.",
    params: [{ name: "vk_user_id", required: true }],
    run: (p) => api(`/app/admin/find-vk?vk_user_id=${encodeURIComponent(p.vk_user_id)}`),
  },
  adminBind: {
    id: "adminBind",
    name: "Admin bind",
    path: "POST /app/admin/bind",
    note: "Create a binding for the given user.",
    confirmText: "Create a binding for another user?",
    danger: true,
    params: [
      { name: "uid", required: true },
      { name: "player_id", required: true },
      { name: "sync", def: "true" },
      { name: "game", def: "laser" },
    ],
    run: (p) => api("/app/admin/bind", { method: "POST", body: p }),
  },
  adminUnbind: {
    id: "adminUnbind",
    name: "Admin unbind",
    path: "POST /app/admin/unbind",
    note: "Remove a binding by its scid.",
    confirmText: "Remove this binding?",
    danger: true,
    params: [{ name: "scid", required: true }, { name: "sync", def: "true" }],
    run: (p) => api("/app/admin/unbind", { method: "POST", body: p }),
  },
};

const opConfigs = Object.values(ops);
