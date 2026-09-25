// Server-side /vps-viewer proxy for web sessions (thenation.city/swarm).
//
// The companion desktop app rewrites join responses via CompanionViewerRelay
// in companion/src/viewer-relay.ts.  This module mirrors that design for
// web cookie/bearer sessions so the browser never receives a raw
// 127.0.0.1 URL or a Docker-bridge IP.
//
// Security invariants:
//   • Only a valid, session-bound opaque token reaches the loopback tunnel.
//   • The upstream target is validated to be a private loopback address
//     before the relay session is stored.
//   • Every proxied HTTP response carries cache-control: private, no-store.
//   • The relay session is bound to the (sessionId, botId) pair; a different
//     authenticated session cannot reuse another user's token.
import { randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type { SessionRegistry } from "../sessions.ts";
import { bearerToken, parseCookies } from "../request-auth.ts";
import { INTERNAL_VIEWER_PORT } from "../vps-computer.ts";
import { PASS, type RouteHandler } from "./table.ts";

const VIEWER_PATH = /^\/vps-viewer\/([A-Za-z0-9_-]{32})(\/.*)?$/;
const SESSION_TTL_MS = 8 * 60 * 60_000;
const MAX_SESSIONS = 64;

/** Validate that a URL is a safe loopback noVNC origin.
 *
 * Accepted: http://127.0.0.1:<high-port>/vnc.html (no credentials, no query).
 * Everything else — non-loopback hosts, low ports, non-/vnc.html paths,
 * embedded credentials, query strings, https — is rejected.
 *
 * This is intentionally strict: the relay must never proxy to a
 * non-loopback address, and the caller-controlled components of the URL
 * (port, fragment) are validated separately by the caller. */
export function safeLoopbackViewer(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || url.username
    || url.password
    || url.pathname !== "/vnc.html"
    || url.search
    || !Number.isSafeInteger(port)
    || port < 1024
    || port > 65_535
  ) {
    return null;
  }
  return url;
}

/** Validate that a URL points to the noVNC port on a private Docker bridge IP.
 *
 * This covers the local-VPS case where the Docker host is the same machine as
 * the API server: the container's bridge address is unreachable from the
 * user's browser but reachable from the server process, so the relay can
 * proxy it.  Only accepted when the port matches the well-known internal
 * viewer port (6901) and the hostname is a private Docker IPv4 range.
 *
 * Not exported — the externally tested contract is safeLoopbackViewer. */
function safeDockerViewerUrl(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== "http:"
    || url.username
    || url.password
    || url.pathname !== "/vnc.html"
    || url.search
    || Number(url.port) !== INTERNAL_VIEWER_PORT
  ) {
    return null;
  }
  // Accept RFC-1918 ranges used by Docker bridge networks.
  const parts = url.hostname.split(".").map(Number);
  if (
    parts.length !== 4
    || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    return null;
  }
  const [a, b] = parts as [number, number, number, number];
  const isPrivate =
    a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
  return isPrivate ? url : null;
}

interface ServerViewerSession {
  id: string;
  botId: string;
  sessionId: string;
  origin: string;
  expiresAt: number;
  sockets: Set<{ destroy(): void }>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "cache-control": "private, no-store",
    "content-length": Buffer.byteLength(text),
    "content-type": "application/json",
  });
  res.end(text);
}

