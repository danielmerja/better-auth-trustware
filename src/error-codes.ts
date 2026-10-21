import { defineErrorCodes } from "@better-auth/core/utils/error-codes";

export const TRUSTWARE_ERROR_CODES = defineErrorCodes({
  UNAUTHORIZED: "Unauthorized access",
  INVALID_REQUEST_BODY: "Invalid request body",
  PLAN_NOT_FOUND: "Subscription plan not found",
  PLAN_INTERVAL_NOT_AVAILABLE: "This plan is not available for the requested billing interval",
  PRODUCT_NOT_FOUND: "Product not found",
  SUBSCRIPTIONS_NOT_ENABLED: "Subscriptions are not enabled",
  ALREADY_SUBSCRIBED: "This account already has an active subscription",
  SUBSCRIPTION_NOT_FOUND: "Subscription not found",
  SUBSCRIPTION_NOT_ACTIVE: "Subscription is not active",
  SUBSCRIPTION_NOT_PENDING_CHANGE: "Subscription has no pending cancellation or scheduled plan change",
  NO_CHANGE_REQUESTED: "The requested plan and interval match the current subscription",
  EMAIL_VERIFICATION_REQUIRED: "Email verification is required before you can subscribe to a plan",
  REFERENCE_ID_NOT_ALLOWED: "Reference id is not allowed",
  ORGANIZATION_SUBSCRIPTION_NOT_ENABLED: "Organization subscription is not enabled",
  AUTHORIZE_REFERENCE_REQUIRED:
    "Organization subscriptions require the authorizeReference callback to be configured",
  ORGANIZATION_REFERENCE_ID_REQUIRED:
    "Reference ID is required. Provide referenceId or set activeOrganizationId in the session",
  INVOICE_NOT_FOUND: "Invoice not found",
  INVOICE_NOT_PAYABLE: "Invoice can no longer be paid",
  PAYMENT_NOT_FOUND: "Payment not found",
  PAYMENT_ALREADY_SUBMITTED: "A transaction hash was already submitted for this payment",
  INVALID_TRANSACTION_HASH: "Invalid transaction hash",
  SOURCE_TOKEN_NOT_SUPPORTED: "The selected token cannot be used to pay on this chain",
  NO_ROUTE_AVAILABLE: "No payment route is available for the selected chain and token",
  AMOUNT_TOO_LOW_FOR_ROUTE:
    "The selected token cannot cover the amount due after fees. Try a different token or chain",
  PAYMENT_QUOTE_FAILED: "Unable to prepare this payment. Try another wallet, token or chain",
  PAYMENT_PROVIDER_UNAVAILABLE: "The payment provider is temporarily unavailable. Try again shortly",
  RECONCILE_UNAUTHORIZED: "Invalid or missing reconcile credentials",
  RECONCILE_NOT_CONFIGURED: "Set reconcile.secret to call the reconcile endpoint over HTTP",
});
