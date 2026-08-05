import { randomUUID } from "node:crypto";

import type {
  AgentFeedbackRuntime,
  ConsentState,
  PreparedInteraction,
  ProductSurface,
} from "./core.js";
import { customerContextInteractionId } from "./customer.js";

export type OperationFacts = Readonly<{
  interactionId: string;
  surface: ProductSurface;
  operation: string;
  statusCode: number;
  durationMs: number;
}>;

type OperationState = {
  interactionId?: string;
  facts?: OperationFacts;
  active: number;
};

const operations = new WeakMap<object, OperationState>();
const sharedPreparers = new WeakMap<
  object,
  (
    input: Date | { now?: Date; customerRef?: string; consentState?: ConsentState },
    interactionId: string,
  ) => PreparedInteraction
>();

export function registerSharedPreparer<Request>(
  runtime: AgentFeedbackRuntime<Request>,
  prepare: (
    input: Date | { now?: Date; customerRef?: string; consentState?: ConsentState },
    interactionId: string,
  ) => PreparedInteraction,
): void {
  sharedPreparers.set(runtime, prepare);
}

export function prepareSharedInteraction<Request>(
  runtime: AgentFeedbackRuntime<Request>,
  input: Date | { now?: Date; customerRef?: string; consentState?: ConsentState },
  interactionId: string,
): PreparedInteraction {
  const prepare = sharedPreparers.get(runtime);
  if (!prepare) throw new Error("Agent Feedback runtime is not registered");
  return prepare(input, interactionId);
}

/** Internal, request-owned operation identity. Never export this module publicly. */
export function operationState(owner: object, continuation?: unknown): OperationState {
  let state = operations.get(owner);
  if (!state) {
    state = {
      interactionId: customerContextInteractionId(continuation),
      active: 0,
    };
    operations.set(owner, state);
  }
  return state;
}

export function interactionId(owner: object, continuation?: unknown): string {
  const state = operationState(owner, continuation);
  if (!state.interactionId) state.interactionId = randomUUID();
  return state.interactionId;
}

export function beginOperation(owner: object): void {
  operationState(owner).active += 1;
}

export function endOperation(owner: object): void {
  const state = operations.get(owner);
  if (!state || state.active === 0) return;
  state.active -= 1;
  if (state.active === 0 && state.facts) operations.delete(owner);
}

export function completeOperation(
  owner: object,
  completion: Omit<OperationFacts, "interactionId">,
): { facts: OperationFacts; conflict: boolean } {
  const state = operationState(owner);
  if (!state.facts) {
    state.facts = Object.freeze({ interactionId: interactionId(owner), ...completion });
    return { facts: state.facts, conflict: false };
  }
  const conflict =
    state.facts.surface !== completion.surface ||
    state.facts.operation !== completion.operation ||
    state.facts.statusCode !== completion.statusCode;
  return { facts: state.facts, conflict };
}
