# Security Notes — VPS Computer Live Viewer

Audit of the computer join, VNC viewer, and desktop tunnel paths in Nation Team
Chat as of this PR.  References are to source files in this repository.

---

## P0 — Critical

### P0-1: Web sessions received raw `127.0.0.1` URLs containing the VNC password

**Status: Fixed in this PR.**

`vpsComputerJoin` in `server/vps-computer.ts` returned
`http://127.0.0.1:<port>/vnc.html#autoconnect=true&…&password=<secret>` directly
to callers.  The companion desktop app re-wrapped the URL via
`CompanionViewerRelay.rewriteJoinResponse` before returning it to a paired
phone, but the server's own HTTP response from
`POST /api/bots/:id/computer/join` went to web sessions (thenation.city/swarm)
unchanged.

Effect: the browser saw a `127.0.0.1` URL it cannot reach and received the VNC
password in a URL fragment, where it persists in browser history, appears in the
address bar, and can be read by same-origin scripts.

**Fix:** `server/routes/vps-viewer.ts` introduces `ServerViewerRelay`.
For any session-authenticated join, the server now:
1. Validates the raw join URL via `safeLoopbackViewer` (127.0.0.1 + high port +
   `/vnc.html` only) or `safeDockerViewerUrl` (private RFC-1918 Docker bridge
   IP + port 6901 only — local-VPS case).
2. Stores an opaque 32-char base64url token bound to `(sessionId, botId)` with
   an 8-hour TTL.
3. Returns `/vps-viewer/<token>/vnc.html#…` — the password fragment is
   preserved for noVNC `autoconnect` but the loopback host and port are gone.
4. Proxies all GET and WebSocket requests through `handleHttp` /
   `handleUpgrade` after re-checking the session binding.

### P0-2: Local-VPS path sent Docker private IP to web clients

**Status: Fixed in this PR.**

When the API server and the Docker host share the same machine (`isLocalVpsTarget`
is true, `server/vps-computer.ts` line 1213–1215 before this patch), the join
URL contained the container's Docker bridge address
(`http://172.17.x.x:6901/vnc.html#…password=…`).  A browser cannot reach
bridge IPs, so the viewer was broken; and the IP revealed internal topology.

**Fix:** `safeDockerViewerUrl` accepts RFC-1918 Docker IPs with port 6901 and
`/vnc.html`, so `rewriteJoinUrl` now relays local-VPS sessions through the same
opaque proxy as remote-VPS sessions.

---

## P1 — High

### P1-1: No `cache-control: private, no-store` on join responses

**Status: Fixed in this PR.**

`POST /api/bots/:id/computer/join` and the team-computer join path returned
the `joinUrl` (containing the VNC password in the fragment) without a
`cache-control: private, no-store` header.  Any intermediate cache — including
a service worker, a shared reverse proxy misconfigured without `Vary: Cookie`,
or a CDN origin cache — could have stored the response.

**Fix:** `cache-control: private, no-store` is now set explicitly on all join
responses (VPS, Box, and team-computer paths) in `server/index.ts`.

### P1-2: Relay session not closed on auth session revocation

**Status: Fixed in this PR.**

The `sessions.onSessionRevoked` callback (`server/index.ts`) closed event
streams and cleared provider sessions but did not tear down any active VPS
viewer relay.  A revoked account's browser connection to the noVNC proxy would
remain open until the SSH tunnel's 8-hour TTL expired.

**Fix:** `serverViewer.closeSession(sessionId)` is now called from
`sessions.onSessionRevoked`.  The companion already did the equivalent via
`disconnectDevice` / `closeDevice`.

---

## P2 — Medium / Low

### P2-1: VNC password in URL fragment

**Status: Accepted risk — mitigated by this PR.**

noVNC `autoconnect` reads the password from `location.hash`.  Fragments are not
sent in HTTP request headers to remote servers, so the password does not leak
over the wire.  However:
- The password appears in the browser address bar and in `window.history`.
- Any same-origin JavaScript running on the noVNC page can read
  `window.location.hash`.
- A screenshot or screen recording of the browser can capture it.

After this PR the URL the user's browser sees is
`/vps-viewer/<token>/vnc.html#…password=<secret>`.  The token itself is opaque
and session-bound, so leaking it is less dangerous than the previous
`127.0.0.1:<port>` URL, but the password is still in the fragment.

