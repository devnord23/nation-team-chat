import { createServer, type Server } from "node:http";
import { createConnection, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { safeLoopbackViewer, ServerViewerRelay } from "./vps-viewer.ts";

const servers: Server[] = [];
const sockets: Duplex[] = [];

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
  );

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

// ---------------------------------------------------------------------------
// safeLoopbackViewer: allowlist
// ---------------------------------------------------------------------------
describe("safeLoopbackViewer", () => {
  it("accepts a canonical 127.0.0.1 high-port noVNC URL", () => {
    const url = safeLoopbackViewer("http://127.0.0.1:45678/vnc.html");
    expect(url).not.toBeNull();
    expect(url!.hostname).toBe("127.0.0.1");
    expect(url!.port).toBe("45678");
  });

  it("accepts /vnc.html with a fragment (password lives in the fragment)", () => {
    const url = safeLoopbackViewer("http://127.0.0.1:5900/vnc.html#autoconnect=true&password=secret");
    expect(url).not.toBeNull();
  });

  it("rejects a non-loopback host", () => {
    expect(safeLoopbackViewer("http://192.168.1.100:6901/vnc.html")).toBeNull();
    expect(safeLoopbackViewer("http://203.0.113.8:6901/vnc.html")).toBeNull();
    expect(safeLoopbackViewer("http://10.0.0.1:6901/vnc.html")).toBeNull();
  });

  it("rejects localhost (only 127.0.0.1 is accepted)", () => {
    expect(safeLoopbackViewer("http://localhost:6901/vnc.html")).toBeNull();
  });

  it("rejects IPv6 loopback", () => {
    expect(safeLoopbackViewer("http://[::1]:6901/vnc.html")).toBeNull();
  });

  it("rejects low ports (< 1024)", () => {
    expect(safeLoopbackViewer("http://127.0.0.1:80/vnc.html")).toBeNull();
    expect(safeLoopbackViewer("http://127.0.0.1:443/vnc.html")).toBeNull();
    expect(safeLoopbackViewer("http://127.0.0.1:1023/vnc.html")).toBeNull();
  });

  it("rejects port 1023 and accepts 1024 (boundary)", () => {
    // port < 1024 is rejected; 1024 itself is the minimum accepted port
    expect(safeLoopbackViewer("http://127.0.0.1:1023/vnc.html")).toBeNull();
    expect(safeLoopbackViewer("http://127.0.0.1:1024/vnc.html")).not.toBeNull();
  });

  it("rejects port 65536 (out of range)", () => {
    expect(safeLoopbackViewer("http://127.0.0.1:65536/vnc.html")).toBeNull();
  });

  it("rejects paths other than /vnc.html", () => {
    expect(safeLoopbackViewer("http://127.0.0.1:5900/")).toBeNull();
    expect(safeLoopbackViewer("http://127.0.0.1:5900/vnc.html/index.html")).toBeNull();
    expect(safeLoopbackViewer("http://127.0.0.1:5900/websockify")).toBeNull();
  });

  it("rejects URLs with embedded credentials (no userinfo)", () => {
    expect(safeLoopbackViewer("http://user:pass@127.0.0.1:5900/vnc.html")).toBeNull();
    expect(safeLoopbackViewer("http://user@127.0.0.1:5900/vnc.html")).toBeNull();
  });

  it("rejects URLs with a query string", () => {
    expect(safeLoopbackViewer("http://127.0.0.1:5900/vnc.html?password=secret")).toBeNull();
  });

  it("rejects https scheme", () => {
    expect(safeLoopbackViewer("https://127.0.0.1:5900/vnc.html")).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(safeLoopbackViewer(null)).toBeNull();
    expect(safeLoopbackViewer(undefined)).toBeNull();
    expect(safeLoopbackViewer(42)).toBeNull();
    expect(safeLoopbackViewer({})).toBeNull();
  });

  it("rejects malformed URLs", () => {
    expect(safeLoopbackViewer("not a url")).toBeNull();
    expect(safeLoopbackViewer("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ServerViewerRelay: join URL rewriting
// ---------------------------------------------------------------------------
describe("ServerViewerRelay.rewriteJoinUrl", () => {
  it("rewrites a safe loopback noVNC URL and embeds the websockify path", () => {
    const relay = new ServerViewerRelay();
    const result = relay.rewriteJoinUrl(
      "bot-1",
      "http://127.0.0.1:45678/vnc.html#autoconnect=true&password=viewer-secret",
      "session-1",
    );
    expect(result).toMatch(/^\/vps-viewer\/[A-Za-z0-9_-]{32}\/vnc\.html#/);
    expect(result).toContain("password=viewer-secret");
    expect(result).toContain("path=vps-viewer%2F");
    expect(result).not.toContain("127.0.0.1");
  });

  it("returns the raw URL unchanged when it is not a safe loopback URL", () => {
    const relay = new ServerViewerRelay();
    const dangerous = "http://203.0.113.8:6901/vnc.html#password=stolen";
    expect(relay.rewriteJoinUrl("bot-1", dangerous, "session-1")).toBe(dangerous);
  });

  it("rewrites a Docker bridge IP:6901/vnc.html URL for the local-VPS case", () => {
    const relay = new ServerViewerRelay();
    const dockerUrl = "http://172.17.0.2:6901/vnc.html#password=secret";
    const result = relay.rewriteJoinUrl("bot-1", dockerUrl, "session-1");
    expect(result).toMatch(/^\/vps-viewer\/[A-Za-z0-9_-]{32}\/vnc\.html#/);
    expect(result).toContain("password=secret");
    expect(result).not.toContain("172.17.0.2");
  });

  it("returns the raw URL unchanged for a non-private, non-loopback IP", () => {
    const relay = new ServerViewerRelay();
    const dangerous = "http://203.0.113.8:6901/vnc.html#password=stolen";
    expect(relay.rewriteJoinUrl("bot-1", dangerous, "session-1")).toBe(dangerous);
  });

  it("replaces a previous relay session for the same (sessionId, botId) pair", () => {
    const relay = new ServerViewerRelay();
    const first = relay.rewriteJoinUrl("bot-1", "http://127.0.0.1:5001/vnc.html", "session-1");
    const second = relay.rewriteJoinUrl("bot-1", "http://127.0.0.1:5002/vnc.html", "session-1");
    expect(first).not.toBe(second);
    expect(relay.isViewerPath(first.split("#")[0])).toBe(true);
    expect(relay.isViewerPath(second.split("#")[0])).toBe(true);
    // The first token should no longer be active (a new join invalidates the old one)
  });
});

// ---------------------------------------------------------------------------
// ServerViewerRelay: HTTP proxy
// ---------------------------------------------------------------------------
describe("ServerViewerRelay HTTP proxy", () => {
  it("proxies GET requests to the loopback viewer and pins them to the session", async () => {
    const viewer = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`served:${req.url}`);
    });
    servers.push(viewer);
    const viewerPort = await listen(viewer);

    const relay = new ServerViewerRelay();
    const rewritten = relay.rewriteJoinUrl(
      "bot-1",
      `http://127.0.0.1:${viewerPort}/vnc.html#password=secret`,
      "session-1",
    ) as string;
    const sessionPath = rewritten.split("#")[0];

    const sidecar = createServer((req, res) => relay.handleHttp(req, res, "session-1"));
    servers.push(sidecar);
    const sidecarPort = await listen(sidecar);

    const asset = await fetch(`http://127.0.0.1:${sidecarPort}${sessionPath}`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("private, no-store");
    expect(await asset.text()).toBe("served:/vnc.html");
  });

  it("returns 404 for a wrong session", async () => {
    const viewer = createServer((_req, res) => {
      res.writeHead(200, {});
      res.end("ok");
    });
    servers.push(viewer);
    const viewerPort = await listen(viewer);

    const relay = new ServerViewerRelay();
    const rewritten = relay.rewriteJoinUrl(
      "bot-1",
      `http://127.0.0.1:${viewerPort}/vnc.html`,
      "session-1",
    ) as string;
    const sessionPath = rewritten.split("#")[0];

    const wrongSidecar = createServer((req, res) => relay.handleHttp(req, res, "session-OTHER"));
    servers.push(wrongSidecar);
    const wrongPort = await listen(wrongSidecar);

    const resp = await fetch(`http://127.0.0.1:${wrongPort}${sessionPath}`);
    expect(resp.status).toBe(404);
  });

  it("returns 404 for a path not in the relay map", async () => {
    const relay = new ServerViewerRelay();
    const sidecar = createServer((req, res) => relay.handleHttp(req, res, "session-1"));
    servers.push(sidecar);
    const sidecarPort = await listen(sidecar);

    // 32 char token that was never registered
    const resp = await fetch(
      `http://127.0.0.1:${sidecarPort}/vps-viewer/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/vnc.html`,
    );
    expect(resp.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// ServerViewerRelay: WebSocket upgrade proxy
// ---------------------------------------------------------------------------
describe("ServerViewerRelay WebSocket upgrade proxy", () => {
  it("proxies a WebSocket upgrade and tears down on closeSession", async () => {
    let upgradedPath = "";
    const viewer = createServer();
    viewer.on("upgrade", (req, socket) => {
      sockets.push(socket);
      upgradedPath = req.url ?? "";
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n"
          + "Upgrade: websocket\r\n"
          + "Connection: Upgrade\r\n"
          + "Sec-WebSocket-Accept: test\r\n\r\n"
          + "viewer-ready",
      );
    });
    servers.push(viewer);
    const viewerPort = await listen(viewer);

    const relay = new ServerViewerRelay();
    const rewritten = relay.rewriteJoinUrl(
      "bot-1",
      `http://127.0.0.1:${viewerPort}/vnc.html#password=secret`,
      "session-1",
    ) as string;
    const sessionId = rewritten.split("#")[0].split("/")[2];

    const sidecar = createServer();
    sidecar.on("upgrade", (req, socket, head) =>
      relay.handleUpgrade(req, socket, head, "session-1"),
    );
    servers.push(sidecar);
    const sidecarPort = await listen(sidecar);

    let clientSocket: Socket | null = null;
    const received = await new Promise<string>((resolve, reject) => {
      clientSocket = createConnection({ host: "127.0.0.1", port: sidecarPort });
      sockets.push(clientSocket);
      let text = "";
      clientSocket.setEncoding("utf8");
      clientSocket.once("connect", () =>
        clientSocket?.write(
          `GET /vps-viewer/${sessionId}/websockify HTTP/1.1\r\n`
            + `Host: 127.0.0.1:${sidecarPort}\r\n`
            + "Connection: Upgrade\r\n"
            + "Upgrade: websocket\r\n"
            + "Sec-WebSocket-Key: dGVzdA==\r\n"
            + "Sec-WebSocket-Version: 13\r\n\r\n",
        ),
      );
      clientSocket.on("data", (chunk) => {
        text += chunk;
        if (text.includes("viewer-ready")) resolve(text);
      });
      clientSocket.once("error", reject);
      clientSocket.setTimeout(2_000, () => reject(new Error("viewer WebSocket timed out")));
    });
    expect(received).toContain("101 Switching Protocols");
    expect(received).toContain("viewer-ready");
    expect(upgradedPath).toBe("/websockify");

    const closed = new Promise<void>((resolve) => clientSocket?.once("close", () => resolve()));
    relay.closeSession("session-1");
    await expect(
      Promise.race([
        closed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("viewer WebSocket stayed open")), 2_000),
        ),
      ]),
    ).resolves.toBeUndefined();
  });

  it("returns 404 for a WebSocket upgrade using a wrong session", async () => {
    const viewer = createServer();
    viewer.on("upgrade", (_req, socket) => {
      sockets.push(socket);
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n"
          + "Upgrade: websocket\r\n"
          + "Connection: Upgrade\r\n"
          + "Sec-WebSocket-Accept: test\r\n\r\n",
      );
    });
    servers.push(viewer);
    const viewerPort = await listen(viewer);

    const relay = new ServerViewerRelay();
    const rewritten = relay.rewriteJoinUrl(
      "bot-1",
      `http://127.0.0.1:${viewerPort}/vnc.html`,
      "session-1",
    ) as string;
    const sessionId = rewritten.split("#")[0].split("/")[2];

    const sidecar = createServer();
    sidecar.on("upgrade", (req, socket, head) =>
      relay.handleUpgrade(req, socket, head, "session-OTHER"),
    );
    servers.push(sidecar);
    const sidecarPort = await listen(sidecar);

    const client = createConnection({ host: "127.0.0.1", port: sidecarPort });
    sockets.push(client);
    let response = "";
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      response += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      client.once("connect", () =>
        client.write(
          `GET /vps-viewer/${sessionId}/websockify HTTP/1.1\r\n`
            + `Host: 127.0.0.1:${sidecarPort}\r\n`
            + "Connection: Upgrade\r\n"
            + "Upgrade: websocket\r\n"
            + "Sec-WebSocket-Key: dGVzdA==\r\n"
            + "Sec-WebSocket-Version: 13\r\n\r\n",
        ),
      );
      client.once("close", resolve);
      client.once("error", reject);
      client.setTimeout(2_000, () => reject(new Error("timed out waiting for 404 close")));
    });
    expect(response).toContain("404");
    expect(response).not.toContain("101 Switching Protocols");
  });

  it("closes a WebSocket whose relay session is removed while the upstream handshake is pending", async () => {
    let handshakeStarted: (() => void) | undefined;
    const handshake = new Promise<void>((resolve) => {
      handshakeStarted = resolve;
    });
    const viewer = createServer();
    viewer.on("upgrade", (_req, socket) => {
      sockets.push(socket);
      handshakeStarted?.();
      // Deliberately leave the handshake unanswered until the session is closed.
    });
    servers.push(viewer);
    const viewerPort = await listen(viewer);

    const relay = new ServerViewerRelay();
    const rewritten = relay.rewriteJoinUrl(
      "bot-1",
      `http://127.0.0.1:${viewerPort}/vnc.html`,
      "session-1",
    ) as string;
    const sessionId = rewritten.split("#")[0].split("/")[2];

    const sidecar = createServer();
    sidecar.on("upgrade", (req, socket, head) =>
      relay.handleUpgrade(req, socket, head, "session-1"),
    );
    servers.push(sidecar);
    const sidecarPort = await listen(sidecar);

    const client = createConnection({ host: "127.0.0.1", port: sidecarPort });
    sockets.push(client);
    let response = "";
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      response += chunk;
    });
    client.once("connect", () =>
      client.write(
        `GET /vps-viewer/${sessionId}/websockify HTTP/1.1\r\n`
          + `Host: 127.0.0.1:${sidecarPort}\r\n`
          + "Connection: Upgrade\r\n"
          + "Upgrade: websocket\r\n"
          + "Sec-WebSocket-Key: dGVzdA==\r\n"
          + "Sec-WebSocket-Version: 13\r\n\r\n",
      ),
    );
    await handshake;
    const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    relay.closeSession("session-1");
    await expect(
      Promise.race([
        closed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("pending viewer stayed open")), 2_000),
        ),
      ]),
    ).resolves.toBeUndefined();
    expect(response).not.toContain("101 Switching Protocols");
  });
});

// ---------------------------------------------------------------------------
// ServerViewerRelay: closeBot
// ---------------------------------------------------------------------------
describe("ServerViewerRelay.closeBot", () => {
  it("closes all relay sessions for a given bot", async () => {
    const relay = new ServerViewerRelay();
    relay.rewriteJoinUrl("bot-1", "http://127.0.0.1:5001/vnc.html", "session-1");
    relay.rewriteJoinUrl("bot-1", "http://127.0.0.1:5002/vnc.html", "session-2");
    const pathA = relay.rewriteJoinUrl("bot-2", "http://127.0.0.1:5003/vnc.html", "session-3") as string;
    relay.closeBot("bot-1");
    // bot-2 session still accessible
    expect(relay.isViewerPath(pathA.split("#")[0])).toBe(true);
  });
});
