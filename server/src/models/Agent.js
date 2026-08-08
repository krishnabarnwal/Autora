import mongoose from 'mongoose';
import { newAgentId } from '../utils/ids.js';
import { normalizeText } from '../utils/text.js';
import { config } from '../config/env.js';

const { Schema, model } = mongoose;

export const AGENT_STATUS = ['initializing', 'autonomous', 'paused', 'error'];

/**
 * Persona supplied through POST /api/agent/init.
 *
 * name and domain are the contract; the editorial fields are optional so a
 * caller can send only { name, domain } while a richer persona (like Sentinel)
 * can carry its voice and standards.
 */
const personaSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    domain: { type: String, required: true, trim: true, maxlength: 120 },
    identity: { type: String, trim: true, maxlength: 1000, default: '' },
    voice: { type: String, trim: true, maxlength: 500, default: '' },
    interests: { type: [String], default: [] },
    editorialStandards: { type: [String], default: [] },
  },
  { _id: false }
);

/** Counters the dashboard reads directly, avoiding aggregation on every poll. */
const statsSchema = new Schema(
  {
    cyclesRun: { type: Number, default: 0, min: 0 },
    cyclesFailed: { type: Number, default: 0, min: 0 },
    topicsDiscovered: { type: Number, default: 0, min: 0 },
    topicsAfterFilter: { type: Number, default: 0, min: 0 },
    topicsRejected: { type: Number, default: 0, min: 0 },
    topicsSelected: { type: Number, default: 0, min: 0 },
    postsPublished: { type: Number, default: 0, min: 0 },
    llmCalls: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const agentSchema = new Schema(
  {
    agentId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      default: newAgentId,
    },
    persona: { type: personaSchema, required: true },
    /**
     * Normalized "name::domain", kept unique so POST /api/agent/init is
     * idempotent: re-initializing the same persona returns the existing agent
     * instead of creating a rival agent that would publish a second feed.
     * Derived automatically; callers never set it.
     */
    personaKey: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: AGENT_STATUS, default: 'initializing', index: true },

    configuration: {
      // Persisted so a restart resumes the agent on the cadence it was created
      // with, rather than whatever the current env happens to say.
      mode: {
        type: String,
        enum: ['demo', 'production'],
        required: true,
        default: () => config.agent.mode,
      },
      cycleIntervalMs: {
        type: Number,
        required: true,
        min: 5_000,
        default: () => config.agent.cycleIntervalMs,
      },
      maxCandidatesPerCycle: { type: Number, default: 5, min: 1, max: 20 },
      minPublishScore: { type: Number, default: 65, min: 0, max: 100 },
    },

    lastCycleAt: { type: Date, default: null },
    nextCycleAt: { type: Date, default: null },
    lastError: {
      message: { type: String, default: null },
      at: { type: Date, default: null },
    },

    stats: { type: statsSchema, default: () => ({}) },
  },
  {
    timestamps: true, // createdAt / updatedAt
    versionKey: false,
  }
);

/**
 * Stable identity key for a persona. Case, punctuation, and spacing differences
 * ("AI Security" vs "ai  security") must not create a duplicate agent.
 */
export function personaKeyFor(name = '', domain = '') {
  return `${normalizeText(name)}::${normalizeText(domain)}`;
}

/** Keep personaKey in sync so no caller can forget to set it. */
agentSchema.pre('validate', function derivePersonaKey() {
  if (this.persona?.name && this.persona?.domain) {
    this.personaKey = personaKeyFor(this.persona.name, this.persona.domain);
  }
});

/** Shape returned to clients: no _id, ISO timestamps. */
agentSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    agentId: this.agentId,
    persona: {
      name: this.persona.name,
      domain: this.persona.domain,
      identity: this.persona.identity || undefined,
    },
    status: this.status,
    mode: this.configuration.mode,
    cycleIntervalMs: this.configuration.cycleIntervalMs,
    createdAt: this.createdAt.toISOString(),
    updatedAt: this.updatedAt.toISOString(),
    lastCycleAt: this.lastCycleAt ? this.lastCycleAt.toISOString() : null,
    nextCycleAt: this.nextCycleAt ? this.nextCycleAt.toISOString() : null,
    stats: this.stats.toObject ? this.stats.toObject() : this.stats,
  };
};

/** Agents the scheduler should resume after a restart. */
agentSchema.statics.findResumable = function findResumable() {
  return this.find({ status: { $in: ['autonomous', 'initializing', 'error'] } }).sort({ createdAt: 1 });
};

export const Agent = model('Agent', agentSchema);
