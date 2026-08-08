/**
 * Typed fetch against the console API. The bearer token authorizes every
 * mutation; it arrives once in the URL fragment (never sent to a server,
 * never logged) and lives in sessionStorage for the tab.
 */

const TOKEN_KEY = "jaa.console.token";

export function readTokenFromHash(): void {
  const hash = window.location.hash;
  const match = hash.match(/token=([a-f0-9]{64})/i);
  if (match?.[1]) {
    sessionStorage.setItem(TOKEN_KEY, match[1]);
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token.trim());
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new ApiError(await errorText(res), res.status);
  return (await res.json()) as T;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new ApiError(await errorText(res), res.status);
  return (await res.json()) as T;
}

export async function apiUpload(
  path: string,
  file: File,
  headers: Record<string, string>,
): Promise<unknown> {
  const token = getToken();
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: file,
  });
  if (!res.ok) throw new ApiError(await errorText(res), res.status);
  return res.json();
}

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
