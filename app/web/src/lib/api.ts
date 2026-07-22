// Thin typed API client. Every request goes through here so error handling and
// the 401-not-authenticated signal are consistent across the app.

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    (opts.headers as Record<string, string>)['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* some endpoints return no body */
  }

  if (!res.ok) {
    const msg =
      (data && typeof data === 'object' && 'error' in data && (data as { error: string }).error) ||
      `Request failed (${res.status})`;
    throw new ApiError(String(msg), res.status);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
