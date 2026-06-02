/**
 * Step gate — buffers UI render callbacks until the user navigates to that step.
 * reach() / setStage() / log() are always immediate; visual renders are gated here.
 *
 * Consumers call:  gateEvent("embed", () => { addEmbedRow(...); });
 * viewState calls: setGateStep("embed") then flushGate("embed") when user advances.
 */

const STEPS = ["chunks", "embed", "store", "query", "retrieve", "fuse", "augment", "answer"];

/** Render-function queues keyed by step name. */
const queues = {};

/** Index of the step the user is currently viewing. */
let _currentIdx = 0;

/** Called by viewState._render() to keep the gate in sync with the current tab. */
export function setGateStep(step) {
  _currentIdx = STEPS.indexOf(step);
  if (_currentIdx < 0) _currentIdx = 0;
}

/**
 * Run fn immediately if targetStep <= current user step; otherwise queue it.
 * This means forward-only buffering: past/current steps render right away.
 */
export function gateEvent(targetStep, fn) {
  const targetIdx = STEPS.indexOf(targetStep);
  if (targetIdx <= _currentIdx) {
    fn();
  } else {
    (queues[targetStep] ??= []).push(fn);
  }
}

/** True if there are buffered render functions waiting for step. */
export function hasPending(step) {
  return (queues[step]?.length ?? 0) > 0;
}

/** Drain all queued render functions for step and discard the queue. */
export function flushGate(step) {
  const pending = queues[step];
  if (!pending || pending.length === 0) return;
  delete queues[step];
  pending.forEach((fn) => fn());
}

/** Full reset — clear all queues and return to step 0. */
export function resetGate() {
  for (const k of Object.keys(queues)) delete queues[k];
  _currentIdx = 0;
}
