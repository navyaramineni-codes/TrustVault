/**
 * TrustVault API Client
 *
 * Enforces security constraints:
 * - Plain fetch with credentials: 'include' (session cookie only, no localStorage)
 * - Single-fetch CSRF token cache sent on all state-changing requests (POST, PUT, PATCH, DELETE)
 * - Auto-retries on CSRF expiration
 * - Structured error handling with generic 404 recognition
 */

let cachedCsrfToken = null;
let csrfFetchPromise = null;

export class ApiError extends Error {
  constructor(status, data) {
    const message = data?.error || data?.message || `HTTP ${status}`;
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

/**
 * Fetch and cache the double-submit CSRF token once.
 * Reuses the cached token in memory; never writes to web storage.
 */
export async function getCsrfToken(forceRefresh = false) {
  if (cachedCsrfToken && !forceRefresh) {
    return cachedCsrfToken;
  }

  if (csrfFetchPromise && !forceRefresh) {
    return csrfFetchPromise;
  }

  csrfFetchPromise = (async () => {
    try {
      const response = await fetch('/api/auth/csrf-token', {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch CSRF token (status ${response.status})`);
      }

      const data = await response.json();
      cachedCsrfToken = data.csrfToken || null;
      return cachedCsrfToken;
    } finally {
      csrfFetchPromise = null;
    }
  })();

  return csrfFetchPromise;
}

/**
 * Invalidate in-memory CSRF token (e.g. on logout or session reset)
 */
export function clearCsrfToken() {
  cachedCsrfToken = null;
  csrfFetchPromise = null;
}

/**
 * Centralized fetch wrapper enforcing credentials: 'include' and automatic CSRF headers.
 *
 * @param {string} endpoint - API path (e.g. '/api/documents')
 * @param {RequestInit} [options={}] - Standard fetch options
 * @returns {Promise<any>} Parsed JSON response or blob
 */
export async function apiFetch(endpoint, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const isStateChanging = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');

  // Attach CSRF token on every state-changing request
  if (isStateChanging) {
    const token = await getCsrfToken();
    if (token) {
      headers.set('x-csrf-token', token);
    }
  }

  // Format body as JSON unless it is FormData or Blob
  let body = options.body;
  if (body && !(body instanceof FormData) && !(body instanceof Blob)) {
    if (!headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (typeof body === 'object') {
      body = JSON.stringify(body);
    }
  }

  const fetchOptions = {
    ...options,
    method,
    headers,
    body,
    credentials: 'include', // Guarantees session cookies stay same-origin through Vite proxy
  };

  let response = await fetch(endpoint, fetchOptions);

  // If rejected with 403 due to CSRF token mismatch/expiration, refresh token and retry once
  if (response.status === 403 && isStateChanging) {
    const clone = response.clone();
    try {
      const errData = await clone.json();
      if (errData?.error && String(errData.error).toLowerCase().includes('csrf')) {
        const freshToken = await getCsrfToken(true);
        if (freshToken) {
          headers.set('x-csrf-token', freshToken);
          response = await fetch(endpoint, {
            ...fetchOptions,
            headers,
          });
        }
      }
    } catch {
      // Continue with original response if body is not JSON
    }
  }

  if (!response.ok) {
    let errData = null;
    try {
      errData = await response.json();
    } catch {
      errData = null;
    }
    throw new ApiError(response.status, errData || { error: response.statusText });
  }

  // Handle non-JSON, file download, or attachment responses
  const contentDisposition = (response.headers.get('content-disposition') || '').toLowerCase();
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const isAttachment = contentDisposition.includes('attachment');
  const isDownloadEndpoint = endpoint.includes('/download');
  const isNonJsonResponse = !contentType.includes('application/json') && contentType !== '';

  if (isAttachment || isDownloadEndpoint || isNonJsonResponse) {
    return response.blob();
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return data;
}
