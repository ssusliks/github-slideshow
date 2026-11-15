import { CONFIG } from '../config';

/** Minimal JSON-over-HTTP client with a hard timeout; every failure becomes a typed result. */
export interface HttpResult<T = any> { ok: boolean; status: number; data: T | null; error?: 'offline' | 'timeout' | 'network' | 'http' | 'disabled' }

export const isOnline = (): boolean => (typeof navigator === 'undefined' ? true : navigator.onLine !== false);
export const cloudConfigured = (): boolean => !!CONFIG.apiUrl;

export async function api<T = any>(method: string, path: string, body?: unknown, token?: string, timeoutMs = 12000): Promise<HttpResult<T>> {
  if (!CONFIG.apiUrl) return { ok: false, status: 0, data: null, error: 'disabled' };
  if (!isOnline()) return { ok: false, status: 0, data: null, error: 'offline' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(CONFIG.apiUrl.replace(/\/$/, '') + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let data: any = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, data, error: res.ok ? undefined : 'http' };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: (e as Error)?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}
