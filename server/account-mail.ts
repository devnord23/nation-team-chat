// The one email the public NATION server sends: a sign-in link.
//
//   NATION_SMTP_URL   smtps://user:password@smtp.example.com:465 (or smtp://…:587,
//                     upgraded with STARTTLS). The mail provider's credentials.
//   NATION_MAIL_FROM  the sender, e.g. "Nation Team Chat <login@thenation.city>".
//   NATION_MAIL_OUTBOX=1  development and fixtures only: instead of sending,
//                     write each message to <data dir>/mail-outbox/ as JSON.
//                     Anyone who can read that folder can sign in as anyone
//                     who asked for a link, so never set it on a public server.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MagicLinkMail {
  to: string;
  link: string;
  expiresInMinutes: number;
}

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface AccountMailer {
  readonly kind: "smtp" | "outbox" | "none";
  send(mail: MagicLinkMail): Promise<void>;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export function magicLinkMessage(mail: MagicLinkMail, from: string): MailMessage {
  const minutes = `${mail.expiresInMinutes} minute${mail.expiresInMinutes === 1 ? "" : "s"}`;
  const text = [
    "Sign in to Nation Team Chat",
    "",
    `Open this link to sign in as ${mail.to}:`,
    mail.link,
    "",
    `The link works once and expires in ${minutes}. If you did not ask for it, you can ignore this email.`,
    "",
    "Nation Team Chat",
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#020c01;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#e8f5dc">
<div style="max-width:440px;margin:0 auto">
<p style="margin:0 0 8px;font-size:20px;font-weight:600;color:#cdffa6">Sign in to Nation Team Chat</p>
<p style="margin:0 0 24px;font-size:14px;line-height:1.5">Use the button below to sign in as <strong>${escapeHtml(mail.to)}</strong>.</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(mail.link)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#cdffa6;color:#020c01;font-weight:600;font-size:14px;text-decoration:none">Sign in</a></p>
<p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#9fb394">The link works once and expires in ${minutes}. If you did not ask for it, you can ignore this email.</p>
<p style="margin:0;font-size:12px;line-height:1.5;color:#9fb394;word-break:break-all">${escapeHtml(mail.link)}</p>
</div></body></html>`;
  return { from, to: mail.to, subject: "Your Nation Team Chat sign-in link", text, html };
}

/** What sends sign-in links on this server, or `none` (email sign-in is then off). */
export function createAccountMailer(options: {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** Tests: replaces the SMTP connection. */
  smtp?: (message: MailMessage) => Promise<void>;
}): AccountMailer {
  const env = options.env ?? process.env;
  const url = env.NATION_SMTP_URL?.trim();
  const from = env.NATION_MAIL_FROM?.trim() || "Nation Team Chat <no-reply@thenation.city>";
  if (url || options.smtp) {
    if (url && !/^smtps?:\/\//i.test(url)) throw new Error("NATION_SMTP_URL must start with smtp:// or smtps://");
    let transport: Promise<(message: MailMessage) => Promise<void>> | null = null;
    const connect = () => transport ??= options.smtp ? Promise.resolve(options.smtp) : import("nodemailer").then(({ createTransport }) => {
      // Bounded, so a mail provider that stops answering fails the request instead of holding it.
      const mailer = createTransport({ url: url!, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
      return async (message: MailMessage) => { await mailer.sendMail(message); };
    });
    return {
      kind: "smtp",
      async send(mail) {
        const deliver = await connect();
        await deliver(magicLinkMessage(mail, from));
      },
    };
  }
  if (env.NATION_MAIL_OUTBOX === "1") {
    const outbox = join(options.dataDir, "mail-outbox");
    return {
      kind: "outbox",
      async send(mail) {
        mkdirSync(outbox, { recursive: true, mode: 0o700 });
        const message = magicLinkMessage(mail, from);
        const file = join(outbox, `${Date.now()}-${randomBytes(4).toString("hex")}.json`);
        writeFileSync(file, JSON.stringify({ ...message, link: mail.link }, null, 2) + "\n", { mode: 0o600 });
      },
    };
  }
  return { kind: "none", async send() { throw new Error("No mail transport is configured"); } };
}
