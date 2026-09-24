import { ModelPicker } from "../web/ModelPicker";
import type { Bot } from "@/state/store";

export function ModelSection({ bot }: { bot: Bot }) {
  return <div className="rounded-xl bg-card p-4">
    <ModelPicker bot={bot} label={<div className="mb-2">
      <div className="text-[15px] font-medium text-ink">NATION API</div>
      <p className="mt-1 text-[13px] text-ink-secondary">Your agent uses the model managed by NATION.</p>
    </div>} />
  </div>;
}
