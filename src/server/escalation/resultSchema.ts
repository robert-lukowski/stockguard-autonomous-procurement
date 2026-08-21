export const managerEscalationResultSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "decision",
    "restrictedActionsRequested",
    "optOutRequested",
    "managerSummary",
    "decisionEvidence",
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
      type: "string",
      description: "Optional ISO 8601 callback time explicitly requested by the manager.",
    },
    restrictedActionsRequested: {
      type: "array",
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
    managerSummary: {
      type: "string",
      description: "Concise summary of the bounded operational response.",
    },
    decisionEvidence: {
      type: "string",
      description: "Exact words spoken by the manager that support the decision enum.",
    },
    preferredContactEvidence: {
      type: "string",
      description: "Exact words supporting preferredContactAt when a callback time was provided.",
    },
  },
} as const;
