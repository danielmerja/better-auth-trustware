import { describe, expect, it } from "vitest";
import { setup } from "./helpers";

describe("smoke", () => {
  it("runs checkout -> pay -> active", async () => {
    const t = await setup();
    const { auth, headers } = t;

    const checkout = await auth.api.trustwareCheckout({ headers, body: { plan: "pro" } });
    expect(checkout.invoice?.status).toBe("open");
    expect(checkout.invoice?.amountCents).toBe(2000);
    expect(checkout.invoice?.amountDueUnits).toBe("20000000");

    await t.pay(checkout.invoice!.id);

    const access = await auth.api.trustwareGetAccess({ headers });
    expect(access.hasAccess).toBe(true);
    expect(access.plan).toBe("pro");
  });
});
