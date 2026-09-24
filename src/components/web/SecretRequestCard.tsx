import { useState } from "react";
import { api, type Message } from "@/state/store";

/** Provider setup is managed by the owner on the server. Never collect keys in web chat. */
export function SecretRequestCard({ botId, threadId, message }: { botId: string; threadId: string; message: Message }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const secret = message.secret;
  if (!secret || secret.provided || secret.dismissed) return null;
  const dismiss = async () => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await api(`/api/bots/${encodeURIComponent(botId)}/secret-cards/${encodeURIComponent(message.id)}/dismiss`, {
        method: "POST", body: JSON.stringify({ threadId }),
      });
    } catch { setError("Could not continue. Please try again."); }
    finally { setPending(false); }
  };
  return <div className="rounded-xl border border-hairline/40 bg-card p-4">
    <h3 className="text-[14px] font-medium text-ink">Service setup needed</h3>
    <p className="mt-1 text-[13px] text-ink-secondary">Contact the workspace owner to configure this service.</p>
    <button type="button" disabled={pending} onClick={() => void dismiss()} className="ui-button mt-3">
      {pending ? "Continuing…" : "Continue without this service"}
    </button>
    {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
  </div>;
}
