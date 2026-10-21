import type { BetterAuthPlugin } from "better-auth";
import { createBilling } from "./core/billing";
import { TRUSTWARE_ERROR_CODES } from "./error-codes";
import { getAccess, checkAccess, getBillingOverview, listPlans } from "./routes/access";
import { reconcileHttp, reconcileServer } from "./routes/admin";
import {
  getInvoice,
  getInvoiceStatus,
  listInvoices,
  payInvoice,
  submitPaymentReceipt,
} from "./routes/invoices";
import {
  cancelSubscriptionEndpoint,
  changeSubscriptionEndpoint,
  checkout,
  listSubscriptions,
  restoreSubscriptionEndpoint,
} from "./routes/subscriptions";
import { getSchema } from "./schema";
import type { TrustwareOptions } from "./types";
import { PACKAGE_VERSION } from "./version";

declare module "@better-auth/core" {
  interface BetterAuthPluginRegistry<AuthOptions, Options> {
    trustware: {
      creator: typeof trustware;
    };
  }
}

export const trustware = <O extends TrustwareOptions>(options: O) => {
  const billing = createBilling(options);

  const subscriptionEndpoints = {
    trustwareChangeSubscription: changeSubscriptionEndpoint(billing),
    trustwareCancelSubscription: cancelSubscriptionEndpoint(billing),
    trustwareRestoreSubscription: restoreSubscriptionEndpoint(billing),
    trustwareListSubscriptions: listSubscriptions(billing),
  };

  const coreEndpoints = {
    trustwareListPlans: listPlans(billing),
    trustwareCheckout: checkout(billing),
    trustwareGetAccess: getAccess(billing),
    trustwareCheckAccess: checkAccess(billing),
    trustwareBillingOverview: getBillingOverview(billing),
    trustwareListInvoices: listInvoices(billing),
    trustwareGetInvoice: getInvoice(billing),
    trustwarePayInvoice: payInvoice(billing),
    trustwareSubmitReceipt: submitPaymentReceipt(billing),
    trustwareInvoiceStatus: getInvoiceStatus(billing),
    trustwareReconcile: reconcileServer(billing),
    trustwareReconcileHttp: reconcileHttp(billing),
  };
  const allEndpoints = { ...coreEndpoints, ...subscriptionEndpoints };

  return {
    id: "trustware",
    version: PACKAGE_VERSION,
    // Typed as always present so `auth.api.trustwareCancelSubscription` isn't "possibly undefined"
    // for apps that enable subscriptions. When they're disabled the endpoints simply aren't registered.
    endpoints: (options.subscription?.enabled ? allEndpoints : coreEndpoints) as typeof allEndpoints,
    schema: getSchema(options),
    // Each of these fans out to the Trustware API, so keep them off the hot path of abuse.
    rateLimit: [
      { pathMatcher: (path: string) => path === "/trustware/invoice/pay", window: 60, max: 10 },
      { pathMatcher: (path: string) => path === "/trustware/payment/receipt", window: 60, max: 20 },
      { pathMatcher: (path: string) => path === "/trustware/invoice/status", window: 60, max: 60 },
      { pathMatcher: (path: string) => path === "/trustware/checkout", window: 60, max: 15 },
    ],
    options,
    $ERROR_CODES: TRUSTWARE_ERROR_CODES,
  } satisfies BetterAuthPlugin;
};

export type TrustwarePluginType<O extends TrustwareOptions> = ReturnType<typeof trustware<O>>;

export { TRUSTWARE_ERROR_CODES } from "./error-codes";
export { TrustwareApiError, createTrustwareApi } from "./trustware/api";
export { resolveStatus, statusGrantsAccess, summarizeAccess } from "./core/access";
export { addInterval } from "./core/intervals";
export { centsToBaseUnits } from "./core/money";
export type { ReconcileReport } from "./core/reconcile";
export type * from "./types";
export type * from "./trustware/types";
