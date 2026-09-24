// Who a bot conversation belongs to, in a hosted multi-account workspace.
//
// A bot's conversations (its tasks) are PRIVATE: each belongs to one NATION
// account, and only that account's sessions may list, read, search, stream
// or act on it. Rooms (groups and their tasks) are the deliberately SHARED
// team surface and are not tracked here.
//
// Bots themselves are workspace-shared, and a bot's `threadId` is the task
// the bot currently has open. Each account therefore keeps its own "active
// task" per bot, so two members talking to the same bot never share a
// conversation. On a single-user install none of this applies.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";

/** The operator's own account id (credit ledger), and the owner assumed for
 * any conversation with no recorded owner: unknown is never "everyone". */
export const OPERATOR_ACCOUNT = "nation-operator";

const fileSchema = z.object({
  owners: z.record(z.string(), z.string()).default({}),
  active: z.record(z.string(), z.string()).default({}),
}).strict();

export class ThreadOwnership {
  private owners = new Map<string, string>();
  /** `${accountId}\0${botId}` -> threadId */
  private active = new Map<string, string>();

  private readonly file: string | undefined;

  constructor(file?: string) {
    this.file = file;
    if (!file || !existsSync(file)) return;
    try {
      const parsed = fileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      this.owners = new Map(Object.entries(parsed.owners));
      this.active = new Map(Object.entries(parsed.active));
    } catch {
      // An unreadable map must not open anything up: every conversation
      // then reads as the operator's until its owner is recorded again.
      console.warn("[threads] conversation ownership map was unreadable; conversations default to the operator");
    }
  }

  /** The recorded owner, if any. */
  recorded(threadId: string): string | undefined {
    return this.owners.get(threadId);
  }

  /** Record an owner once; an existing owner is never replaced. */
  claim(threadId: string, accountId: string): void {
    if (!threadId || !accountId || this.owners.has(threadId)) return;
    this.owners.set(threadId, accountId);
    this.save();
  }

  activeFor(accountId: string, botId: string): string | undefined {
    return this.active.get(`${accountId}\0${botId}`);
  }

  setActive(accountId: string, botId: string, threadId: string): void {
    const key = `${accountId}\0${botId}`;
    if (this.active.get(key) === threadId) return;
    this.active.set(key, threadId);
    this.save();
  }

  forget(threadId: string): void {
    let changed = this.owners.delete(threadId);
    for (const [key, value] of this.active) if (value === threadId) { this.active.delete(key); changed = true; }
    if (changed) this.save();
  }

  private save(): void {
    if (!this.file) return;
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ owners: Object.fromEntries(this.owners), active: Object.fromEntries(this.active) }), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
