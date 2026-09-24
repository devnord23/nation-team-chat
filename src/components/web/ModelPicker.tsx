import type { ReactNode } from "react";
import type { Bot } from "@/state/store";

/** The hosted web app always uses the server-managed NATION API. */
export function ModelPicker({ className, label }: {
  bot: Bot; threadId?: string; contained?: boolean; className?: string; label?: ReactNode;
}) {
  return <div className={className}>{label}<span title="NATION API" className="text-[12px] font-medium text-ink-secondary">NATION API</span></div>;
}
