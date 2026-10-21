import { createAuthEndpoint } from "@better-auth/core/api";
import { APIError } from "@better-auth/core/error";
import { HIDE_METADATA } from "better-auth";
import { constantTimeEqual } from "better-auth/crypto";
import * as z from "zod";
import type { Billing } from "../core/billing";
import { reconcile } from "../core/reconcile";
import { TRUSTWARE_ERROR_CODES as E } from "../error-codes";

/**
 * Server-only. Run billing housekeeping from your own code or scheduler:
 * `await auth.api.trustwareReconcile({ body: {} })`.
 */
export const reconcileServer = (billing: Billing) =>
  createAuthEndpoint(
    {
      method: "POST",
      body: z.object({ referenceId: z.string().optional() }).optional(),
      metadata: { openapi: { operationId: "trustwareReconcileServer" } },
    },
    async (ctx) => {
      const report = await reconcile(ctx, billing, { referenceId: ctx.body?.referenceId });
      return ctx.json(report);
    },
  );

/**
 * HTTP trigger for schedulers (Vercel Cron, GitHub Actions, etc.), GET or POST. Disabled
 * unless `reconcile.secret` is set, and compares the bearer token in constant time.
 */
export const reconcileHttp = (billing: Billing) =>
  createAuthEndpoint(
    "/trustware/reconcile",
    {
      // Schedulers differ: Vercel Cron sends GET, GitHub Actions and most others POST.
      method: ["GET", "POST"],
      metadata: { ...HIDE_METADATA, openapi: { operationId: "trustwareReconcile" } },
    },
    async (ctx) => {
      const secret = billing.options.reconcile?.secret;
      if (!secret) throw APIError.from("FORBIDDEN", E.RECONCILE_NOT_CONFIGURED);
      const header = ctx.request?.headers.get("authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!token || !constantTimeEqual(token, secret)) {
        throw APIError.from("UNAUTHORIZED", E.RECONCILE_UNAUTHORIZED);
      }
      return ctx.json(await reconcile(ctx, billing));
    },
  );
