import { Dot } from './ui.jsx';
import { relativeTime } from '../lib/format.js';

/**
 * The degraded-state strip above the dashboard.
 *
 * Each banner reports a condition the backend actually reported — an
 * unreachable API, a database the health check calls unhealthy, rate-limit
 * events in the activity buffer, or a failed cycle the agent recorded. Nothing
 * here is inferred: no backend signal means no banner.
 */
export function DegradedBanners({ health, detail, rateLimited }) {
  const notes = [];
  const agent = detail?.agent;

  if (health.error) {
    notes.push({
      tone: 'bad',
      text: 'The backend is unreachable. Every panel below shows the last successful read, if any.',
    });
  } else if (health.data && health.data.ok === false) {
    notes.push({
      tone: 'bad',
      text: `Backend reports not ready — database ${health.data.database?.status || 'unavailable'}.`,
    });
  }

  if (rateLimited.length > 0) {
    notes.push({
      tone: 'warn',
      text: `Provider temporarily rate-limited generation in ${rateLimited.length} recent event(s). The autonomous loop remains active; a cycle may skip publishing.`,
    });
  }

  if (agent?.status === 'error' && detail?.lastError?.message) {
    notes.push({
      tone: 'warn',
      text: `Last cycle failed: ${detail.lastError.message}${
        relativeTime(detail.lastError.at) ? ` (${relativeTime(detail.lastError.at)})` : ''
      }`,
    });
  }

  if (notes.length === 0) return null;

  return (
    <div className="space-y-2">
      {notes.map((note, index) => (
        <div
          key={index}
          role="alert"
          className={`flex items-start gap-2.5 rounded-lg border px-4 py-2.5 text-sm ${
            note.tone === 'bad'
              ? 'border-red-400/30 bg-red-400/5 text-red-400'
              : 'border-amber-400/30 bg-amber-400/5 text-amber-400'
          }`}
        >
          <Dot tone={note.tone} />
          <span>{note.text}</span>
        </div>
      ))}
    </div>
  );
}
