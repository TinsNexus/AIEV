---
name: auth-authz
description: How login (auth) and roles (authz) work in Tisorr Studio - the single policy table, the three identities (session / machine / upload token), session lifecycle, and the traps that were hit while building it. Read when touching apps/server/src/policy.ts, auth.ts, routes/auth.ts, routes/users.ts, when adding ANY new API route (you must declare its required role), or when a user reports being locked out / seeing 403.
---

# Auth & Authz

Login is password + server-side session in SQLite. Roles are `viewer` < `editor` < `admin`.
The API contract lives in `docs/API.md`; this skill is the *why* and the traps.

## Where things live

| File | Job |
|---|---|
| `apps/server/src/policy.ts` | The policy table: path + method → minimum role. **Deny by default.** |
| `apps/server/src/auth.ts` | scrypt hashing, session lifecycle, `identify()`, throttling, `requireAuth`/`requireRole` |
| `apps/server/src/routes/auth.ts` | login / logout / me / setup / change own password |
| `apps/server/src/routes/users.ts` | account management + audit log (admin) |
| `apps/server/src/index.ts` | the ONE gate: `identify()` → `requiredAccess()` → 401/403 |
| `apps/web/src/lib/useAuth.tsx` | `useAuth()` — the web's single source of truth on session state |

## Adding a new API route — do this or it will 403

The policy table denies anything it does not recognise. After mounting a router, add a rule to
`RULES` in `policy.ts`. Rules are evaluated **in order, first match wins**, so a narrow rule must
sit above a broad one. The two catch-alls at the bottom (`GET` → viewer, everything else →
editor) are only safe because every admin branch is listed above them.

A route that runs commands, touches secrets, or opens the machine to the internet is `admin` —
that is `/api/chat`, `/api/users`, `/api/connections`, `/api/update`, `/api/tunnel`,
`/api/doctor`, `/api/reveal`, and writes to `/api/skills`.

## The three identities

`identify()` in `auth.ts` returns `session`, `machine`, `upload`, or null.

- **`machine`** = loopback direct, or `XTS_API_TOKEN`. Counts as **admin**. It exists because the
  Claude agent, `start/` scripts and `deploy/deploy.sh` call the API with no account to log in
  with. `XTS_DISABLE_MACHINE_TOKEN=1` turns off the shared-token half of it.
- **`upload`** = the `?k=` QR session token for the phone page `/m`. It carries **no role** and is
  checked against `allowedForUploadToken()` instead of the policy table.

**`identify()` must stay ONE function** shared by the gate and `GET /api/auth/me`. Two
implementations answering differently about the same request is exactly how you get "the web
bounces me to the login screen while my API calls still work".

## Lessons (symptom → cause → fix)

**Symptom:** `next build` fails with `Error occurred prerendering page "/login"`.
**Cause:** `useSearchParams()` (reading `?next=`) forces client rendering, but the build still
prerenders the page. Missing a Suspense boundary is a build **failure**, not a warning.
**Fix:** keep the query-reading code in a child component and wrap it: the default export is just
`<Suspense fallback={null}><LoginForm /></Suspense>`. See `apps/web/src/app/login/page.tsx`.

**Symptom:** nginx returns 500 on every request after enabling HTTP Basic Auth; error log says
`open() "/www/server/pass/<domain>.pass" failed (13: Permission denied)`.
**Cause:** the password file was written `chmod 600` root-only; nginx workers run as `www`.
**Fix:** `chown root:www` + `chmod 640`. (aaPanel's own UI writes it with working permissions —
this only bites when the file is created by hand.)

**Symptom:** a role change / account disable appears to do nothing.
**Cause:** the target's existing session was still valid.
**Fix:** already handled — `setUserRole`, `setUserStatus(disabled)`, password change and admin
password reset all call `deleteSessionsForUser()`. Keep that invariant when adding new mutations:
**anything that changes what a user is allowed to do must kill their sessions.**

**Symptom:** login is slow (~0.3s) and a burst of login requests stalls the whole server.
**Cause:** scrypt is deliberately CPU-heavy; that is the point of a password hash.
**Fix:** already in place — 20 req/min/IP on `/api/auth/login` plus a cap of 4 concurrent hashes
(`gateHashing`). Do not remove either as an "optimisation". The concurrency gate listens to both
`finish` **and** `close` on the response: listening only to `finish` leaks a slot every time a
user closes the tab mid-login, and after a few of those the server sits at 503 forever.

**Symptom:** rate limiting locks out everyone at once, or never locks anyone.
**Cause:** behind nginx every socket is `127.0.0.1`, so IP-keyed limits collapse into one bucket.
**Fix:** set `TRUST_PROXY_HOPS=1` in `.env` when behind exactly one reverse proxy. `clientIp()`
then takes the Nth entry **from the right** of `X-Forwarded-For` — the part the proxy itself
wrote. Never trust the header unconditionally: the left-hand entries are attacker-controlled.

## Things deliberately NOT done — do not "fix" these

- **No bcrypt/argon2.** Both are native modules that must compile at install time. Users install
  this project from GitHub, mostly on Windows without build tools. `crypto.scrypt` ships with
  Node 22. Adding a native dep here buys a class of install failures.
- **Password policy is length-only (≥10 chars).** Character-class rules push people toward
  `Matkhau@1` and sticky notes. Length is what actually makes guessing expensive.
- **`SameSite=Lax`, not `Strict`.** Strict shows the login screen when the dashboard is opened
  from a link in email/chat even with a live session, which reads as "lost my session".
- **`isLocalRequest()` in `util.ts` rejects any request carrying `x-forwarded-*`.** That is the
  DNS-rebinding defence, and the loopback path grants admin. Do not relax it to "make the proxy
  work" — the proxy path is supposed to require a session.

## The honest limit of the editor role

`runAgent` (Claude Code headless, with Bash) is reachable from six places, not just Chat:
`routes/chat.ts`, `routes/projects.ts`, `routes/review.ts`, `routes/clips.ts`,
`jobs/autoCut.ts`, `jobs/textToVideo.ts`. Restricting `/api/chat` to admin keeps the *free-form
command* path closed, but an editor creating a project or using text-to-video still starts an
agent with Bash, and the brief they write becomes part of the prompt (prompt injection).

**So: treat `editor` as a trusted role, not a sandbox.** If a hard boundary is ever needed, the
real fix is running editor-triggered agents under a restricted tool allowlist (a separate
`.claude/settings.json` per role) — not more route-level rules.
