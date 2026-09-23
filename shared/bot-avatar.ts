import { z } from "zod";

/**
 * `mascot` draws the animated mascot body, filled with the bot's colour
 * gradient. `circle`, `rounded`, and `square` crop the bot's own image
 * instead, shown as it is, with no mascot at all.
 */
export const BOT_AVATAR_CROPS = ["mascot", "circle", "rounded", "square"] as const;
export const botAvatarCropSchema = z.enum(BOT_AVATAR_CROPS);
export type BotAvatarCrop = z.infer<typeof botAvatarCropSchema>;

/**
 * Custom avatars are deliberately limited to this app's attachment server
 * OR the built-in nation-face set served from public/nation-faces/.
 * Besides making persisted profiles portable across desktop/browser clients,
 * this prevents a bot profile from becoming an external tracking pixel.
 * The nation-faces directory is an allowlist of trusted, script-free SVGs
 * that ship with the product.
 */
export const botAvatarUrlSchema = z
  .string()
  .regex(
    /^(?:\/api\/attachments\/[A-Za-z0-9-]+\.(?:png|jpg|gif|webp)|\/nation-faces\/[a-z]+\.svg)$/,
    "must be a stored PNG/JPEG/GIF/WebP attachment or a built-in nation-face SVG",
  );

export function botAvatarUrlFromStoredPath(path: string): string | null {
  const name = path.replaceAll("\\", "/").split("/").pop();
  if (!name) return null;
  const url = `/api/attachments/${name}`;
  return botAvatarUrlSchema.safeParse(url).success ? url : null;
}

/** Runtime-safe defaults for untrusted persisted/SSE profile data. */
export interface BotAvatarProfileInput {
  avatarUrl?: unknown;
  avatarCrop?: unknown;
}

export interface BotAvatarProfile {
  avatarUrl?: string;
  avatarCrop: BotAvatarCrop;
}

export function botAvatarProfile(value: BotAvatarProfileInput): BotAvatarProfile {
  const profile: BotAvatarProfile = {
    // Default to "circle" — bots without an explicit crop use the nation-face
    // image (served as a circle-cropped img) rather than the mascot blob.
    avatarCrop: botAvatarCropSchema.safeParse(value.avatarCrop).data ?? "circle",
  };
  const url = botAvatarUrlSchema.safeParse(value.avatarUrl);
  if (url.success) profile.avatarUrl = url.data;
  return profile;
}
