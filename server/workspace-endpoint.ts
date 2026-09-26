// The workspace server's side of server/workspace-host.ts. Its host, the
// public NATION server, calls two routes over loopback before anyone has a
// session here, so they are answered ahead of the sign-in gate, and only for
// an unproxied loopback request that presents the key this server was started
// with:
//   POST /api/workspace-host/session  {email, userId}  a `client` session for
//        this workspace's own account; it replaces every earlier session
//   GET  /api/workspace-host/activity  {busy, keepAlive}, so the host never
//        stops a workspace mid-turn or while a routine is enabled
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeEmail } from "./accounts.ts";
import { json, readBody } from "./harness/http.ts";
import { isProxied } from "./request-auth.ts";
import { WORKSPACE_ACTIVITY_PATH, WORKSPACE_KEY_HEADER, WORKSPACE_SESSION_PATH } from "./workspace-host.ts";

export interface WorkspaceEndpointDeps {
  /** The key this server was started with (NATION_WORKSPACE_KEY). */
  key: string | undefined;
  /** Whether `email` is the account this workspace was made for. */
  ownAccount: (email: string) => boolean;
  /** Revokes every session, issues one `client` session and returns its bearer. */
  replaceSession: (account: { userId: string; email: string }) => string;
  activity: () => { busy: boolean; keepAlive: boolean };
}

/** Answers the host's two routes; false for any other path. */
export function createWorkspaceEndpoint(deps: WorkspaceEndpointDeps) {
  const expected = Buffer.from(deps.key ?? "");
  return async (req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<boolean> => {
    if (path !== WORKSPACE_SESSION_PATH && path !== WORKSPACE_ACTIVITY_PATH) return false;
    res.setHeader("cache-control", "no-store");
    const presented = Buffer.from(String(req.headers[WORKSPACE_KEY_HEADER] ?? ""));
    const peer = req.socket.remoteAddress;
    const local = !isProxied(req) && (peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1");
    if (!local || expected.length < 32 || presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      json(res, 403, { error: "forbidden" });
    } else if (path === WORKSPACE_SESSION_PATH && method === "POST") {
      const body = await readBody(req, 4_096);
      const email = normalizeEmail(body?.email);
      const userId = typeof body?.userId === "string" ? body.userId.trim().slice(0, 256) : "";
      if (!email || !userId) json(res, 400, { error: "email and userId are required" });
      else if (!deps.ownAccount(email)) json(res, 403, { error: "this workspace belongs to another account" });
      else json(res, 200, { token: deps.replaceSession({ userId, email }) });
    } else if (path === WORKSPACE_ACTIVITY_PATH && method === "GET") {
      json(res, 200, deps.activity());
    } else {
      json(res, 404, { error: "not found" });
    }
    return true;
  };
}
