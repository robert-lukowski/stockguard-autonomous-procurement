import type {
  PurchaseOrder,
  PurchaseOrderPort,
  PurchaseOrderRequest,
} from "./types";

export class MockPurchaseOrderAdapter implements PurchaseOrderPort {
  readonly createdOrders: PurchaseOrder[] = [];

  async createPurchaseOrder(
    request: PurchaseOrderRequest,
  ): Promise<PurchaseOrder> {
    const order: PurchaseOrder = {
      ...request,
      purchaseOrderId: `PO-${String(this.createdOrders.length + 1042)}`,
      environment: "synthetic",
      status: "created",
    };

    this.createdOrders.push(order);
    return order;
  }
}
