import type { InventoryPosition, ShortageForecast } from "./types";

function assertNonNegative(name: string, value: number) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}

export function calculateShortage(position: InventoryPosition): ShortageForecast {
  assertNonNegative("onHand", position.onHand);
  assertNonNegative("confirmedDemand", position.confirmedDemand);
  assertNonNegative("inboundConfirmed", position.inboundConfirmed);
  assertNonNegative("safetyStock", position.safetyStock);

  const projectedAvailable = position.onHand + position.inboundConfirmed;
  const requiredQuantity = Math.max(
    0,
    position.confirmedDemand + position.safetyStock - projectedAvailable,
  );

  return {
    sku: position.sku,
    requiredQuantity,
    projectedAvailable,
    stockoutAt: position.stockoutAt,
    shortageDetected: requiredQuantity > 0,
  };
}
