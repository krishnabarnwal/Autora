import { useEffect, useState } from 'react';

/**
 * A 1 Hz clock, for counting down to a timestamp the backend already gave us.
 *
 * Deliberately separate from usePolling: this fires no request. The next-cycle
 * countdown has to tick every second to read as live, but the value it counts
 * toward (agent.nextCycleAt) still refreshes on the normal 5s poll. Ticking
 * locally means a smooth countdown without touching the polling behaviour.
 *
 * The interval is only installed while `enabled` is true, so a dashboard with
 * no scheduled cycle runs no timer at all.
 */
export function useNow(enabled = true) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  return now;
}

/**
 * Split the gap to an ISO timestamp into clock parts.
 *
 * Returns null when there is no timestamp to count toward — the caller renders
 * nothing rather than a zeroed clock, because "00:00:00" would read as a
 * cycle firing right now when in fact the backend reported no next cycle.
 */
export function countdownTo(iso, now) {
  if (!iso) return null;
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return null;

  const remainingMs = target - now;
  const overdue = remainingMs <= 0;
  const total = Math.max(0, Math.floor(remainingMs / 1000));

  return {
    overdue,
    hours: String(Math.floor(total / 3600)).padStart(2, '0'),
    minutes: String(Math.floor((total % 3600) / 60)).padStart(2, '0'),
    seconds: String(total % 60).padStart(2, '0'),
  };
}