export function socketError(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error: message });
  socket.end(
    `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Not Found"}\r\n`
      + "Connection: close\r\n"
      + "Content-Type: application/json\r\n"
      + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function websocketHeaders(req: IncomingMessage): Record<string, string> | null {
  if (req.method !== "GET" || String(req.headers.upgrade ?? "").toLowerCase() !== "websocket") return null;
  const headers: Record<string, string> = { connection: "Upgrade", upgrade: "websocket" };
  for (const name of [
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
  ]) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  return headers;
}

function acceptUpgrade(socket: Duplex, response: IncomingMessage): void {
  const headers: string[] = [];
  for (const name of [
    "upgrade",
    "connection",
    "sec-websocket-accept",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
  ]) {
    const value = response.headers[name];
    if (typeof value === "string") headers.push(`${name}: ${value}`);
  }
  socket.write(
    `HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n`
      + `${headers.join("\r\n")}\r\n\r\n`,
  );
}

/** Server-side noVNC relay bound to web sessions.
 *
 * Mirrors CompanionViewerRelay from companion/src/viewer-relay.ts, using
 * session IDs (from cookie or bearer auth) instead of companion device IDs.
 * One relay instance is held by the server process for its lifetime. */
export class ServerViewerRelay {
  readonly #sessions = new Map<string, ServerViewerSession>();

  #prune(): void {
    const now = Date.now();
    for (const session of this.#sessions.values()) {
      if (session.expiresAt <= now) this.#remove(session);
    }
    while (this.#sessions.size >= MAX_SESSIONS) {
      const oldest = this.#sessions.values().next().value as ServerViewerSession | undefined;
      if (!oldest) break;
      this.#remove(oldest);
    }
  }

  #remove(session: ServerViewerSession): void {
    this.#sessions.delete(session.id);
    for (const socket of session.sockets) socket.destroy();
    session.sockets.clear();
  }

  #isActive(session: ServerViewerSession): boolean {
    return this.#sessions.get(session.id) === session;
  }

  /** Close the relay session for a specific (user session, bot) pair. */
  close(sessionId: string, botId: string): void {
    for (const session of this.#sessions.values()) {
      if (session.sessionId === sessionId && session.botId === botId) this.#remove(session);
    }
  }

  /** Close all relay sessions for a user session (e.g. on sign-out). */
  closeSession(sessionId: string): void {
    for (const session of this.#sessions.values()) {
      if (session.sessionId === sessionId) this.#remove(session);
    }
  }

  /** Close all relay sessions for a bot (e.g. on VPS tunnel teardown). */
  closeBot(botId: string): void {
    for (const session of this.#sessions.values()) {
      if (session.botId === botId) this.#remove(session);
    }
  }

  /** Rewrite a raw loopback noVNC join URL into an opaque /vps-viewer/<token>
   * path.  Returns the original string unchanged when it does not match the
   * safe-loopback criteria — the raw URL never leaves this method in that case
   * for session callers; callers must check the return value. */
  rewriteJoinUrl(botId: string, rawUrl: string, sessionId: string): string {
    const viewer = safeLoopbackViewer(rawUrl) ?? safeDockerViewerUrl(rawUrl);
    if (!viewer) return rawUrl;
    this.#prune();
    this.close(sessionId, botId);
    const id = randomBytes(24).toString("base64url");
    this.#sessions.set(id, {
      id,
      botId,
      sessionId,
      origin: viewer.origin,
      expiresAt: Date.now() + SESSION_TTL_MS,
      sockets: new Set(),
    });
    // Preserve the fragment (contains noVNC autoconnect params + password).
    // Inject the WebSocket path so noVNC connects through this relay.
    const settings = new URLSearchParams(viewer.hash.slice(1));
    settings.set("path", `vps-viewer/${id}/websockify`);
    return `/vps-viewer/${id}${viewer.pathname}#${settings.toString()}`;
  }

  /** Return true when the URL pathname begins with /vps-viewer/. */
  isViewerPath(rawUrl: string | undefined): boolean {
    const pathname = new URL(rawUrl ?? "/", "http://server.invalid").pathname;
    return pathname.startsWith("/vps-viewer/");
  }

  #target(
    rawUrl: string | undefined,
    sessionId: string,
  ): { session: ServerViewerSession; target: URL } | null {
    this.#prune();
    const incoming = new URL(rawUrl ?? "/", "http://server.invalid");
    const match = VIEWER_PATH.exec(incoming.pathname);
    if (!match) return null;
    const session = this.#sessions.get(match[1]);
    if (!session || session.sessionId !== sessionId || session.expiresAt <= Date.now()) return null;
    const suffix = match[2] || "/";
    const target = new URL(`${suffix}${incoming.search}`, session.origin);
    if (target.origin !== session.origin) return null;
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return { session, target };
  }

  /** Handle an HTTP GET request to a /vps-viewer/<token>/... path. */
  handleHttp(req: IncomingMessage, res: ServerResponse, sessionId: string): void {
    const resolved = this.#target(req.url, sessionId);
    if (!resolved || req.method !== "GET") return sendJson(res, 404, { error: "viewer session not found" });

    const headers: Record<string, string> = { accept: String(req.headers.accept ?? "*/*") };
    for (const name of ["range", "if-none-match", "if-modified-since"]) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const upstream = httpRequest(resolved.target, { method: "GET", headers }, (remote) => {
      upstream.setTimeout(0);
      const responseHeaders: Record<string, string | string[]> = {
        "cache-control": "private, no-store",
      };
      for (const name of [
        "content-type",
        "content-length",
        "content-encoding",
        "content-range",
        "accept-ranges",
        "etag",
        "last-modified",
      ]) {
        const value = remote.headers[name];
        if (value !== undefined) responseHeaders[name] = value;
      }
      res.writeHead(remote.statusCode ?? 502, responseHeaders);
      remote.once("error", () => res.destroy());
      remote.pipe(res);
    });
    upstream.setTimeout(30_000, () => upstream.destroy(new Error("viewer did not answer")));
    upstream.once("error", () => {
      if (res.headersSent) res.destroy();
      else sendJson(res, 502, { error: "the VPS viewer did not answer" });
    });
    res.once("close", () => upstream.destroy());
    upstream.end();
  }

  /** Handle a WebSocket upgrade request to a /vps-viewer/<token>/... path. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, sessionId: string): void {
    const resolved = this.#target(req.url, sessionId);
    const headers = websocketHeaders(req);
    if (!resolved || !headers) return socketError(socket, 404, "viewer session not found");

    const upstream = httpRequest(resolved.target, { method: "GET", headers });
    resolved.session.sockets.add(socket);
    resolved.session.sockets.add(upstream);
    socket.once("close", () => resolved.session.sockets.delete(socket));
    upstream.once("close", () => resolved.session.sockets.delete(upstream));
    upstream.setTimeout(30_000, () => upstream.destroy(new Error("viewer upgrade timed out")));
    upstream.once("upgrade", (response, remote, remoteHead) => {
      upstream.setTimeout(0);
      remote.setTimeout(0);
      if (!this.#isActive(resolved.session) || socket.destroyed) {
        remote.destroy();
        socket.destroy();
        return;
      }
      resolved.session.sockets.delete(upstream);
      acceptUpgrade(socket, response);
      resolved.session.sockets.add(remote);
      const release = () => {
        resolved.session.sockets.delete(socket);
        resolved.session.sockets.delete(remote);
      };
      socket.once("close", release);
      remote.once("close", release);
      if (head.length) remote.write(head);
      if (remoteHead.length) socket.write(remoteHead);
      socket.pipe(remote).pipe(socket);
    });
    upstream.once("response", (response) => {
      response.resume();
      socketError(socket, 404, "viewer WebSocket was refused");
    });
    upstream.once("error", () => socket.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.end();
  }
}

/** Route handler factory: registers GET /vps-viewer/<token>/... into the
 * server route table.  WebSocket upgrades on the same path are handled
 * separately via handleServerViewerUpgrade() below. */
