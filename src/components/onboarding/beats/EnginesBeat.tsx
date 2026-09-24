import { useEffect, useState } from "react";
import { useStore } from "@/state/store";
import { PrimaryButton, type BeatProps } from "./shared";

export function EnginesBeat({ onNext, setMascot }: BeatProps) {
  const { state, refreshInstances } = useStore();
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const ready = state.instances.some(instance =>
    instance.snapshot.state === "available" && instance.snapshot.authenticated !== false);
  useEffect(() => { setMascot(ready ? "proud" : "curious"); }, [ready, setMascot]);
  const check = async () => {
    if (checking) return;
    setChecking(true);
    setFailed(false);
    try { await refreshInstances(); } catch { setFailed(true); } finally { setChecking(false); }
  };
  return <div className="flex min-h-0 flex-col">
    <h2 className="text-[15px] font-medium text-ink">NATION API</h2>
    <p role="status" className="mt-2 text-[13px] text-ink-secondary">
      {ready ? "Your team is ready to use NATION API." : "NATION API is temporarily unavailable. Please try again in a moment."}
    </p>
    {failed && <p role="alert" className="mt-2 text-[13px] text-danger">Could not check availability. Try again.</p>}
    <button type="button" disabled={checking} onClick={() => void check()} className="ui-button mt-3">
      {checking ? "Checking…" : "Check again"}
    </button>
    <PrimaryButton onClick={onNext} className="mt-5">Continue</PrimaryButton>
  </div>;
}
