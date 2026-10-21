import type { BetterAuthClientPlugin } from "better-auth/client";
import { TRUSTWARE_ERROR_CODES } from "./error-codes";
import type { trustware } from "./index";
import type { TrustwarePlan, TrustwareSettlement } from "./types";
import { PACKAGE_VERSION } from "./version";

export const trustwareClient = <O extends { subscription?: boolean }>(options?: O) => {
  return {
    id: "trustware-client",
    version: PACKAGE_VERSION,
    $InferServerPlugin: {} as ReturnType<
      typeof trustware<
        O["subscription"] extends true
          ? {
              settlement: TrustwareSettlement;
              trustware: any;
              subscription: { enabled: true; plans: TrustwarePlan[] };
            }
          : { settlement: TrustwareSettlement; trustware: any }
      >
    >,
    // Calls with an all-optional body would otherwise be sent as GET.
    pathMethods: {
      "/trustware/checkout": "POST",
      "/trustware/subscription/change": "POST",
      "/trustware/subscription/cancel": "POST",
      "/trustware/subscription/restore": "POST",
      "/trustware/invoice/pay": "POST",
      "/trustware/payment/receipt": "POST",
      "/trustware/reconcile": "POST",
    },
    $ERROR_CODES: TRUSTWARE_ERROR_CODES,
  } satisfies BetterAuthClientPlugin;
};

export { TRUSTWARE_ERROR_CODES } from "./error-codes";

/** The minimal slice of the auth client `waitForInvoice` needs. */
export interface InvoiceStatusClient {
  trustware: {
    invoice: {
      status: (args: { query: { id: string } }) => Promise<{ data: any; error: any }>;
    };
  };
}

export interface WaitForInvoiceOptions {
  /** Poll interval in ms. Default 4000. */
  intervalMs?: number;
  /** Give up after this long. Default 15 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (invoice: any) => void;
}

/**
 * Poll an invoice until it is paid, expired or voided, so a checkout page can
 * react once Trustware settles the payment. Resolves with the final invoice.
 */
export async function waitForInvoice(
  client: InvoiceStatusClient,
  invoiceId: string,
  options: WaitForInvoiceOptions = {},
): Promise<any> {
  const interval = options.intervalMs ?? 4_000;
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000);

  for (;;) {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const { data, error } = await client.trustware.invoice.status({ query: { id: invoiceId } });
    if (error) throw new Error(error.message ?? "Failed to read invoice status");
    options.onUpdate?.(data);
    if (data.status !== "open") return data;
    if (Date.now() + interval > deadline) throw new Error("Timed out waiting for the invoice to settle");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, interval);
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }
}