Full remediation would require server-injected auth: the server could mint a
short-lived token and pass it to noVNC's `RFB` constructor directly, avoiding
the URL entirely.  This requires modifying the noVNC HTML or a thin JavaScript
shim; deferred as a follow-on.

### P2-2: VNC password cached in server-side in-memory maps

**Status: Accepted risk — no code change needed.**

`viewerConnections` (`server/vps-computer.ts`) and `desktopTunnels` both hold
`{ privateIp, password }` / `{ joinUrl }` values in memory.  The `joinUrl`
includes the password in its query fragment.  These are process-memory values —
never written to disk, never logged — and are cleared when the tunnel is stopped
or the process exits.  A heap dump of a running process would expose them, but
that requires root access to the API host, at which point an attacker already
controls the server.

No code-reachable path in `vps-computer.ts` logs or serialises these values.

### P2-3: SSRF via join/tunnel

**Status: No risk — validated.**

`rewriteJoinUrl` in `ServerViewerRelay` validates the upstream URL via
`safeLoopbackViewer` or `safeDockerViewerUrl` before storing it.  The URL
is always constructed internally by `vpsComputerJoin` (never from user input
after this PR), so there is no SSRF path.

SSH tunnel args are validated by `vpsSshTunnelArgs` (`server/vps-computer.ts`)
before being passed to `spawn`: the alias must pass `isValidSshAlias`, the
local port must be 1024–65535, and the private IP must pass `privateDockerIpv4`.

### P2-4: Open redirect via joinUrl

**Status: No risk — validated.**

The companion relay (`safeLoopbackViewer`) and the new server relay both check
that the URL is `http://`, `hostname === "127.0.0.1"` (or a private Docker IP),
`pathname === "/vnc.html"`, and no embedded credentials.  A URL that does not
match these constraints is returned unchanged (and for session callers, the
response will just be a broken link to an unreachable address — not a redirect).

### P2-5: Docker port-publish defaults

**Status: No risk — enforced.**

`hasNoPublishedPorts` (`server/vps-computer.ts`) is checked as part of
`computeVpsComputerStatus` and returns `network: "unsafe"` for any container
that publishes ports, is in a non-bridge network, or is attached to more than
one network.  The join endpoint refuses to proceed for such containers.

### P2-6: Authentication on join

**Status: Correct — no change needed.**

`POST /api/bots/:id/computer/join` is protected by `resolveRequestAuth` with
`admin` scope (not in `CLIENT_ALLOW`, so `requiredScope` returns `"admin"`).
The `content-type: application/json` requirement means browsers cannot submit
the request as a simple form POST (CSRF protection without a CSRF token).

---

## Can a leaked `127.0.0.1` URL from a random laptop take over a desk?

**No.** The SSH tunnel is bound to `127.0.0.1:<ephemeral>` on the API host only.
A URL like `http://127.0.0.1:54321/vnc.html#password=…` is only reachable from
a process running on the API host itself.  From a user's laptop or any other
machine the URL resolves to that machine's own loopback, where nothing is listening.

**What WOULD be needed to take over a desk:**
1. Code-execution access on the API host (to connect to the SSH-forwarded
   loopback port), AND
2. The VNC password for the specific container (available from `viewerConnections`
   in process memory, the `joinUrl` in `desktopTunnels`, or a leaked join
   response), AND
3. An active SSH tunnel (the API server starts one per join, with an 8-hour TTL).

An attacker with root on the API host already controls everything; the VNC
password is not the limiting factor.  The password does not protect against
local privilege escalation — it only prevents passive sniffing over a network
path that does not exist in the current deployment.

---

## Deploy instructions (after merge)

No schema migrations or environment-variable changes are required.

1. **Restart the API server** — the relay is in-process; a restart activates it.
2. **Verify** that a join from the web UI (thenation.city/swarm) returns a
   `joinUrl` starting with `/vps-viewer/` (not `http://127.0.0.1`).
3. **Optional smoke test:**
   ```
   curl -sS -X POST \
     -H "Content-Type: application/json" \
     -H "Cookie: omb_session_…=…" \
     https://thenation.city/swarm/api/bots/<botId>/computer/join \
     | jq .joinUrl
   ```
   Should return `/vps-viewer/<32-char-token>/vnc.html#…`.
4. The companion desktop app is **unaffected** — it uses its own relay and
   the server still returns the raw loopback URL to `kind: "loopback"` (non-session)
   callers so the companion relay can rewrite it as before.
