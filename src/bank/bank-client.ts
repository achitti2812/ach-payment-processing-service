export interface BankPaymentRequest {
  paymentId: string;
  sourceAccount: string;
  destinationAccount: string;
  amount: string;
  reference: string;
  executionKey: string;
  attemptNumber: number;
}

export type BankPaymentResult =
  | {
      outcome: "SUCCESS";
      bankExecutionId?: string;
    }
  | {
      outcome: "PERMANENT_FAILURE";
      code: string;
      message: string;
    }
  | {
      outcome: "TEMPORARY_FAILURE";
      code: string;
      message: string;
    };

export interface BankClient {
  executePayment(request: BankPaymentRequest): Promise<BankPaymentResult>;
}
