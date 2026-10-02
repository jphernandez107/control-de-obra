// Minimal JSON client for the backend API. Errors carry the Spanish message
// produced by the server so screens can show it as-is.

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    // Pages check `error.name === "NotFoundError"` to show their empty state.
    this.name = status === 404 ? "NotFoundError" : "ApiError";
  }
}

const BASE = "/api";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body instanceof FormData || body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "network", "No hay conexión con el servidor. Revisa la conexión e intenta de nuevo.");
  }
  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(res.status, err?.code ?? "http_error", err?.message ?? `El servidor respondió con un error (${res.status}).`);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  upload: <T>(path: string, form: FormData) => request<T>("POST", path, form),
};

/** Human message for any thrown value. */
export function errorMessage(error: unknown, fallback = "No se pudo completar la acción. Intenta de nuevo."): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}
