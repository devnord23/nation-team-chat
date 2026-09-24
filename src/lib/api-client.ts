import { responseErrorMessage } from "./api-error-message";

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function apiUrl(path: string): string {
  if (path.startsWith("/")) return import.meta.env.BASE_URL + path.slice(1);
  return path;
}

export async function api<T = any>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  // timeoutMs races the fetch against AbortSignal.timeout, combined with any
  // caller signal so either can cancel. Omitted means no behavior change.
  const { timeoutMs, signal, ...rest } = init ?? {};
  const res = await fetch(apiUrl(path), {
    headers: { "content-type": "application/json" },
    ...rest,
    signal: timeoutMs === undefined
      ? signal
      : signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(responseErrorMessage(body, res.headers.get("x-nation-error-schema")), res.status);
  return body;
}

