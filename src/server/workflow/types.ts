import type {
  ExchangeRatesToEur,
  InventoryPosition,
  ProcurementDecision,
  ProcurementPolicy,
} from "../../domain";
import type {
  CallAuthorization,
  SupplierCallRequest,
  SupportedCallLocale,
  SupportedCallRegion,
} from "../calle";
import type { SignedDecisionProof } from "../../security";
import type { WorkflowState, WorkflowStateEvent } from "./stateMachine";

export type SupplierContact = {
  supplierId: string;
  supplierName: string;
  phoneE164: string;
  region: SupportedCallRegion;
  locale: SupportedCallLocale;
  approved: boolean;
  consentVerified: boolean;
};

export type WorkflowInput = {
  workflowId: string;
  inventory: InventoryPosition;
  suppliers: SupplierContact[];
  callAuthorization: CallAuthorization;
  procurementPolicy: ProcurementPolicy;
  exchangeRates: ExchangeRatesToEur;
  autonomousExecutionEnabled: boolean;
};

export type AuditEvent = {
  sequence: number;
  type:
    | "WORKFLOW_STARTED"
    | "WORKFLOW_BLOCKED"
    | "SHORTAGE_CALCULATED"
    | "CALL_COMPLETED"
    | "CALL_RETRY_SCHEDULED"
    | "CALL_TIMEOUT"
    | "OFFER_REJECTED"
    | "OFFER_SELECTED"
    | "POLICY_PASSED"
    | "PURCHASE_ORDER_CREATED"
    | "HUMAN_EXCEPTION_REQUIRED"
    | "NO_ACTION_REQUIRED"
    | "DUPLICATE_RUN_BLOCKED"
    | "WORKFLOW_CANCELLED"
    | "WORKFLOW_FAILED";
  at: string;
  summary: string;
  evidence: Record<string, string | number | boolean | null>;
};

export type PurchaseOrderRequest = {
  idempotencyKey: string;
  workflowId: string;
  supplierId: string;
  supplierName: string;
  sku: string;
  quantity: number;
  unitPriceEur: number;
  totalPriceEur: number;
  deliveryAt: string;
  policyVersion: string;
};

export type PurchaseOrder = PurchaseOrderRequest & {
  purchaseOrderId: string;
  environment: "synthetic";
  status: "created";
};

export interface PurchaseOrderPort {
  createPurchaseOrder(request: PurchaseOrderRequest): Promise<PurchaseOrder>;
}

export type DecisionProof = {
  workflowId: string;
  policyVersion: string;
  selectedSupplierId: string;
  selectedOfferId: string;
  passedChecks: string[];
  rejectedSupplierIds: string[];
  orderValueEur: number;
  explanation: string;
  ruleTrace: Array<{
    supplierId: string;
    checks: Array<{
      id: string;
      status: "PASS" | "FAIL" | "REQUIRES_HUMAN";
      evidence: string;
      inputs: Record<string, string | number | boolean | null>;
    }>;
  }>;
};

export type WorkflowResult = {
  workflowId: string;
  status:
    | "ORDER_CREATED"
    | "HUMAN_EXCEPTION_REQUIRED"
    | "NO_ACTION_REQUIRED"
    | "EXECUTION_BLOCKED"
    | "FAILED";
  decision: ProcurementDecision | null;
  purchaseOrder: PurchaseOrder | null;
  proof: DecisionProof | null;
  auditTimeline: AuditEvent[];
  signedProof?: SignedDecisionProof;
  workflowState: WorkflowState;
  stateHistory: WorkflowStateEvent[];
};

export function toSupplierCallRequest(
  input: WorkflowInput,
  supplier: SupplierContact,
  requiredQuantity: number,
): SupplierCallRequest {
  return {
    workflowId: input.workflowId,
    attemptNumber: 1,
    supplierId: supplier.supplierId,
    supplierName: supplier.supplierName,
    phoneE164: supplier.phoneE164,
    region: supplier.region,
    locale: supplier.locale,
    sku: input.inventory.sku,
    requestedQuantity: requiredQuantity,
    requiredBy: input.inventory.stockoutAt,
    consentVerified: supplier.consentVerified,
  };
}
