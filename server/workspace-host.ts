// Per-account workspaces on the public NATION server.
//
// Isolation is a separate data directory per account, served by its own
// server process: bots, conversations, memory, routines, connected apps and
// uploads live under <data dir>/workspaces/<workspace id>/ and nowhere else.
// Only this process (the founder's server) listens on the public address. It
// signs people in (server/account-gateway.ts), starts their workspace server
// on a loopback port the first time they need it, and forwards their
// requests there.
//
// What a workspace server gets, and what it does not:
//   - One `client` session for its one account, minted over loopback with a
//     key made for that start. Requests are forwarded with that bearer and
//     never as the loopback owner: owner means admin, and admin could add
//     engines, keys, MCP servers or computers.
//   - The NATION API engine only (see workspaceConfig): no desks, no browser,
//     no computers, no command-line engines on this machine.
//   - A fixed list of environment values: the model, search and credit
//     settings this server already runs with. Never this server's data
//     directory, sign-in lists, mail credentials or desk credentials.
//   - The credit ledger file this server uses, so payment amounts stay unique
//     across accounts and the one payment scanner here credits every account.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { Agent, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { isWorkspaceId, type WorkspaceRef } from "./accounts.ts";

export const WORKSPACE_KEY_HEADER = "x-nation-workspace-key";
export const WORKSPACE_SESSION_PATH = "/api/workspace-host/session";
export const WORKSPACE_ACTIVITY_PATH = "/api/workspace-host/activity";

export const WORKSPACE_UNAVAILABLE = "Your workspace could not start. Try again in a minute.";
export const WORKSPACE_BUSY = "Nation Team Chat is busy right now. Try again in a minute.";
export const WORKSPACE_NO_ANSWER = "Your workspace did not answer. Try again in a moment.";

/** Settings the founder chooses for everyone (admin Settings), copied into each workspace at start. */
export interface SharedWorkspaceSettings {
  modelRouting?: unknown;
  webSearch?: unknown;
}

/** Values a workspace server may inherit from this one. Anything not listed stays here. */
export const INHERITED_ENVIRONMENT = [
  // the system
  "PATH", "LANG", "LC_ALL", "TZ", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
  // NATION API: server-held model keys and routing; members never see them
  "OPENROUTER_API_KEY", "OPENROUTER_API_URL", "OPENROUTER_MODEL", "NATION_OPENROUTER_MODEL", "NATION_DEFAULT_MODEL",
  "NATION_MODEL_FAST", "NATION_MODEL_STANDARD", "NATION_MODEL_STRONG", "NATION_IMAGE_MODEL",
  // web search and reading for agents
  "NATION_SEARCH_PROVIDER", "NATION_SEARCH_API_KEY", "NATION_SEARCH_API_URL", "NATION_SEARCH_MODEL",
  "NATION_SEARCH_PRICE_USD", "NATION_READER_PRICE_USD",
  // connected apps
  "COMPOSIO_API_KEY", "OMB_COMPOSIO_API", "OMB_COMPOSIO_TOOLKITS_API", "OMB_COMPOSIO_BROKER_URL", "OMB_COMPOSIO_BROKER_TOKEN",
  // credit prices and payment rules (the scan itself runs only here)
  "NATION_TREASURY_ROBINHOOD", "NATION_RPC_ROBINHOOD", "NATION_TOKEN_USD_PRICE", "NATION_TOKEN_DISCOUNT",
  "NATION_FREE_CREDIT_USD", "NATION_CREDIT_MARKUP", "NATION_LOW_BALANCE_USD", "NATION_PACKS_USD",
  "NATION_FREE_GRANTS_PER_IP_PER_DAY", "NATION_CONFIRMATIONS", "NATION_DISPOSABLE_EMAIL_DOMAINS",
  "NATION_PUBLIC_NAME",
] as const;

