/**
 * The words Autora uses about itself, in one place.
 *
 * The product name, its tagline, and the loop were each being stated several
 * different ways across the UI — three spellings of the name, four phrasings of
 * the loop. That is the kind of drift a reader notices and a maintainer dreads,
 * so this module is the single source every surface imports from.
 *
 * There are two granularities here on purpose, and they are not the same list:
 *
 *   LOOP_STEPS  — the seven-word *product* creed a visitor reads on the Overview.
 *                 It answers "what does this thing do?" in one glance.
 *   CYCLE_STAGES — the eight-stage *engineering* trace in lib/cycles.js, which the
 *                 detail drawer renders stage by stage from the backend's own log.
 *
 * The creed is a summary of the trace, not a rival to it. The map below records
 * exactly how the two line up so neither has to guess about the other: the trace
 * splits discovery into three observable stages (discover / filter / select) that
 * the creed rolls into one word, "Create" is the friendly name for the "generate"
 * stage, and "Repeat" is the loop closing — the scheduler sleeping and waking —
 * which has no stage of its own because nothing is logged for it.
 */

/** The product, named once. */
export const PRODUCT_NAME = 'Autora';

/** What it is, in three words. Used as the h1 across the shell. */
export const PRODUCT_TAGLINE = 'Autonomous AI Creator';

/**
 * The loop as a visitor reads it: seven steps, the agent's own order of
 * operations, ending on the step that makes it a loop rather than a script.
 */
export const LOOP_STEPS = Object.freeze([
  'Discover',
  'Decide',
  'Create',
  'Publish',
  'Remember',
  'Reflect',
  'Repeat',
]);

/** One sentence, for the "How Autora works" panel and hero subtitles. */
export const LOOP_TAGLINE =
  'Autora runs a closed loop on its own schedule — no human prompts it between cycles.';

/**
 * How each product step maps onto the eight-stage engineering trace
 * (CYCLE_STAGES in lib/cycles.js). Documented rather than enforced: the trace is
 * driven by the backend's log tags and must not be reshaped to fit the creed.
 *
 * A step whose value is a list covers several trace stages; `null` marks the
 * loop-closure step that has no stage because nothing is logged for it.
 */
export const STEP_TO_STAGES = Object.freeze({
  Discover: ['discover', 'filter', 'select'],
  Decide: ['decide'],
  Create: ['generate'],
  Publish: ['publish'],
  Remember: ['remember'],
  Reflect: ['reflect'],
  Repeat: null,
});

/** The loop as a single readable line: "Discover → Decide → … → Repeat". */
export const LOOP_LINE = LOOP_STEPS.join(' → ');

/**
 * The engineering trace as a one-line subtitle, stated once so the Overview's
 * "Autonomous loop" panel and the dedicated Autonomous-loop section read
 * identically. The stage words match the labels in lib/pipeline.js — "Live
 * sources", "Local memory", "Strategic memory" — rather than paraphrasing them.
 */
export const PIPELINE_SUBTITLE =
  'Live sources → discovery → filtering → dedup → candidates → editorial → generation → publishing → local memory → strategic memory → next cycle';
