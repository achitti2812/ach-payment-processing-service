import { PaymentStatus } from "../generated/prisma/enums.js";

import { InvalidPaymentStateTransitionError } from "./errors.js";

const allowedTransitions: Record<PaymentStatus, readonly PaymentStatus[]> = {
  [PaymentStatus.PENDING]: [PaymentStatus.PROCESSING],
  [PaymentStatus.PROCESSING]: [
    PaymentStatus.COMPLETED,
    PaymentStatus.FAILED,
    PaymentStatus.RETRYING,
  ],
  [PaymentStatus.COMPLETED]: [],
  [PaymentStatus.FAILED]: [],
  [PaymentStatus.RETRYING]: [PaymentStatus.PROCESSING],
};

export function isPaymentTransitionAllowed(
  from: PaymentStatus,
  to: PaymentStatus,
): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!isPaymentTransitionAllowed(from, to)) {
    throw new InvalidPaymentStateTransitionError(from, to);
  }
}
