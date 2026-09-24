import { useState } from "react";
import { useStore } from "@/state/store";

export function NoEngines() {
  const { refreshInstances } = useStore();
  const [rechecking, setRechecking] = useState(false);
  const recheck = async () => {
    setRechecking(true);
    try { await refreshInstances(); } finally { setRechecking(false); }
  };
    return (
      <main className="flex h-full min-w-0 flex-1 items-center justify-center bg-app px-6">
        <div className="max-w-[520px] rounded-2xl border border-hairline/40 bg-card p-6 text-center">
          <h1 className="text-[20px] font-semibold text-ink">NATION API is temporarily unavailable</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-secondary">
            Please try again in a moment. Your team and work are saved.
          </p>
          <button onClick={() => void recheck()} disabled={rechecking} className="mt-5 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-60">
            {rechecking ? "Checking…" : "Check again"}
          </button>
        </div>
      </main>
    );
}