export function workspaceServerEnvironment(parent: NodeJS.ProcessEnv, input: {
  root: string;
  port: number;
  workspaceId: string;
  key: string;
  creditsDb: string;
  brandFile?: string | null;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENVIRONMENT) if (parent[name]) env[name] = parent[name];
  const temp = join(input.root, "tmp");
  Object.assign(env, {
    HOME: input.root,
    USERPROFILE: input.root,
    XDG_CONFIG_HOME: join(input.root, ".config"),
    XDG_CACHE_HOME: join(input.root, ".cache"),
    XDG_DATA_HOME: join(input.root, ".local", "share"),
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    NATION_DATA_DIR: input.root,
    OMB_DATA_DIR: input.root,
    OMB_PORT: String(input.port),
    OMB_WEBHOOK_PORT: String(input.port + 1),
    // A member is never the product owner, whatever this server is.
    NATION_PRODUCT_OWNER: "0",
    NATION_PRODUCT_ADMIN: "0",
    NATION_CREDITS_DB: input.creditsDb,
    NATION_CREDIT_WATCHER: "0",
    // X-Real-IP is written by this server for every forwarded request.
    NATION_TRUST_PROXY: "1",
    NATION_WORKSPACE_ID: input.workspaceId,
    NATION_WORKSPACE_KEY: input.key,
  });
  if (input.brandFile) env.NATION_BRAND_FILE = input.brandFile;
  return env;
}

/** The parts of a workspace's config.json this server owns. Everything else
 * (bots' look, rooms, onboarding) is the workspace's own. */
export function workspaceConfig(existing: Record<string, unknown>, email: string, shared: SharedWorkspaceSettings = {}): Record<string, unknown> {
  const features = existing.features && typeof existing.features === "object" && !Array.isArray(existing.features) ? existing.features as Record<string, unknown> : {};
  const next: Record<string, unknown> = {
    ...existing,
    // The one account that may hold a session here.
    signIn: { admins: [], members: [email] },
    // NATION API only: no command-line engines, computers or desks. The
    // server picks its own default model on it; routing picks per turn.
    instances: { nationApi: { driver: "nation-openrouter", displayName: "NATION API" } },
    features: { ...features, browser: false, computers: false, sharedComputers: false },
  };
  const selection = next.defaultModelSelection as { instanceId?: unknown } | undefined;
  if (selection && selection.instanceId !== "nationApi") delete next.defaultModelSelection;
  for (const key of ["box", "vps", "localVm", "anthropic", "xai", "openaiCompat", "opencodeGo", "composio", "customDomain", "cliStartup"]) delete next[key];
  if (shared.modelRouting !== undefined) next.modelRouting = shared.modelRouting;
  else delete next.modelRouting;
  if (shared.webSearch !== undefined) next.webSearch = shared.webSearch;
  else delete next.webSearch;
  return next;
}

function readJson(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/** Two consecutive free loopback ports: the app port and its webhook port. */
async function freePortPair(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await freePort();
    if (port < 65_535 && await portFree(port + 1)) return port;
  }
  throw new Error("no free loopback port pair");
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

/** What a forwarded request carries: the browser's own headers minus every
 * credential and proxy claim, plus this workspace's bearer and the caller's
 * address. The one cookie that crosses is the starter-credit device id. */
export function forwardedRequestHeaders(headers: IncomingHttpHeaders, input: { token: string; port: number; clientIp: string }): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(key)) continue;
    if (["cookie", "authorization", "host", "origin", "referer", "forwarded", "x-real-ip"].includes(key)) continue;
    if (key.startsWith("x-forwarded-") || key.startsWith("x-openmausbot-") || key.startsWith("x-nation-")) continue;
    out[key] = value;
  }
  const device = /(?:^|;\s*)nation_device=([0-9a-f-]{36})(?:;|$)/i.exec(String(headers.cookie ?? ""))?.[1];
  if (device) out.cookie = `nation_device=${device}`;
  out.authorization = `Bearer ${input.token}`;
  out.host = `127.0.0.1:${input.port}`;
  out["x-real-ip"] = input.clientIp;
  return out;
}

/** What goes back to the browser: everything but hop-by-hop headers, and no
 * cookie except the starter-credit device id. */
export function returnedResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(key)) continue;
    if (key === "set-cookie") {
      const kept = (Array.isArray(value) ? value : [value]).filter((cookie) => /^nation_device=/i.test(cookie));
      if (kept.length) out[key] = kept;
      continue;
    }
    out[key] = value;
  }
  return out;
}

