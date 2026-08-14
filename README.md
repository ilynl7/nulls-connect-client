# Nulls Connect Explorer

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](#requirements)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#requirements)
[![Demo](https://img.shields.io/badge/demo-GitHub%20Pages-blueviolet.svg)](https://ilyln7.github.io/nulls-connect-explorer/)

An advanced web-based **Nulls Connect API explorer and tooling platform**, rebuilt from the
C reference client in this repository. It turns the mostly-undocumented Nulls Connect /
Nulls.gg ecosystem (account linking, game tokens, profiles, avatars, OAuth, admin endpoints)
into a safe, browsable, interactive web tool — including capabilities the public website
does not expose.

The repository contains two things:

1. **The web platform** (zero-dependency Node.js backend + static frontend) — the main deliverable.
2. **The original C client** (`main.c`, `menu/`, `cJSON/`, `simpleHTTPclient/`) — the reference
   implementation this project was reverse-engineered from. It still compiles as a CLI tool.

---

## Table of contents

- [Project overview](#project-overview)
- [Features](#features)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Installation](#installation)
- [Environment variables](#environment-variables)
- [Development](#development)
- [Production](#production)
- [Deployment](#deployment)
- [GitHub Pages demo](#github-pages-demo)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)
- [Contributing](#contributing)
- [License](#license)

---

## Project overview

The Nulls Connect ecosystem (connect.nulls.gg) lets players link game accounts to a single
identity, mint per-game authorization tokens, manage profiles on profiles.dnull.xyz, and
integrate via OAuth. Its HTTP API sends **no CORS headers**, is largely undocumented, and its
official reference client is a C command-line tool.

**Nulls Connect Explorer** reimplements that client as a modern web application:

- The browser talks only to a **same-origin backend** that proxies every upstream call, so the
  CORS-less APIs work from any browser.
- Authentication tokens live **server-side** in an HttpOnly session cookie and are attached to
  every upstream request automatically — the browser never handles the bearer token (except an
  explicit on-demand reveal, mirroring what the C CLI prints).
- The discovery workspace exposes **deeper, undocumented behavior** — hidden lookup modes,
  per-player game-token profile editing, the anonymous profile-namespace system, and avatar
  mechanics — with evidence for every finding.

It is a tool for exploring and operating the Nulls Connect system, not a copy of the public
website.

## Features

**Authentication (mirrors the C client)**
- Email + PIN sign-in via `/auth/login.v2` with the same `game=laser&locale=ru` defaults the C
  client uses; optional new-account registration (`can_register`).
- Import an existing token (e.g. from the C CLI); server-side sessions (HttpOnly cookie,
  7-day TTL) with centralized, automatic auth on every request.

**Accounts & bindings**
- List all linked game accounts (`/games/links`) with player info (tag, name, score).
- Mint **per-player game tokens** (`/games/token`), refresh/revoke all tokens
  (`/games/refresh_tokens`), link a new account with a bind token (`/games/bind`), and
  transfer bindings to another identity (`/games/transfer`).
- Account settings (`/settings/get`, `/settings/unlink/tg`) and OAuth client tools
  (`/oauth/info`, `/oauth/token`).

**Profiles (profiles.dnull.xyz)**
- Public profile lookup by **Handle**, **GameAccountId**, or the hidden **AccountId** mode.
- A **game-token profile editor**: pick a linked player, edit handle + avatar from the catalog,
  toggle the hidden `block_friends` parameter. The backend mints the per-player game token and
  never exposes it to the browser — exactly the flow the C client uses.
- An **identity namespace explorer** that scans a player across profile namespaces and reveals
  the auto-generated anonymous profiles (`anonymous:{segment}:{player_id}`) behind any
  non-`laser` path segment.

**Discovery workspace**
- Game identifier registry + live probing of unverified values.
- Image reference resolution: avatar catalog, content redirects, and CDN probes.
- Operation registry: every endpoint with parameters, known enum values, error catalog entries,
  and source/live evidence.

**Admin surface (privileged)**
- Whois by uid/email/scid, account event timelines, find-by-Telegram/VK, and admin
  bind/unbind. These return `admin_access_denied` for non-admin tokens.

**Developer tools**
- Per-session activity log with request timing and **server-side masking** of tokens, PINs and
  `id_token`s; raw JSON views; on-demand token reveal; live upstream diagnostics.
- Input validation and human-readable error mapping for the API's error catalog; per-session
  and per-IP rate limiting.

**C reference client**
- The original CLI still builds with `gcc` (see [Installation](#installation)) — useful for
  comparison or headless use.

## Architecture

```
Browser (index.html + app.js + style.css)
        │  same-origin HTTP (JSON)
        ▼
proxy.mjs  — zero-dependency Node backend
        │  server-side session (HttpOnly cookie, bearer token never sent to browser)
        │  centralized authenticated client: attaches "Authorization: Bearer <token>"
        │  automatically; validation, rate limiting, error mapping, activity log
        ▼
Upstream APIs (CORS-less, proxied server-side)
   ├─ https://connect.nulls.gg/api      (auth, accounts, games, OAuth, admin)
   ├─ https://profiles.dnull.xyz        (profiles, avatars, /update)
   └─ https://files.dnull.xyz           (avatar PNG content)
```

Key design decisions:

- **Backend proxy is required.** The Nulls Connect APIs send no CORS headers, so the browser
  cannot call them directly. All upstream traffic flows through `proxy.mjs`.
- **Centralized authentication.** Every upstream call goes through `callUpstream()`, which
  attaches the session bearer token automatically. Individual features cannot accidentally
  make unauthenticated requests. Public endpoints (login, profile lookup, avatars) opt out
  explicitly. Operations that need a different credential (e.g. profile `/update` needs a
  per-player **game token**) mint it server-side.
- **Sessions are in-memory.** Sessions live in a `Map` in the process; restarting the server
  clears them. This is fine for a tool/explorer deployment behind a single instance — see
  [Deployment](#deployment).

## Requirements

**Web platform**
- [Node.js](https://nodejs.org) **>= 18** (uses global `fetch`, `AbortSignal.timeout`).
- **No npm dependencies** — the backend is zero-dependency Node.

**C reference client** (optional)
- `gcc` and `libcurl` development headers (e.g. `libcurl4-openssl-dev` on Debian/Ubuntu).

**Network**
- Outbound HTTPS access to `connect.nulls.gg`, `profiles.dnull.xyz` and `files.dnull.xyz`.

## Installation

```bash
git clone https://github.com/ilyln7/nulls-connect-explorer.git
cd nulls-connect-explorer

# Web platform — no dependencies to install; start directly:
node proxy.mjs
# or: npm start

# C CLI (optional) — requires gcc + libcurl:
npm run build:c
./output/main
```

`npm install` is a no-op (there is nothing to install) but harmless; `npm start` is the
supported way to launch the web platform.

## Environment variables

The server reads these from the process environment. There is no dotenv loader — either export
them, use a `.env` file with your platform's env support, or set them in your hosting control
panel. A placeholder template lives in [`.env.example`](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP listen port. Hosting providers usually inject this. |
| `NC_API_UPSTREAM` | `https://connect.nulls.gg/api` | Override the Connect API base URL (testing, mirrors, staging). |
| `NC_PROFILES_UPSTREAM` | `https://profiles.dnull.xyz` | Override the Profiles API base URL. |

No authentication secrets are configured via environment variables — the bearer token is
obtained interactively through the app (email + PIN, or token import) and held in the
server-side session.

## Development

```bash
npm run dev      # same as npm start — no build step, no hot reload, plain Node
```

Point a browser at `http://localhost:3000`. The frontend is static (HTML/CSS/JS served by the
backend), so editing `index.html`, `app.js` or `style.css` takes effect on the next page load;
editing `proxy.mjs` requires a server restart.

The **Session** page connects an identity; the **Explorer** and **Profiles** pages work
partially without one (public lookups, avatar catalog, namespace scans, diagnostics).

## Production

There is no compile step for the web platform — the "build" is just the source tree.

```bash
PORT=8080 node proxy.mjs
```

Production considerations:

- The server binds `0.0.0.0` and respects `PORT`.
- Sessions are in-memory: run **one instance** (or a sticky-load-balanced pool) and expect
  sessions to reset on restart. For multi-instance deployments, put it behind a reverse proxy
  (nginx/Caddy) with sticky sessions and HTTPS termination.
- The activity log masks tokens server-side, but the session cookie is a bearer credential —
  serve the app over HTTPS in production.
- Optional CLI diagnostics: run the app, then open **History → Run diagnostics** to verify
  upstream reachability.

## Deployment

This is a standard Node.js web app — no framework, no build step, no database. It deploys to
any Node host that can run a long-lived process.

1. **Install Node.js >= 18** on the host.
2. **Get the code** (clone, or a platform git deploy).
3. **Set environment variables** — at minimum `PORT` (your host may inject it automatically);
   `NC_API_UPSTREAM` / `NC_PROFILES_UPSTREAM` only if you override the defaults.
4. **Start the server** — `npm start` (or `node proxy.mjs`).
5. **Expose it** — the server binds `0.0.0.0:$PORT`; put a TLS-terminating reverse proxy in
   front and forward to the app port.

Example with a process manager (systemd unit sketch):

```ini
[Unit]
Description=Nulls Connect Explorer
After=network.target

[Service]
WorkingDirectory=/opt/nulls-connect-explorer
ExecStart=/usr/bin/node proxy.mjs
Environment=PORT=3000
Restart=on-failure
User=www-data

[Install]
WantedBy=multi-user.target
```

Platform notes:

- **Render / Railway / Fly.io / Heroku-style**: set the start command to `node proxy.mjs` (or
  `npm start`) and let the platform inject `PORT`. No build step required.
- **VPS / container**: `docker run -p 3000:3000 -e PORT=3000 node:20 node proxy.mjs` works
  with the official Node image — there is no Dockerfile in the repo, but none is needed.
- The C CLI is a separate artifact and is not part of the web deployment.

## GitHub Pages demo

GitHub Pages can only serve **static files** — it cannot run the backend that proxies the
CORS-less Nulls Connect APIs. So the repository ships a static showcase at
[`demo/index.html`](demo/index.html) (deployed to
[ilyln7.github.io/nulls-connect-explorer](https://ilyln7.github.io/nulls-connect-explorer/) via
[`.github/workflows/pages.yml`](.github/workflows/pages.yml)).

What the demo includes:

- A polished, self-contained presentation of the project: overview, feature map, architecture,
  and quick-start.
- Honest labeling — every interactive API feature is marked **"requires the deployed backend"**
  because a static host cannot proxy the upstream APIs.

The demo is *not* the application. To use the real thing, deploy the backend (see
[Deployment](#deployment)) and open its URL.

To enable Pages for your fork: **Settings → Pages → Source: GitHub Actions**, then push to
`main`. The workflow installs nothing, syntax-checks the JavaScript, and deploys `demo/` with
the official `actions/deploy-pages`.

## Project structure

```
.
├── index.html            # Frontend: single-page app shell (all pages)
├── app.js                # Frontend: page logic, handlers, rendering (the live UI)
├── style.css             # Frontend: design system
├── proxy.mjs             # BACKEND (live): static server + internal API + upstream proxy
├── core.js               # Legacy frontend core (superseded by app.js — kept for reference)
├── server.mjs            # Legacy backend (superseded by proxy.mjs — kept for reference)
├── views.js              # Legacy frontend views (paired with server.mjs)
├── demo/                 # Static GitHub Pages showcase (self-contained)
├── .github/workflows/    # CI: Pages demo build + deploy
├── main.c                # C reference client — the reverse-engineering source of truth
├── menu/                 # C client menu + dialogs
├── cJSON/                # C client JSON parser (vendored)
├── simpleHTTPclient/     # C client HTTP layer (libcurl)
├── utils/                # C client shared utilities
├── colorcodes.h          # C client ANSI color codes
└── package.json          # Scripts: start / dev / build:c / check
```

**Where to change things:**

- Frontend UI: `index.html`, `app.js`, `style.css`.
- Backend API/routes/proxy: `proxy.mjs` (routes table at the bottom of the file; the discovery
  knowledge base `KB` documents every operation with evidence).
- The discovery registry, error catalog and hidden-parameter notes all live in `proxy.mjs` —
  that is the file to extend when the API surface changes.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `SyntaxError` / server exits immediately | Node < 18 — install Node >= 18 and retry. |
| `Error: listen EADDRINUSE` | `PORT` is taken. Set a different `PORT` and restart. |
| Browser shows the UI but every request fails with `NETWORK` | The backend isn't reachable — start `proxy.mjs` and confirm the app is served from the same origin (the backend must be on the same host/port as the page). |
| "Not connected — log in or import a token first" | No session. Open the **Session** page and connect (email + PIN) or import a token. |
| "Session expired — the API rejected the token" | The bearer token was rejected (wrong, revoked, or the 30-minute account token lapsed mid-session). Reconnect with a fresh token. |
| "Unknown game identifier" | `game` values other than `laser` are rejected by the Connect API. Use the Explorer → Game registry to probe values. |
| Profile update fails with 403 | `/update` needs a per-player **game token**, which the backend mints automatically from your connected session — reconnect with a valid account token first. |
| `422 validation_error` | A required parameter is missing (e.g. `lookup_type` on profile lookups, which the docs list as optional but the API enforces). Check the operation detail in the Explorer. |
| Upstreams "not reachable" in diagnostics | Outbound HTTPS to `connect.nulls.gg` / `profiles.dnull.xyz` is blocked on your host/network. |
| GitHub Pages shows 404 | Pages source must be set to **GitHub Actions** (Settings → Pages), and the workflow must have run successfully on `main`. |
| Demo page loads but features are inert | Expected — the static demo cannot proxy the CORS-less APIs. Deploy the backend for live functionality. |
| `gcc: command not found` | Install gcc + libcurl headers; only needed for the C CLI (`npm run build:c`), not the web app. |

## Security notes

- **Tokens stay server-side.** The bearer token is stored in an in-memory session keyed by an
  HttpOnly cookie and attached to upstream requests by the backend. The browser only ever sees
  a token if you click *Reveal* in the Session page.
- **Logs are masked.** The activity log redacts tokens, PINs, `id_token`s and authorization
  values before they are stored or returned.
- **Rate limiting.** Login and PIN attempts are rate-limited per IP; sensitive operations are
  rate-limited per session.
- **Admin endpoints are privileged.** The admin UI is only functional with an admin token;
  `admin_access_denied` is expected otherwise.
- **Game tokens are powerful.** A per-player game token (minted from `/games/token`) can perform
  most account-level operations and has no expiry — treat it like the account token. This is a
  property of the upstream API, not this application.
- **Sessions are in-memory and unencrypted in transit unless you add TLS.** Run behind HTTPS.

This project is an independent tool for interacting with the public Nulls Connect APIs; it is
not affiliated with or endorsed by the Nulls Connect / Nulls.gg service.

## Contributing

Contributions are welcome. Please:

1. Keep the project **zero-dependency** — new functionality must not add npm packages.
2. When you discover new API behavior, add it to the discovery registry (`KB` in `proxy.mjs`)
   with evidence (source location or live observation), not just a guess.
3. Run `npm run check` (syntax-check all JS) before committing, and verify the app works end to
   end for both authenticated and public surfaces.

## License

[MIT](LICENSE) © 2026 ilyln7
