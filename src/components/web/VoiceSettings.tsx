import { useEffect, useState } from "react";
import { api, useStore, type Bot } from "@/state/store";

export function VoiceSettings({ bot, onPatch }: {
  bot: Bot; onPatch: (patch: Partial<Pick<Bot, "voice" | "speakReplies">>) => void;
  workspaceConfigurationLocked?: boolean;
}) {
  const { state } = useStore();
  const configured = state.config?.tts?.configured === true;
  const [voices, setVoices] = useState<Array<{ id: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!configured) { setVoices([]); return; }
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    api("/api/tts/voices", { signal: controller.signal })
      .then((response: { voices?: Array<{ id: string }>; error?: string }) => {
        if (controller.signal.aborted) return;
        if (response.error) throw new Error("Voice list unavailable");
        setVoices(response.voices ?? []);
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [configured]);
  return <div className="rounded-xl bg-card p-4">
    <h3 className="text-[15px] font-medium text-ink">NATION voice</h3>
    <p className="mt-1 text-[13px] text-ink-secondary">
      {configured ? "Choose a voice for this agent." : "Voice is currently unavailable."}
    </p>
    {failed && <p role="alert" className="mt-2 text-[13px] text-danger">Could not load voices. Reopen this panel to try again.</p>}
    <select aria-label="Agent voice" disabled={!configured || loading || failed} value={bot.voice ?? ""}
      onChange={e => onPatch({ voice: e.target.value })} className="mt-3 w-full rounded-lg bg-inset p-2 text-ink">
      <option value="">{loading ? "Loading voices…" : "Default voice"}</option>
      {voices.map((voice, index) => <option key={voice.id} value={voice.id}>{`Voice ${index + 1}`}</option>)}
    </select>
    <label className="mt-3 flex items-center gap-2 text-[13px] text-ink">
      <input type="checkbox" disabled={!configured} checked={Boolean(bot.speakReplies)}
        onChange={e => onPatch({ speakReplies: e.target.checked })} /> Speak replies
    </label>
  </div>;
}
