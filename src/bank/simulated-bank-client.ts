import { createHash } from "node:crypto";

import type {
  BankClient,
  BankPaymentRequest,
  BankPaymentResult,
} from "./bank-client.js";

function simulatedExecutionId(executionKey: string): string {
  const digest = createHash("sha256").update(executionKey).digest("hex").slice(0, 24);
  return `SIM-${digest}`;
}

export class SimulatedBankClient implements BankClient {
  async executePayment(request: BankPaymentRequest): Promise<BankPaymentResult> {
    const reference = request.reference.toUpperCase();

    if (reference.includes("TEMP_FAIL")) {
      return {
        outcome: "TEMPORARY_FAILURE",
        code: "BANK_TEMPORARY_UNAVAILABLE",
        message: "The simulated bank is temporarily unavailable",
      };
    }

    if (reference.includes("PERM_FAIL")) {
      return {
        outcome: "PERMANENT_FAILURE",
        code: "BANK_PAYMENT_REJECTED",
        message: "The simulated bank permanently rejected the payment",
      };
    }

    return {
      outcome: "SUCCESS",
      bankExecutionId: simulatedExecutionId(request.executionKey),
    };
  }
}
