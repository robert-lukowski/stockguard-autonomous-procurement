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
  ],
  properties: {
    supplierId: { type: "string" },
    language: { type: "string" },
    skuConfirmed: { type: "boolean" },
    availableQuantity: { type: ["integer", "null"], minimum: 0 },
    unitPrice: { type: ["number", "null"], minimum: 0 },
    currency: {
      anyOf: [
        { type: "string", enum: ["EUR", "PLN", "USD", "GBP"] },
        { type: "null" },
      ],
    },
    deliveryAt: {
      anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
    },
    offerValidUntil: {
      anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
    },
    commercialTermsChanged: { type: "boolean" },
    optOutRequested: { type: "boolean" },
    notes: { type: ["string", "null"] },
  },
} as const;
