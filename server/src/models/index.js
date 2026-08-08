import { Agent, AGENT_STATUS, personaKeyFor } from './Agent.js';
import { Post } from './Post.js';
import { TopicMemory, TOPIC_DECISIONS, REJECTION_REASONS } from './TopicMemory.js';
import { logger } from '../utils/logger.js';

const log = logger('DB');

export {
  Agent,
  Post,
  TopicMemory,
  AGENT_STATUS,
  TOPIC_DECISIONS,
  REJECTION_REASONS,
  personaKeyFor,
};

/**
 * Build declared indexes before serving traffic.
 *
 * Mongoose autoIndex would do this lazily and swallow failures; doing it here
 * means a broken index (for example a unique constraint that existing data
 * violates) surfaces at startup instead of mid-cycle.
 */
export async function syncIndexes() {
  const models = [Agent, Post, TopicMemory];
  const created = [];
  for (const Model of models) {
    try {
      await Model.syncIndexes();
      const indexes = await Model.collection.indexes();
      created.push(`${Model.modelName}(${indexes.length})`);
    } catch (err) {
      log.error(`Index sync failed for ${Model.modelName}`, { message: err.message });
      throw err;
    }
  }
  log.info('Indexes ready', { models: created.join(' ') });
  return created;
}
