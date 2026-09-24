/** HTTP errors carrying our server's response schema have already been filtered.
 * Unknown proxy responses get a local message, never raw infrastructure text. */
export function responseErrorMessage(body: unknown, schema: string | null): string {
  const fallback = "NATION couldn't complete this request. Please try again or contact support.";
  if (schema !== "public-v1" || !body || typeof body !== "object") return fallback;
  const error = (body as Record<string, unknown>).error;
  if (typeof error !== "string") return fallback;
  const message = error.trim();
  return message && message.length <= 350 && !/[\r\n]/.test(message) ? message : fallback;
}
