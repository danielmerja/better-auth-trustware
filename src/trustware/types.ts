/**
 * Types for the parts of the Trustware REST API this plugin uses.
 * Source: https://docs.trustware.io/api-reference/overview
 */

export interface TrustwareQuoteRequest {
  fromChain: string;
  toChain: string;
  fromToken: string;
  toToken: string;
  /** Smallest unit of the source token. */
  fromAmount: string;
  fromAddress: string;
  toAddress: string;
  /** Percentage, default 1. */
  slippage?: number;
}

export interface TrustwareEstimate {
  fromAmount: string;
  toAmount: string;
  /** Minimum the destination receives after slippage. This is what we size invoices against. */
  toAmountMin: string;
  toAmountUsd?: string;
  totalFeesUsd?: string;
}

export interface TrustwareQuote {
  estimate: TrustwareEstimate;
}

export interface TrustwareRouteRequest extends TrustwareQuoteRequest {
  fromAmountUSD?: string;
  /** Echoed back in every status response. */
  metadata?: Record<string, unknown>;
}

export interface TrustwareApproval {
  chainId: string;
  tokenAddress: string;
  spender: string;
  amount: string;
}

export interface TrustwareTransactionRequest {
  to: string;
  data?: string;
  value?: string;
  gasLimit?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  type?: number | string;
  [key: string]: unknown;
}

export interface TrustwareRouteResult {
  intentId: string;
  route: {
    estimate: TrustwareEstimate;
    execution: {
      transaction: TrustwareTransactionRequest;
      /** ERC-20 approvals the payer must submit before the main transaction. */
      approvals?: TrustwareApproval[];
    };
    provider?: string;
    requestId?: string;
    reliabilityScore?: number;
  };
}

export type TrustwareIntentStatus = "pending" | "submitted" | "bridging" | "success" | "failed";

export interface TrustwareStatus {
  intentId: string;
  status: TrustwareIntentStatus;
  sourceTxHash?: string;
  destTxHash?: string;
  fromAddress?: string;
  toAddress?: string;
  fromChainId?: string;
  toChainId?: string;
  /** Destination amount in base units, when Trustware reports it. */
  toAmount?: bigint;
  landedAmountVerified?: boolean;
  provider?: string;
  /** When Trustware suggests polling again. Absent while the intent is still `pending`. */
  nextPollAt?: Date;
  metadata?: Record<string, unknown>;
  raw: unknown;
}

export interface TrustwareToken {
  address: string;
  chainId: string;
  symbol: string;
  name?: string;
  decimals: number;
  usdPrice?: number;
  logoURI?: string;
}

export interface TrustwareValidateResult {
  valid: boolean;
  status?: string;
  message?: string;
  [key: string]: unknown;
}

/**
 * The surface the plugin needs from Trustware. `createTrustwareApi` implements it
 * over HTTP and `createMockTrustware` (from `better-auth-trustware/testing`)
 * implements it in memory, so you can pass either through `trustware` in the
 * plugin options.
 */
export interface TrustwareApi {
  quote(request: TrustwareQuoteRequest): Promise<TrustwareQuote>;
  route(request: TrustwareRouteRequest): Promise<TrustwareRouteResult>;
  receipt(intentId: string, txHash: string): Promise<void>;
  status(intentId: string): Promise<TrustwareStatus>;
  tokens(params: { chainId: string }): Promise<TrustwareToken[]>;
  validate(): Promise<TrustwareValidateResult>;
}

export interface TrustwareProviderOutcome {
  name: string;
  outcome: "declined" | "failed";
  code?: string;
  message?: string;
}