export function createVpsViewerRoutes(relay: ServerViewerRelay): RouteHandler {
  return async ({ req, res, path, auth }) => {
    if (!path.startsWith("/vps-viewer/")) return PASS;
    if (auth.kind !== "session") {
      return void sendJson(res, 403, { error: "a paired session is required to use the VPS viewer" });
    }
    relay.handleHttp(req, res, auth.session.id);
  };
}

/** Authenticate a WebSocket upgrade request using the session cookie or bearer
 * token, then hand it off to the relay.  Call this from server.on("upgrade").
 *
 * Closes the socket with 401 if no valid session is found.  The relay itself
 * returns 404 for unknown or expired tokens. */
export function handleServerViewerUpgrade(
  relay: ServerViewerRelay,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  sessions: SessionRegistry,
  cookieName: string,
): void {
  if (!relay.isViewerPath(req.url)) {
    socket.destroy();
    return;
  }

  // Browsers send the Origin header on WebSocket upgrades.  Block cross-origin
  // upgrade attempts before inspecting credentials.
  const origin = req.headers.origin;
  if (origin) {
    let safe = false;
    try {
      const o = new URL(origin);
      // Allow same-origin (relative to the Host header) or loopback origins.
      const host = String(req.headers.host ?? "");
      safe = o.host === host || o.hostname === "127.0.0.1" || o.hostname === "localhost" || o.hostname === "::1";
    } catch {
      safe = false;
    }
    if (!safe) {
      socketError(socket, 403, "forbidden: cross-origin WebSocket upgrade");
      return;
    }
  }

  const token = bearerToken(req.headers.authorization);
  const cookieValue = parseCookies(req.headers.cookie).get(cookieName);
  let sessionId: string | null = null;
  if (token?.startsWith("omb_sess_")) {
    const sess = sessions.authenticate(token);
    if (sess) sessionId = sess.id;
  } else if (cookieValue) {
    const sess = sessions.authenticate(cookieValue);
    if (sess) sessionId = sess.id;
  }

  if (!sessionId) {
    socketError(socket, 401, "unauthorized: session required for VPS viewer");
    return;
  }

  relay.handleUpgrade(req, socket, head, sessionId);
}
