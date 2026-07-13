export function validateThreadProvenance(options: {
  parentThreadId?: string;
  lastTurnId?: string;
  parentLabel?: string;
  lastTurnLabel?: string;
}): void {
  const parentLabel = options.parentLabel ?? "parentThreadId";
  const lastTurnLabel = options.lastTurnLabel ?? "lastTurnId";
  if (options.parentThreadId !== undefined && options.parentThreadId.trim().length === 0) {
    throw new Error(`${parentLabel} must be a non-empty string.`);
  }
  if (options.lastTurnId !== undefined && options.lastTurnId.trim().length === 0) {
    throw new Error(`${lastTurnLabel} must be a non-empty string.`);
  }
  if (options.lastTurnId !== undefined && options.parentThreadId === undefined) {
    throw new Error(`${lastTurnLabel} requires ${parentLabel}; Counterlane will not apply a turn id to a fresh thread.`);
  }
}
