import { createAuthMiddleware } from "@better-auth/core/api";
import { APIError } from "@better-auth/core/error";
import { sessionMiddleware } from "better-auth/api";
import { TRUSTWARE_ERROR_CODES as E } from "./error-codes";
import type { AuthorizeReferenceAction, CustomerType, TrustwareOptions } from "./types";
import type { Ctx } from "./core/store";

export const trustwareSessionMiddleware = createAuthMiddleware({ use: [sessionMiddleware] }, async (ctx) => {
  return { session: ctx.context.session };
});

/**
 * Confirm the signed-in user may act on `referenceId`. Their own id always passes
 * for personal billing; anything else (an organization, another user) must be
 * approved by the `authorizeReference` callback you provide.
 */
export async function assertReferenceAccess(
  ctx: Ctx,
  options: TrustwareOptions,
  args: { referenceId: string; customerType: CustomerType; action: AuthorizeReferenceAction },
): Promise<void> {
  const session = ctx.context.session;
  if (!session) throw APIError.from("UNAUTHORIZED", E.UNAUTHORIZED);
  const { referenceId, customerType, action } = args;

  if (customerType === "user" && referenceId === session.user.id) return;

  if (customerType === "organization" && !options.organization?.enabled) {
    throw APIError.from("BAD_REQUEST", E.ORGANIZATION_SUBSCRIPTION_NOT_ENABLED);
  }
  if (!options.authorizeReference) {
    ctx.context.logger.error(
      "[better-auth-trustware] Acting on a reference other than the signed-in user requires `authorizeReference` in the plugin options.",
    );
    throw APIError.from(
      "BAD_REQUEST",
      customerType === "organization" ? E.AUTHORIZE_REFERENCE_REQUIRED : E.REFERENCE_ID_NOT_ALLOWED,
    );
  }
  const allowed = await options.authorizeReference(
    { user: session.user, session: session.session, referenceId, action },
    ctx,
  );
  if (!allowed) throw APIError.from("UNAUTHORIZED", E.UNAUTHORIZED);
}

/**
 * Resolve and authorize `referenceId` / `customerType` from a request's body or
 * query, defaulting to the signed-in user (or the active organization).
 */
export const referenceMiddleware = (options: TrustwareOptions, action: AuthorizeReferenceAction) =>
  createAuthMiddleware(async (ctx) => {
    const session = ctx.context.session;
    if (!session) throw APIError.from("UNAUTHORIZED", E.UNAUTHORIZED);

    const customerType: CustomerType =
      (ctx.body?.customerType ?? ctx.query?.customerType) === "organization" ? "organization" : "user";
    const explicit: string | undefined = ctx.body?.referenceId || ctx.query?.referenceId || undefined;

    let referenceId: string;
    if (customerType === "organization") {
      const active = (session.session as { activeOrganizationId?: string | null }).activeOrganizationId;
      const resolved = explicit || active;
      if (!resolved) throw APIError.from("BAD_REQUEST", E.ORGANIZATION_REFERENCE_ID_REQUIRED);
      referenceId = resolved;
    } else {
      referenceId = explicit || session.user.id;
    }

    await assertReferenceAccess(ctx as unknown as Ctx, options, { referenceId, customerType, action });
    return { referenceId, customerType };
  });
