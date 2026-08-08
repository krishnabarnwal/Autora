import { randomUUID, randomBytes } from 'node:crypto';

/**
 * Public identifiers. These appear in the API contract, so they use readable
 * prefixes rather than raw Mongo ObjectIds.
 */

/** Agent id, e.g. "agt_3f9a1c7b8e2d4a06". */
export function newAgentId() {
  return `agt_${randomBytes(8).toString('hex')}`;
}

/** Post id, e.g. "p_5c1d0a9f4b3e". Guaranteed unique per post. */
export function newPostId() {
  return `p_${randomBytes(6).toString('hex')}`;
}

/** Correlation id for one autonomous cycle, used to group activity logs. */
export function newCycleId() {
  return randomUUID();
}