interface Running {
  ref: WorkspaceRef;
  child: ChildProcess;
  port: number;
  key: string;
  token: string;
  startedAt: number;
  lastUsedAt: number;
  /** Forwarded requests still open, event streams included. */
  inflight: number;
  exited: Promise<void>;
  stopping: boolean;
}

export interface WorkspaceHostOptions {
  /** This server's data directory; workspaces live under its workspaces/ folder. */
  dataDir: string;
  /** The shared credit ledger file. */
  creditsDb: string;
  env?: NodeJS.ProcessEnv;
  /** How to start a workspace server; defaults to this process's own entry point. */
  command?: { file: string; args: string[]; cwd?: string };
  brandFile?: () => string | null;
  sharedSettings?: () => SharedWorkspaceSettings;
  maxRunning?: number;
  idleMs?: number;
  startTimeoutMs?: number;
  log?: (line: string) => void;
}

/** This process's own entry point, without debugger flags a second process could not reuse. */
export function ownServerCommand(): { file: string; args: string[]; cwd?: string } {
  const execArgv = process.execArgv.filter((arg) => !arg.startsWith("--inspect") && !arg.startsWith("--debug"));
  return { file: process.execPath, args: [...execArgv, process.argv[1]!] };
}

function positiveInteger(value: string | undefined, fallback: number, max: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= max ? number : fallback;
}

