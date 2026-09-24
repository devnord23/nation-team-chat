// HTTP plumbing shared by server/index.ts and the route modules under
// server/routes/. Pure helpers only: nothing here reads harness state, so a
// route module can import them directly.
import type { IncomingMessage, ServerResponse } from "node:http";

import { publicResponse } from "../public-response.ts";
const ownerResponses = new WeakSet<ServerResponse>();
export function setResponseOwner(res: ServerResponse, owner: boolean): void {
  if (owner) ownerResponses.add(res);
  else ownerResponses.delete(res);
}

/** Per-response audience projection (hosted private conversations): runs
 * before the public projection and may withhold what the caller may not see. */
const responseProjectors = new WeakMap<ServerResponse, (body: unknown) => unknown>();
export function setResponseProjector(res: ServerResponse, project: (body: unknown) => unknown): void {
  responseProjectors.set(res, project);
}
/** Per-request check of a parsed JSON body before any route acts on it. It
 * may rewrite fields or throw an error carrying an HTTP status. */
const bodyGuards = new WeakMap<IncomingMessage, (body: any) => void>();
export function setBodyGuard(req: IncomingMessage, guard: (body: any) => void): void {
  bodyGuards.set(req, guard);
}

export function json(res: ServerResponse, status: number, body: unknown) {
  const project = responseProjectors.get(res);
  let projected = project ? project(body) : body;
  if (projected === null) { status = 404; projected = { error: "no such conversation" }; }
  const filtered = publicResponse(projected, ownerResponses.has(res));
  const data = JSON.stringify(filtered);
  const publicError = status >= 400 && filtered !== null && typeof filtered === "object"
    && typeof (filtered as Record<string, unknown>).error === "string";
  res.writeHead(status, { "content-type": "application/json",
    ...(publicError ? {
      "x-nation-error-schema": "public-v1",
      "access-control-expose-headers": "x-nation-error-schema",
    } : {}),
  });
  res.end(data);
}

export function readBody(req: IncomingMessage, limit = 1_000_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    let done = false;
    const fail = (status: number, msg: string) => {
      if (done) return;
      done = true;
      const err = Object.assign(new Error(msg), { status });
      reject(err);
    };
    req.on("data", (c) => {
      if (done) return;
      bytes += typeof c === "string" ? Buffer.byteLength(c) : c.length;
      if (bytes > limit) {
        // Keep draining the socket, but stop retaining attacker-controlled
        // bytes. Destroying the request here prevents the caller from
        // receiving the useful 413 response.
        return fail(413, "body too large");
      }
      data += c;
    });
    req.on("end", () => {
      if (done) return;
      let body: any;
      try {
        body = data ? JSON.parse(data) : {};
      } catch {
        return fail(400, "invalid JSON body");
      }
      done = true;
      const guard = bodyGuards.get(req);
      if (guard) {
        try { guard(body); } catch (error) { return reject(error); }
      }
      resolve(body);
    });
    req.on("error", (e) => fail(400, e instanceof Error ? e.message : String(e)));
  });
}
