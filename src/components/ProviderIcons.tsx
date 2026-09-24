// Product marks use the existing NATION asset; custom instance images remain supported.
import { useState } from "react";
import { cn } from "@/lib/cn";
import type { InstanceInfo } from "@/state/store";
import type { ProviderIconPreset } from "../../shared/provider-icon";

export interface IconProps { size?: number; className?: string }
export function NationMark({ size = 16, className }: IconProps) {
  return <img src={`${import.meta.env.BASE_URL}nation-logo.svg`} alt="" width={size} height={size}
    className={cn("object-contain", className)} />;
}
export function ProviderMark({ size, className }: IconProps & { driverKind: string }) {
  return <NationMark size={size} className={className} />;
}
export function PresetProviderMark({ size, className }: IconProps & { preset: ProviderIconPreset }) {
  return <NationMark size={size} className={className} />;
}
export function InstanceProviderMark({ instance, size = 16, className }: IconProps & {
  instance: Pick<InstanceInfo, "driverKind" | "icon">;
}) {
  if (instance.icon?.kind === "custom") {
    return <CustomProviderMark key={instance.icon.dataUrl} dataUrl={instance.icon.dataUrl} size={size} className={className} />;
  }
  return <NationMark size={size} className={className} />;
}
function CustomProviderMark({ dataUrl, size = 16, className }: IconProps & { dataUrl: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <NationMark size={size} className={className} />
    : <img src={dataUrl} alt="" width={size} height={size} onError={() => setFailed(true)}
        className={cn("rounded-[22%] object-cover", className)} />;
}
