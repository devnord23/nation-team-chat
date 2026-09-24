import { useRef, useState } from "react";
import { useStore } from "@/state/store";

export function AvatarImageGenerator({ botLabel, disabled, generating, onGenerate }: {
  botLabel: string; disabled: boolean; generating: boolean;
  onGenerate: (direction: string) => Promise<void>; onSavingChange: (saving: boolean) => void;
}) {
  const { state } = useStore();
  const configured = state.config?.imageGen?.configured === true;
  const [direction, setDirection] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const busy = disabled || generating || pending;
  const generate = async () => {
    if (busy || !configured || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try { await onGenerate(direction.trim()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Image generation failed. Try again."); }
    finally { inFlight.current = false; setPending(false); }
  };
  return <div className="mt-5 border-t border-hairline/40 pt-4">
    <h3 className="text-[13px] font-medium text-ink">Generate with NATION API</h3>
    <p className="mt-2 text-[12px] text-ink-secondary">
      {configured ? "Image generation uses your NATION credits." : "Image generation is currently unavailable."}
    </p>
    <textarea value={direction} disabled={busy} maxLength={400}
      onChange={event => setDirection(event.target.value.slice(0, 400))}
      aria-label="Avatar generation direction" placeholder={`Optional direction for ${botLabel}`}
      className="mt-3 min-h-[72px] w-full rounded-lg border border-hairline/40 bg-inset p-2 text-[13px] text-ink" />
    <button type="button" disabled={busy || !configured} onClick={() => void generate()} className="ui-button mt-2">
      {busy ? "Generating…" : "Generate avatar"}
    </button>
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
  </div>;
}
