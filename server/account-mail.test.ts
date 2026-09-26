import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountMailer, magicLinkMessage, type MailMessage } from "./account-mail.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "nation-mail-")); dirs.push(dir); return dir; };

const LINK = "https://thenation.city/swarm/#login=nml_abc";
// Nation Team Chat is the only name a person should see.
const FOREIGN = /open\s*maus|open\s*muse|anthropic|claude|hermes|nous|venice|github|open[- ]source/i;

describe("sign-in email", () => {
  it("names Nation Team Chat, the address, the link and its lifetime, and nothing else", () => {
    const message = magicLinkMessage({ to: "alice@example.test", link: LINK, expiresInMinutes: 15 }, "Nation Team Chat <login@thenation.city>");
    expect(message.subject).toBe("Your Nation Team Chat sign-in link");
    expect(message.text).toContain(LINK);
    expect(message.text).toContain("alice@example.test");
    expect(message.text).toContain("expires in 15 minutes");
    expect(message.html).toContain(`href="${LINK}"`);
    expect(message.html).toContain("#cdffa6");
    expect(`${message.subject}\n${message.text}\n${message.html}`).not.toMatch(FOREIGN);
  });

  it("escapes the address and link in HTML", () => {
    const message = magicLinkMessage({ to: "<b>x</b>@example.test", link: 'https://x.test/#login=a"onclick="b', expiresInMinutes: 1 }, "x");
    expect(message.html).not.toContain("<b>x</b>");
    expect(message.html).not.toContain('"onclick="');
    expect(message.text).toContain("expires in 1 minute.");
  });
});

describe("mail transport", () => {
  it("is off without SMTP or an outbox", async () => {
    const mailer = createAccountMailer({ dataDir: tempDir(), env: {} });
    expect(mailer.kind).toBe("none");
    await expect(mailer.send({ to: "a@example.test", link: LINK, expiresInMinutes: 15 })).rejects.toThrow();
  });

  it("sends through SMTP with the configured sender", async () => {
    const sent: MailMessage[] = [];
    const mailer = createAccountMailer({
      dataDir: tempDir(),
      env: { NATION_SMTP_URL: "smtps://user:pass@smtp.example.test:465", NATION_MAIL_FROM: "Nation Team Chat <login@thenation.city>" },
      smtp: async (message) => { sent.push(message); },
    });
    expect(mailer.kind).toBe("smtp");
    await mailer.send({ to: "alice@example.test", link: LINK, expiresInMinutes: 15 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: "Nation Team Chat <login@thenation.city>", to: "alice@example.test" });
  });

  it("refuses an SMTP address that is not smtp:// or smtps://", () => {
    expect(() => createAccountMailer({ dataDir: tempDir(), env: { NATION_SMTP_URL: "https://mail.example.test" } })).toThrow(/smtp/);
  });

  it("writes to an owner-only outbox in development", async () => {
    const dataDir = tempDir();
    const mailer = createAccountMailer({ dataDir, env: { NATION_MAIL_OUTBOX: "1" } });
    expect(mailer.kind).toBe("outbox");
    await mailer.send({ to: "alice@example.test", link: LINK, expiresInMinutes: 15 });
    const outbox = join(dataDir, "mail-outbox");
    const [file] = readdirSync(outbox);
    const message = JSON.parse(readFileSync(join(outbox, file!), "utf8"));
    expect(message).toMatchObject({ to: "alice@example.test", link: LINK });
    if (process.platform !== "win32") {
      expect(statSync(join(outbox, file!)).mode & 0o777).toBe(0o600);
      expect(statSync(outbox).mode & 0o777).toBe(0o700);
    }
  });
});
