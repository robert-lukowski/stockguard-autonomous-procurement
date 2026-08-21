import type {
  PurchaseOrder,
  PurchaseOrderPort,
  PurchaseOrderRequest,
} from "./types";

export class MockPurchaseOrderAdapter implements PurchaseOrderPort {
  readonly createdOrders: PurchaseOrder[] = [];
  private readonly ordersByIdempotencyKey = new Map<string, PurchaseOrder>();

  async createPurchaseOrder(
    request: PurchaseOrderRequest,
  ): Promise<PurchaseOrder> {
    const existing = this.ordersByIdempotencyKey.get(request.idempotencyKey);
    if (existing) return existing;

    const order: PurchaseOrder = {
      ...request,
      purchaseOrderId: `PO-${String(this.createdOrders.length + 1042)}`,
      environment: "synthetic",
      status: "created",
    };

    this.createdOrders.push(order);
    this.ordersByIdempotencyKey.set(request.idempotencyKey, order);
    return order;
  }
}
