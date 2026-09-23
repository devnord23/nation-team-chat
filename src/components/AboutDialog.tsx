// "About NATION Team" — version and Nation branding for end users.
import { useEffect, useRef } from "react";

import { APP_NAME, appVersion, platformLabel } from "@/lib/app-links";

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const platform = platformLabel(window.ogb?.platform);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-dialog-title"
        className="w-full max-w-[360px] rounded-2xl border border-hairline/50 bg-panel p-6 text-center shadow-2xl"
      >
        <img src="/nation-logo.svg" alt="Nation" width={56} height={56} className="mx-auto size-14" onError={(e) => { const img = e.currentTarget; if (img.src.includes("nation-logo")) img.src = "/app-icon.svg"; }} />
        <h2 id="about-dialog-title" className="mt-3 text-[17px] font-semibold text-ink">
          {APP_NAME}
        </h2>
        <p className="mt-1 text-[13px] text-ink-secondary">
          Version {appVersion()}
          {platform ? ` · ${platform}` : ""}
        </p>
        <p className="mt-4 text-[18px] font-semibold tracking-tight text-ink">Nation</p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
          Your own team of AI bots, in a chat app.
        </p>
        <p className="mt-3 text-[12.5px] leading-relaxed text-ink-secondary">
          NATION · thenation.city · @visitnation
        </p>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="mt-5 w-full rounded-xl bg-raised px-4 py-2 text-[13px] font-medium text-ink hover:brightness-110"
        >
          Close
        </button>
      </div>
    </div>
  );
}