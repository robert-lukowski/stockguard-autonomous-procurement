import type { JudgeMission } from "./types";

/**
 * Judge missions.
 *
 * A mission is the whole brief the judge needs: what to ask for, how many, how
 * much may be spent and by when. It exists so the judge never has to memorize
 * a SKU, learn a script, or know anything about the implementation — they read
 * a card and speak normally.
 *
 * The mission is also a server-side bound. Its budget, delivery window and
 * allowed categories are re-checked inside the tool boundary on every
 * state-changing call, so a conversational layer cannot widen them by claiming
 * the judge agreed to something larger.
 */
export const judgeMissions: JudgeMission[] = [
  {
    missionId: "MISSION-SSD-20",
    title: "Replenish industrial SSD stock",
    productLabel: "Industrial SSD",
    allowedCategories: ["STORAGE", "NETWORKING", "COMPUTE", "POWER"],
    requestedQuantity: 20,
    maximumBudget: 2500,
    budgetCurrency: "USD",
    requiredDeliveryDays: 7,
    exampleUtterance: "I need twenty industrial SSD drives within a week.",
  },
  {
    missionId: "MISSION-NIC-12",
    title: "Replace failed network adapters",
    productLabel: "10GbE Network Adapter",
    allowedCategories: ["STORAGE", "NETWORKING", "COMPUTE", "POWER"],
    requestedQuantity: 12,
    maximumBudget: 4000,
    budgetCurrency: "USD",
    requiredDeliveryDays: 10,
    exampleUtterance: "We need twelve network adapters within ten days.",
  },
  {
    missionId: "MISSION-UPS-4",
    title: "Add rack UPS capacity",
    productLabel: "3kVA Rack UPS",
    allowedCategories: ["STORAGE", "NETWORKING", "COMPUTE", "POWER"],
    requestedQuantity: 4,
    maximumBudget: 9000,
    budgetCurrency: "USD",
    requiredDeliveryDays: 5,
    exampleUtterance: "I need four rack UPS units within five days.",
  },
];

export const defaultMission = judgeMissions[0];

export function findMission(missionId: string): JudgeMission | null {
  return judgeMissions.find((mission) => mission.missionId === missionId) ?? null;
}
