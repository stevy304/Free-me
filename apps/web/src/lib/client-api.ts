'use client';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterSeconds?: number) { super(message); }
}

/** Calls the API from the browser (same origin, session cookie included). Throws ApiError with the API's message. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const multipart = init.body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      credentials: 'same-origin',
      headers: init.body === undefined || multipart ? undefined : { 'content-type': 'application/json' },
      body: multipart ? init.body as FormData : init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError('No connection. Check your internet and try again.', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = Array.isArray(data.message) ? data.message[0] : data.message;
    throw new ApiError(typeof msg === 'string' && msg ? msg : 'Something went wrong. Please try again.', res.status, data.retryAfterSeconds);
  }
  return data as T;
}