export class WorkspaceHost {
  private readonly running = new Map<string, Running>();
  private readonly starting = new Map<string, Promise<Running>>();
  private readonly failures = new Map<string, { count: number; at: number }>();
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 64 });
  private readonly options: WorkspaceHostOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (line: string) => void;
  private readonly maxRunning: number;
  private readonly idleMs: number;
  private readonly sweeper: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(options: WorkspaceHostOptions) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.log = options.log ?? ((line) => console.warn(line));
    this.maxRunning = options.maxRunning ?? positiveInteger(this.env.NATION_WORKSPACE_MAX_RUNNING, 20, 1_000);
    this.idleMs = options.idleMs ?? positiveInteger(this.env.NATION_WORKSPACE_IDLE_MINUTES, 30, 24 * 60) * 60_000;
    this.sweeper = setInterval(() => { void this.sweep(); }, 60_000);
    this.sweeper.unref();
  }

  rootOf(workspaceId: string): string {
    if (!isWorkspaceId(workspaceId)) throw new Error("invalid workspace id");
    return join(this.options.dataDir, "workspaces", workspaceId);
  }

  isRunning(workspaceId: string): boolean {
    return this.running.has(workspaceId);
  }

  runningCount(): number {
    return this.running.size;
  }

  /** Create the folder on first use and (re)write the settings this server owns. */
  prepare(ref: WorkspaceRef): string {
    const root = this.rootOf(ref.id);
    mkdirSync(join(root, "tmp"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "logs"), { recursive: true, mode: 0o700 });
    const configFile = join(root, "config.json");
    const next = workspaceConfig(readJson(configFile), ref.email, this.options.sharedSettings?.() ?? {});
    const temp = `${configFile}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, configFile);
    return root;
  }

  /** The workspace server for this account, started if it is not running. */
  async ensure(ref: WorkspaceRef): Promise<{ port: number; token: string }> {
    if (this.closed) throw new Error("workspace host is closed");
    const current = this.running.get(ref.id);
    if (current && !current.stopping) {
      current.lastUsedAt = Date.now();
      return current;
    }
    let pending = this.starting.get(ref.id);
    if (!pending) {
      pending = (async () => {
        if (current) await current.exited;
        return this.start(ref);
      })();
      this.starting.set(ref.id, pending);
      const clear = () => { if (this.starting.get(ref.id) === pending) this.starting.delete(ref.id); };
      pending.then(clear, clear);
    }
    const started = await pending;
    started.lastUsedAt = Date.now();
    return started;
  }

  private async start(ref: WorkspaceRef): Promise<Running> {
    const failure = this.failures.get(ref.id);
    if (failure && failure.count >= 3 && Date.now() - failure.at < 60_000) {
      throw Object.assign(new Error(`workspace ${ref.id} failed to start ${failure.count} times; waiting before another try`), { status: 503 });
    }
    await this.makeRoom();
    const root = this.prepare(ref);
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const running = await this.launch(ref, root);
        this.failures.delete(ref.id);
        return running;
      } catch (error) {
        lastError = error;
        this.log(`workspace ${ref.id} did not start (attempt ${attempt + 1}): ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    const previous = this.failures.get(ref.id);
    this.failures.set(ref.id, { count: (previous && Date.now() - previous.at < 5 * 60_000 ? previous.count : 0) + 1, at: Date.now() });
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private openLog(root: string): number {
    const file = join(root, "logs", "server.log");
    try {
      if (statSync(file).size > 10 * 1024 * 1024) renameSync(file, `${file}.1`);
    } catch {
      // no log yet
    }
    return openSync(file, "a", 0o600);
  }

  private async launch(ref: WorkspaceRef, root: string): Promise<Running> {
    const port = await freePortPair();
    const key = randomBytes(32).toString("base64url");
    const command = this.options.command ?? ownServerCommand();
    const log = this.openLog(root);
    let child: ChildProcess;
    try {
      child = spawn(command.file, command.args, {
        cwd: command.cwd ?? process.cwd(),
        env: workspaceServerEnvironment(this.env, {
          root, port, workspaceId: ref.id, key, creditsDb: this.options.creditsDb, brandFile: this.options.brandFile?.() ?? null,
        }),
        stdio: ["ignore", log, log],
      });
    } finally {
      closeSync(log);
    }
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    const stop = async () => {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    };
    try {
      await this.waitReady(child, port, exited);
      const token = await this.mintSession(port, key, ref);
      const running: Running = { ref, child, port, key, token, startedAt: Date.now(), lastUsedAt: Date.now(), inflight: 0, exited, stopping: false };
      this.running.set(ref.id, running);
      void exited.then(() => {
        if (this.running.get(ref.id) === running) this.running.delete(ref.id);
        if (!running.stopping) this.log(`workspace ${ref.id} stopped unexpectedly (exit ${child.exitCode ?? child.signalCode}); it starts again on its next request`);
      });
      return running;
    } catch (error) {
      await stop();
      throw error;
    }
  }

  private async waitReady(child: ChildProcess, port: number, exited: Promise<void>): Promise<void> {
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 45_000);
    let gone = false;
    void exited.then(() => { gone = true; });
    for (;;) {
      if (gone || child.exitCode !== null) throw new Error(`the workspace server exited while starting (exit ${child.exitCode ?? child.signalCode})`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_000) });
        const body = response.ok ? await response.json() as { app?: string } : null;
        if (body?.app === "nation-team-chat") return;
      } catch {
        // still starting
      }
      if (Date.now() >= deadline) throw new Error("the workspace server did not become ready in time");
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  private async mintSession(port: number, key: string, ref: WorkspaceRef): Promise<string> {
    const response = await fetch(`http://127.0.0.1:${port}${WORKSPACE_SESSION_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", [WORKSPACE_KEY_HEADER]: key },
      body: JSON.stringify({ email: ref.email, userId: ref.userId }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({})) as { token?: unknown; error?: unknown };
    if (!response.ok || typeof body.token !== "string") throw new Error(`the workspace server refused its session (${response.status} ${typeof body.error === "string" ? body.error : ""})`);
    return body.token;
  }

  private async activity(running: Running): Promise<{ busy: boolean; keepAlive: boolean } | null> {
    try {
      const response = await fetch(`http://127.0.0.1:${running.port}${WORKSPACE_ACTIVITY_PATH}`, {
        headers: { [WORKSPACE_KEY_HEADER]: running.key }, signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return null;
      const body = await response.json() as { busy?: unknown; keepAlive?: unknown };
      return { busy: body.busy === true, keepAlive: body.keepAlive === true };
    } catch {
      return null;
    }
  }

  /** Stop the least recently used idle workspace when the running limit is reached. */
  private async makeRoom(): Promise<void> {
    if (this.running.size < this.maxRunning) return;
    const candidates = [...this.running.values()].filter((item) => item.inflight === 0 && !item.stopping).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const candidate of candidates) {
      const activity = await this.activity(candidate);
      if (activity && !activity.busy && !activity.keepAlive) {
        await this.stop(candidate.ref.id, "making room");
        return;
      }
    }
    throw Object.assign(new Error(`${this.running.size} workspaces are running, the limit`), { status: 503, public: WORKSPACE_BUSY });
  }

  /** Stop workspaces nobody has used for a while, unless a turn is running or a routine keeps them awake. */
  async sweep(now = Date.now()): Promise<void> {
    for (const running of this.running.values()) {
      if (running.stopping || running.inflight > 0 || now - running.lastUsedAt < this.idleMs) continue;
      const activity = await this.activity(running);
      if (!activity || activity.busy || activity.keepAlive) continue;
      await this.stop(running.ref.id, "idle");
    }
  }

  async stop(workspaceId: string, reason: string): Promise<void> {
    const running = this.running.get(workspaceId);
    if (!running) return;
    running.stopping = true;
    this.running.delete(workspaceId);
    running.child.kill("SIGTERM");
    const timer = setTimeout(() => running.child.kill("SIGKILL"), 10_000);
    await running.exited;
    clearTimeout(timer);
    this.log(`workspace ${workspaceId} stopped (${reason})`);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    await Promise.all([...this.running.keys()].map((id) => this.stop(id, "server shutting down")));
    this.agent.destroy();
  }

  /** Forward one request to the account's workspace server, streaming both ways. */
  async forward(req: IncomingMessage, res: ServerResponse, ref: WorkspaceRef, clientIp: string): Promise<void> {
    const send = (status: number, error: string) => {
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error }));
    };
    let target: { port: number; token: string };
    try {
      target = await this.ensure(ref);
    } catch (error) {
      this.log(`workspace ${ref.id} unavailable: ${error instanceof Error ? error.message : String(error)}`);
      const busy = (error as { public?: unknown })?.public;
      return send(503, typeof busy === "string" ? busy : WORKSPACE_UNAVAILABLE);
    }
    const running = this.running.get(ref.id);
    if (running) running.inflight++;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (running) {
        running.inflight--;
        running.lastUsedAt = Date.now();
      }
    };
    await new Promise<void>((resolve) => {
      const upstream = httpRequest({
        host: "127.0.0.1",
        port: target.port,
        method: req.method,
        path: req.url,
        headers: forwardedRequestHeaders(req.headers, { token: target.token, port: target.port, clientIp }),
        agent: this.agent,
      });
      upstream.on("response", (response) => {
        // The session this server holds there was refused: never show a
        // member a sign-in error for our credential. Mint a new one next time.
        if (response.statusCode === 401 && running) {
          response.resume();
          void this.mintSession(running.port, running.key, ref)
            .then((token) => { running.token = token; })
            .catch(() => this.stop(ref.id, "its session was refused"));
          send(503, WORKSPACE_NO_ANSWER);
          finish();
          return resolve();
        }
        const headers = returnedResponseHeaders(response.headers);
        // writeHead would replace a cookie this server already set (the account cookie's renewal).
        const already = res.getHeader("set-cookie");
        if (already !== undefined && headers["set-cookie"]) {
          headers["set-cookie"] = [...(Array.isArray(already) ? already : [String(already)]), ...(headers["set-cookie"] as string[])];
        }
        res.writeHead(response.statusCode ?? 502, headers);
        if (String(response.headers["content-type"] ?? "").startsWith("text/event-stream")) res.flushHeaders();
        response.pipe(res);
        response.on("end", () => { finish(); resolve(); });
        response.on("error", () => { res.destroy(); finish(); resolve(); });
      });
      upstream.on("error", (error) => {
        this.log(`workspace ${ref.id} request failed: ${error.message}`);
        send(502, WORKSPACE_NO_ANSWER);
        finish();
        resolve();
      });
      res.on("close", () => {
        if (!finished) upstream.destroy();
        finish();
        resolve();
      });
      req.pipe(upstream);
    });
  }
}
