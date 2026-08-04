import { randomUUID } from "node:crypto";

const JOURNEY_ID = /^journey_[0-9a-f-]{36}$/;

// Instructional only. Production products should use durable, account-scoped state.
export function createJourneyRegistry() {
  const owners = new Map();
  const idempotentCreatesByAccount = new Map();

  return {
    create(accountId, idempotencyKey) {
      if (typeof accountId !== "string" || accountId.length === 0) return undefined;
      const dedupKey = typeof idempotencyKey === "string" && idempotencyKey.length > 0
        ? idempotencyKey
        : undefined;
      const accountCreates = dedupKey
        ? (idempotentCreatesByAccount.get(accountId) ?? new Map())
        : undefined;
      const existing = dedupKey ? accountCreates.get(dedupKey) : undefined;
      if (existing) return existing;
      const journeyId = `journey_${randomUUID()}`;
      owners.set(journeyId, accountId);
      if (dedupKey) {
        accountCreates.set(dedupKey, journeyId);
        idempotentCreatesByAccount.set(accountId, accountCreates);
      }
      return journeyId;
    },
    resolve(accountId, candidate) {
      if (
        typeof accountId !== "string" ||
        typeof candidate !== "string" ||
        !JOURNEY_ID.test(candidate)
      ) {
        return undefined;
      }
      return owners.get(candidate) === accountId ? candidate : undefined;
    },
  };
}

export function verifiedAccountId(context) {
  const accountId = context.http?.authInfo?.extra?.accountId;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
}

export function resolveJourney(registry, arguments_, context, result) {
  const accountId = verifiedAccountId(context);
  const candidate = result?.structuredContent?.journeyId ?? arguments_?.journeyId;
  return registry.resolve(accountId, candidate);
}
