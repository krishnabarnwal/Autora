/**
 * Single place that knows how to reach the backend.
 *
 * Locally VITE_API_BASE_URL is empty and Vite proxies /api to :5000.
 * In production it is set to the deployed backend origin.
 */
const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const message = body?.message || body?.error || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body;
}

export function getHealth() {
  return request('/api/health');
}
