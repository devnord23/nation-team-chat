import { useEffect, useRef, useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { isProductAdmin } from "@/lib/admin-gate";
import { setEmailGateDone } from "@/lib/analytics";
import { completionPatch, type BeatId } from "@/lib/onboarding";
import type { MausMotion } from "@/lib/mascot";

const STEPS = [
  { face: "coordinator", title: "Welcome to Nation Team Chat", text: "Your AI teammates share a workspace to plan, build, and get work done." },
  { face: "builder", title: "Give your team a job", text: "Start a chat or create a team. Mention an agent by name to ask for its help." },
  { face: "researcher", title: "Keep working together", text: "Follow your agents’ work, review their results, and return to the same conversations." },
];

export function WelcomeFlow({ onDone, embedded = false }: {
  bot: Bot | null; onDone: () => void; replay?: boolean; initialBeat?: BeatId;
  embedded?: boolean; reel?: boolean; dictation?: boolean; entrance?: Exclude<MausMotion, "none">;
}) {
  const { state, dispatch } = useStore();
  const [step, setStep] = useState(0);
  const nextRef = useRef<HTMLButtonElement>(null);
  const finishing = useRef(false);
  useEffect(() => { nextRef.current?.focus(); }, [step]);
  const finish = () => {
    if (finishing.current) return;
    finishing.current = true;
    setEmailGateDone("submitted");
    onDone();
    if (isProductAdmin({ isProductOwner: state.config?.isProductOwner, pinRequired: state.config?.adminGate?.pinRequired })) {
      void api("/api/config", { method: "PUT", body: JSON.stringify(completionPatch()) })
        .then(config => dispatch({ type: "configStatus", config })).catch(() => undefined);
    }
  };
  const current = STEPS[step]!;
  return (
    <div className={embedded ? "flex h-full items-center justify-center p-6" : "fixed inset-0 z-50 flex items-center justify-center bg-app/95 p-6"}>
      <section role="dialog" aria-modal="true" aria-labelledby="nation-welcome-title"
        className="w-full max-w-md rounded-3xl border border-hairline/40 bg-panel p-8 text-center shadow-2xl"
        onKeyDown={event => {
          if (event.key === "Escape") finish();
          if (event.key === "Tab") {
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
            const first = buttons[0], last = buttons.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <img src={`${import.meta.env.BASE_URL}bot-faces/${current.face}.png`} alt="NATION agent" className="mx-auto mb-6 size-28 rounded-3xl" />
        <p className="mb-2 text-xs font-medium tracking-widest text-ink-secondary">NATION</p>
        <h1 id="nation-welcome-title" className="text-2xl font-semibold text-ink">{current.title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-secondary">{current.text}</p>
        <p className="mt-6 text-xs text-ink-secondary" aria-live="polite">{step + 1} of {STEPS.length}</p>
        <button ref={nextRef} className="mt-3 w-full rounded-xl bg-accent p-3 font-medium text-accent-ink"
          onClick={() => step === STEPS.length - 1 ? finish() : setStep(step + 1)}>{step === STEPS.length - 1 ? "Start working" : "Continue"}</button>
        <button className="mt-3 p-2 text-sm text-ink-secondary" onClick={finish}>Skip tour</button>
        <a className="mt-4 block text-xs text-ink-secondary" href="https://t.me/thenation_city" target="_blank" rel="noreferrer">NATION support</a>
      </section>
    </div>
  );
}
