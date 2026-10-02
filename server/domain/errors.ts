// Business-rule violations carry a stable code and a Spanish message that the
// UI can show as-is.

export type DomainErrorCode =
  | "validation"
  | "not_found"
  | "invalid_quantity"
  | "invalid_amount"
  | "supplier_unresolved"
  | "material_unresolved"
  | "order_unresolved"
  | "over_delivery"
  | "allocation_exceeds_payment"
  | "allocation_exceeds_order"
  | "unknown_order_value"
  | "duplicate"
  | "conflict"
  | "unsupported_document"
  | "stale_proposal"
  | "persistence";

const STATUS: Partial<Record<DomainErrorCode, number>> = {
  not_found: 404,
  duplicate: 409,
  conflict: 409,
  unsupported_document: 415,
  stale_proposal: 409,
  persistence: 500,
};

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: DomainErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = STATUS[code] ?? 422;
    this.details = details;
  }
}

export function assert(condition: unknown, code: DomainErrorCode, message: string): asserts condition {
  if (!condition) throw new DomainError(code, message);
}
