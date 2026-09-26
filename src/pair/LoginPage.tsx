import { useEffect, useRef, useState } from "react";

import { defaultDeviceLabel, peekMagicLink, reasonWorthShowing, startMagicLink, verifyMagicLink } from "../lib/session";

const MARK_SRC = `${import.meta.env.BASE_URL}nation-mark.png`;
const RESEND_AFTER_MS = 30_000;

const field = "mt-1.5 w-full rounded-lg border border-white/15 bg-white/[0.04] px-3.5 py-2.5 text-[15px] text-white outline-none placeholder:text-white/35 focus:border-nation";
const primary = "mt-5 w-full rounded-lg bg-nation px-4 py-2.5 text-[15px] font-semibold text-nation-ink transition-opacity disabled:opacity-50";
const quiet = "mt-3 w-full text-[13px] text-white/60 underline decoration-white/25 underline-offset-2 hover:text-white";

type Step =
  | { kind: "email" }
  | { kind: "sent"; email: string; at: number }
  | { kind: "checking" }
  | { kind: "confirm"; email: string }
  | { kind: "signing-in"; email: string };

/** Sign in to Nation Team Chat with an emailed link. The same link creates a
 * workspace on first use. A link opens the app at `#login=…`; this page asks
 * before using it, so a mail scanner that opens links cannot spend it. */
export function LoginPage({ initialToken = null, reason }: { initialToken?: string | null; reason?: string }) {
  const [step, setStep] = useState<Step>(initialToken ? { kind: "checking" } : { kind: "email" });
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const token = useRef(initialToken);

  useEffect(() => {
    if (!initialToken) return;
    let active = true;
    void peekMagicLink(initialToken).then((result) => {
      if (!active) return;
      if (result.ok) setStep({ kind: "confirm", email: result.email });
      else {
        token.current = null;
        setError(result.error);
        setStep({ kind: "email" });
      }
    });
    return () => { active = false; };
  }, [initialToken]);

  useEffect(() => {
    if (step.kind !== "sent") return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [step.kind]);

  async function send(address: string) {
    setBusy(true);
    setError(null);
    const result = await startMagicLink(address);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setNow(Date.now());
    setStep({ kind: "sent", email: address.trim().toLowerCase(), at: Date.now() });
  }

  async function confirm(address: string) {
    if (!token.current) return;
    setStep({ kind: "signing-in", email: address });
    setError(null);
    const result = await verifyMagicLink({ token: token.current, label: defaultDeviceLabel() });
    if (result.ok) {
      location.replace(import.meta.env.BASE_URL);
      return;
    }
    token.current = null;
    setError(result.error);
    setStep({ kind: "email" });
  }

  const shownReason = step.kind === "email" && !error ? reasonWorthShowing(reason) : null;
  const waitMs = step.kind === "sent" ? Math.max(0, step.at + RESEND_AFTER_MS - now) : 0;

  return (
    <main className="flex min-h-screen items-center justify-center bg-nation-ink px-4 py-10 text-white">
      <div className="w-full max-w-[400px]" data-testid="nation-login">
        <img src={MARK_SRC} alt="NATION" width={48} height={48} className="size-12 rounded-xl" />
        {step.kind === "checking" ? (
          <p className="mt-8 text-[15px] text-white/70" aria-live="polite">Checking your sign-in link…</p>
        ) : step.kind === "confirm" || step.kind === "signing-in" ? (
          <>
            <h1 className="mt-8 text-[26px] font-bold leading-tight tracking-tight">Sign in to Nation Team Chat</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-white/70">
              Continue as <span className="font-semibold text-white">{step.email}</span>.
            </p>
            <button type="button" className={primary} disabled={step.kind === "signing-in"} onClick={() => void confirm(step.email)}>
              {step.kind === "signing-in" ? "Signing in…" : "Continue"}
            </button>
            <button type="button" className={quiet} onClick={() => { token.current = null; setStep({ kind: "email" }); }}>
              Not you? Use another email
            </button>
          </>
        ) : step.kind === "sent" ? (
          <>
            <h1 className="mt-8 text-[26px] font-bold leading-tight tracking-tight">Check your email</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-white/70" aria-live="polite">
              We sent a sign-in link to <span className="font-semibold text-white">{step.email}</span>. Open it on this device. It works once and expires soon.
            </p>
            {error ? <p className="mt-4 text-[13.5px] text-[#ff8a95]" role="alert">{error}</p> : null}
            <button type="button" className={primary} disabled={busy || waitMs > 0} onClick={() => void send(step.email)}>
              {busy ? "Sending…" : waitMs > 0 ? `Send another link in ${Math.ceil(waitMs / 1000)}s` : "Send another link"}
            </button>
            <button type="button" className={quiet} onClick={() => { setError(null); setStep({ kind: "email" }); }}>
              Use a different email
            </button>
          </>
        ) : (
          <form onSubmit={(event) => { event.preventDefault(); void send(email); }}>
            <h1 className="mt-8 text-[26px] font-bold leading-tight tracking-tight">Sign in to Nation Team Chat</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-white/70">
              Enter your email and we will send you a sign-in link. New here? The same link sets up your own workspace, with starter credit to try your teammates.
            </p>
            {shownReason ? <p className="mt-4 text-[13.5px] text-white/70">{shownReason}</p> : null}
            <label className="mt-6 block text-[13px] font-medium text-white/80" htmlFor="login-email">Email</label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              inputMode="email"
              spellCheck={false}
              autoFocus
              className={field}
            />
            {error ? <p className="mt-3 text-[13.5px] text-[#ff8a95]" role="alert">{error}</p> : null}
            <button type="submit" className={primary} disabled={busy || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())}>
              {busy ? "Sending…" : "Email me a sign-in link"}
            </button>
          </form>
        )}
        <p className="mt-8 text-center text-[12.5px] text-white/50">
          Need help?{" "}
          <a href="https://t.me/thenation_city" target="_blank" rel="noopener noreferrer" className="text-nation underline decoration-nation/40 underline-offset-2">
            Message us on Telegram
          </a>
        </p>
      </div>
    </main>
  );
}
