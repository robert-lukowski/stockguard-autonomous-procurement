export const managerEscalationResultSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "decision",
    "preferredContactAt",
    "restrictedActionsRequested",
    "optOutRequested",
    "summary",
  ],
  properties: {
    decision: {
      type: "string",
      enum: [
        "ACKNOWLEDGE_AND_START_HUMAN_SOURCING",
        "RETRY_APPROVED_SUPPLIERS_LATER",
        "REQUEST_WRITTEN_REPORT",
        "DECLINE_ESCALATION",
        "REQUIRES_AUTHENTICATED_HUMAN_APPROVAL",
      ],
    },
    preferredContactAt: {
      anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
    },
    restrictedActionsRequested: {
      type: "array",
      uniqueItems: true,
      items: {
        type: "string",
        enum: [
          "INCREASE_BUDGET",
          "CHANGE_PROCUREMENT_POLICY",
          "APPROVE_UNKNOWN_SUPPLIER",
          "ACCEPT_CHANGED_LEGAL_TERMS",
          "CREATE_REAL_ORDER",
        ],
      },
    },
    optOutRequested: { type: "boolean" },
    summary: { type: ["string", "null"] },
  },
} as const;
