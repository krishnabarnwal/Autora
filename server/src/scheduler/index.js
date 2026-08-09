/**
 * Phase 12 — Scheduler: the registry of per-agent workers.
 *
 * One CycleWorker per agent, and the scheduler owns their lifecycle:
 *
 *   - register(agentId)   idempotent; one live worker per agent, ever. A second
 *                         register for an already-running agent returns the
 *                         existing worker rather than starting a rival loop.
 *   - resumeAll()         load Agent.findResumable() and register each with an
 *                         increasing boot stagger, so N agents restarting after a
 *                         deploy do not all hit the model in the same instant.
 *   - start()             flip the scheduler live and start every registered
 *                         worker. Until this is called the scheduler is dormant:
 *                         register() records a worker but starts no timer, so
 *                         importing or constructing a scheduler is side-effect
 *                         free (the HTTP tests build the app without ever ticking
 *                         a cycle).
 *   - stopAll()           stop every worker and clear the registry, leaving no
 *                         orphan timer — the graceful-shutdown hook.
 *
 * A module-level accessor (getScheduler/setScheduler) lets the init route reach
 * the running scheduler without app.js knowing it exists: bootstrap installs the
 * scheduler, the route calls getScheduler()?.register(...). In tests bootstrap
 * never runs, so the accessor stays null and register is a no-op — the existing
 * route suites keep passing with no worker and no timer.
 *
 * Every collaborator is injectable (the worker factory, the resumable query, the
 * clock the workers use), so the whole lifecycle is testable on a fake clock with
 * no database and no real timers.
 */
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { Agent } from '../models/index.js';
import { CycleWorker } from './worker.js';

const log = logger('SCHEDULER');

/**
 * Delay between successive agents' first cycles at boot. Small enough to be
 * invisible against either cadence (45s demo / 6h production) yet enough that a
 * fleet resuming after a restart spreads its opening LLM calls instead of
 * stampeding the provider.
 */
export const DEFAULT_BOOT_STAGGER_MS = 2_000;

/**
 * A fleet of per-agent workers. Construct one (bootstrap does), resumeAll() to
 * pick up existing agents, register() new ones as they are created, stopAll() on
 * shutdown.
 */
export class Scheduler {
  /**
   * @param {{
   *   createWorker?: (agentId: string, opts: object) => object,
   *   findResumable?: () => Promise<Array<object|string>>,
   *   provider?: object,
   *   bootStaggerMs?: number,
   *   workerOptions?: object,
   *   logger?: object,
   * }} [options] `workerOptions` is spread into every worker (the clock seams and
   *   cadence overrides a test injects); `createWorker`/`findResumable` default to
   *   the real CycleWorker and Agent.findResumable().
   */
  constructor(options = {}) {
    const {
      createWorker = (agentId, opts) => new CycleWorker(agentId, opts),
      findResumable = () => Agent.findResumable(),
      provider,
      bootStaggerMs = DEFAULT_BOOT_STAGGER_MS,
      workerOptions = {},
      logger: injectedLog = log,
    } = options;

    this.createWorker = createWorker;
    this.findResumableFn = findResumable;
    this.provider = provider;
    this.bootStaggerMs = Math.max(0, Number.isFinite(bootStaggerMs) ? bootStaggerMs : DEFAULT_BOOT_STAGGER_MS);
    this.workerOptions = workerOptions;
    this.log = injectedLog;

    /** @type {Map<string, object>} agentId -> worker */
    this.workers = new Map();
    this.started = false;
  }

  /** Number of registered workers (live or dormant). */
  get size() {
    return this.workers.size;
  }

  /** True when the agent has a worker that has not stopped itself. */
  has(agentId) {
    const worker = this.workers.get(agentId);
    return Boolean(worker && !worker.stopped);
  }

  /**
   * Ensure exactly one worker exists for an agent. Idempotent: a live worker is
   * returned untouched (never a second loop). A missing or self-stopped worker is
   * (re)created; it is started immediately only if the scheduler is already live,
   * which is how a freshly-created agent gets its immediate first cycle. Before
   * start(), registration only records the worker — dormant, no timer.
   *
   * @returns {object|null} the worker, or null for a missing agentId.
   */
  register(agentId, { bootDelayMs = 0 } = {}) {
    if (!agentId) return null;

    const existing = this.workers.get(agentId);
    if (existing && !existing.stopped) return existing;

    const worker = this.createWorker(agentId, {
      provider: this.provider,
      bootDelayMs,
      logger: this.log,
      ...this.workerOptions,
    });
    this.workers.set(agentId, worker);

    if (this.started) {
      worker.start();
      this.log.info('Registered and started a worker', { agentId, bootDelayMs });
    } else {
      this.log.debug('Registered a dormant worker (scheduler not started)', { agentId });
    }
    return worker;
  }

  /**
   * Register every resumable agent with a staggered first cycle, then start the
   * fleet. A failure to load the agents is logged, not thrown: the server still
   * comes up, just with an empty scheduler that new inits can populate.
   *
   * @returns {Promise<number>} how many workers are registered afterwards.
   */
  async resumeAll() {
    let agents;
    try {
      agents = await this.findResumableFn();
    } catch (err) {
      this.log.error('Could not load resumable agents; the scheduler starts empty', {
        code: err?.code, name: err?.name,
      });
      agents = [];
    }

    let i = 0;
    for (const agent of agents ?? []) {
      const agentId = typeof agent === 'string' ? agent : agent?.agentId;
      if (!agentId) continue;
      this.register(agentId, { bootDelayMs: i * this.bootStaggerMs });
      i += 1;
    }

    this.start();
    this.log.info('Scheduler resumed agents', { count: this.workers.size, staggerMs: this.bootStaggerMs });
    return this.workers.size;
  }

  /** Go live and start every registered worker that is not already running. */
  start() {
    this.started = true;
    for (const worker of this.workers.values()) {
      if (worker.stopped) worker.start();
    }
    return this;
  }

  /**
   * Stop every worker, cancelling its pending tick, and empty the registry. Safe
   * to call more than once. After this the scheduler is dormant again.
   */
  stopAll() {
    for (const worker of this.workers.values()) {
      try {
        worker.stop();
      } catch (err) {
        this.log.warn('A worker threw on stop; continuing shutdown', { code: err?.code });
      }
    }
    const stopped = this.workers.size;
    this.workers.clear();
    this.started = false;
    this.log.info('Scheduler stopped all workers', { stopped });
    return this;
  }
}

/**
 * The process-wide scheduler, installed by bootstrap and read by the init route.
 * Null until bootstrap runs, so any code path that never boots the server (every
 * HTTP/unit test) sees no scheduler and starts no timer.
 */
let activeScheduler = null;

/** Install (or clear, with null) the process-wide scheduler. */
export function setScheduler(scheduler) {
  activeScheduler = scheduler;
  return scheduler;
}

/** The installed scheduler, or null when the server was not bootstrapped. */
export function getScheduler() {
  return activeScheduler;
}
