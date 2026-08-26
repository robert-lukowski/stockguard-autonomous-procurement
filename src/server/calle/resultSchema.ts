export const supplierCallResultSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "supplierId",
    "language",
    "skuConfirmed",
    "availableQuantity",
    "unitPrice",
    "currency",
    "deliveryAt",
    "offerValidUntil",
    "commercialTermsChanged",
    "optOutRequested",
    "notes",
    "fieldEvidence",
  ],
  properties: {
    supplierId: {
      type: "string",
      description: "The approved synthetic supplier identifier supplied in the task.",
    },
    language: {
      type: "string",
      description: "The BCP 47 language used in the conversation.",
    },
    skuConfirmed: {
      type: "boolean",
      description: "True only when the recipient explicitly confirms the requested SKU.",
    },
    availableQuantity: {
      type: "integer",
      description: "The non-negative quantity explicitly confirmed as available.",
    },
    unitPrice: {
      type: "number",
      description: "The non-negative unit price explicitly stated by the recipient.",
    },
    currency: { type: "string", enum: ["EUR", "PLN", "USD", "GBP"] },
    deliveryAt: {
      type: "string",
      description: "The confirmed delivery timestamp in ISO 8601 form.",
    },
    offerValidUntil: {
      type: "string",
      description: "The confirmed quote-valid-until timestamp in ISO 8601 form.",
    },
    commercialTermsChanged: { type: "boolean" },
    optOutRequested: { type: "boolean" },
    notes: { type: "string" },
    fieldEvidence: {
      type: "object",
      additionalProperties: false,
      required: [
        "skuConfirmed",
        "availableQuantity",
        "unitPrice",
        "currency",
        "deliveryAt",
        "offerValidUntil",
        "commercialTermsChanged",
      ],
      // Descriptions ask for the recipient's own statement, not a verbatim
      // transcription. Insisting on exact words forced CALL-E to steer the
      // whole conversation toward literal quotable phrases; a short
      // paraphrase or quote is enough for evidenceAppearsInTranscript to
      // corroborate the field against the transcript.
      properties: {
        skuConfirmed: { type: "string", description: "The recipient's own statement (short paraphrase or quote) confirming the SKU." },
        availableQuantity: { type: "string", description: "The recipient's own statement confirming available quantity." },
        unitPrice: { type: "string", description: "The recipient's own statement confirming the unit price." },
        currency: { type: "string", description: "The recipient's own statement confirming the currency." },
        deliveryAt: { type: "string", description: "The recipient's own statement confirming delivery timing." },
        offerValidUntil: { type: "string", description: "The recipient's own statement confirming quote validity." },
        commercialTermsChanged: { type: "string", description: "The recipient's own statement confirming whether commercial terms changed." },
      },
    },
  },
} as const;
