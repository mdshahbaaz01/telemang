/**
 * Barrel for centralized Telegram primitives (Phase 2 refactor).
 * New code should import from `@/lib/telegram` instead of scattered helpers.
 */

// Pure, client-safe error classification
export * from "./errors";

// Server-only re-exports (do NOT import this barrel from client code that
// might be reachable at module scope — GramJS client is heavy).
export { createTgClient } from "../telegram-client.server";
export { resolveTargetEntity } from "../telegram-target-resolver.server";
export {
  joinTelegramTargetVerified,
  extractTelegramErrorCode,
} from "../telegram-join-helper.server";