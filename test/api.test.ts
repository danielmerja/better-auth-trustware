import { describe, expect, it } from "vitest";
import { TrustwareApiError, createTrustwareApi, normalizeStatus } from "../src/trustware/api";

type Handler = (req: { url: string; init: RequestInit }) => Response | Promise<Response>;

function client(handler: Handler, extra: Record<string, unknown> = {}) {
  const requests: { url: string; init: RequestInit }[] = [];
  const api = createTrustwareApi({
    apiKey: "tw_test_key",
    baseUrl: "https://api.example.test/",
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return handler({ url, init });
    }) as unknown as typeof fetch,
    ...extra,
  });
  return { api, requests };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

const request = {
  fromChain: "1",
  toChain: "8453",
  fromToken: "0xeee",
  toToken: "0xusdc",
  fromAmount: "1000",
  fromAddress: "0xa",
  toAddress: "0xb",
};

describe("createTrustwareApi", () => {
  it("requires an api key", () => {
    expect(() => createTrustwareApi({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("sends the key in X-API-Key, trims the base url, and unwraps data", async () => {
    const { api, requests } = client(() =>
      json({ data: { estimate: { fromAmount: "1000", toAmount: "5", toAmountMin: "4" } } }),
    );
    const quote = await api.quote(request);
    expect(quote.estimate.toAmountMin).toBe("4");
    expect(requests[0].url).toBe("https://api.example.test/api/v1/routes/quote");
    expect(requests[0].init.method).toBe("POST");
    expect((requests[0].init.headers as Record<string, string>)["X-API-Key"]).toBe("tw_test_key");
    expect(JSON.parse(requests[0].init.body as string)).toMatchObject({ fromChain: "1", toChain: "8453" });
  });

  it("posts routes and receipts to the documented paths", async () => {
    const { api, requests } = client(({ url }) =>
      url.endsWith("/routes/route")
        ? json({ data: { intentId: "int-1", route: { estimate: {}, execution: { transaction: { to: "0x1" } } } } })
        : json({ data: { ok: true } }),
    );
    expect((await api.route({ ...request, metadata: { invoiceId: "inv" } })).intentId).toBe("int-1");
    await api.receipt("int/1", "0xhash");
    expect(requests[1].url).toBe("https://api.example.test/api/v1/route-intent/int%2F1/receipt");
    expect(JSON.parse(requests[1].init.body as string)).toEqual({ txHash: "0xhash" });
  });

  it("rejects malformed success responses instead of trusting them", async () => {
    const { api } = client(() => json({ data: {} }));
    await expect(api.quote(request)).rejects.toMatchObject({ details: { status: 502 } });
    await expect(api.route(request)).rejects.toBeInstanceOf(TrustwareApiError);
    await expect(api.status("x")).rejects.toBeInstanceOf(TrustwareApiError);
  });

  it("surfaces Trustware's error code, providers and request id", async () => {
    const { api } = client(() =>
      json(
        {
          error: "No route",
          code: "no_route_available",
          providers: [{ name: "squid", outcome: "declined", code: "pair_unsupported" }],
        },
        { status: 404, headers: { "x-request-id": "req-9" } },
      ),
    );
    const error = (await api.route(request).catch((e) => e)) as TrustwareApiError;
    expect(error).toBeInstanceOf(TrustwareApiError);
    expect(error.status).toBe(404);
    expect(error.code).toBe("no_route_available");
    expect(error.details.requestId).toBe("req-9");
    expect(error.details.providers?.[0].code).toBe("pair_unsupported");
    expect(error.transient).toBe(false);
  });

  it("marks outages and rate limits as transient", async () => {
    const down = client(() => json({ error: "boom" }, { status: 503 }));
    expect(((await down.api.status("x").catch((e) => e)) as TrustwareApiError).transient).toBe(true);

    const providers = client(() => json({ code: "providers_failed" }, { status: 502 }));
    expect(((await providers.api.route(request).catch((e) => e)) as TrustwareApiError).transient).toBe(true);

    const network = client(() => {
      throw new TypeError("fetch failed");
    });
    const error = (await network.api.status("x").catch((e) => e)) as TrustwareApiError;
    expect(error.status).toBe(0);
    expect(error.transient).toBe(true);
  });

  it("retries 429s using Retry-After, then gives up", async () => {
    let calls = 0;
    const { api } = client(
      () => {
        calls += 1;
        return calls < 3
          ? json({ error: "slow down" }, { status: 429, headers: { "retry-after": "0" } })
          : json({ data: { estimate: { toAmountMin: "1" } } });
      },
      { maxRateLimitRetries: 2 },
    );
    await api.quote(request);
    expect(calls).toBe(3);

    let always = 0;
    const limited = client(
      () => {
        always += 1;
        return json({}, { status: 429, headers: { "retry-after": "0" } });
      },
      { maxRateLimitRetries: 1 },
    );
    await expect(limited.api.quote(request)).rejects.toMatchObject({ details: { status: 429 } });
    expect(always).toBe(2);
  });

  it("never retries a non-429 failure", async () => {
    let calls = 0;
    const { api } = client(() => {
      calls += 1;
      return json({ error: "bad" }, { status: 400 });
    });
    await api.quote(request).catch(() => {});
    expect(calls).toBe(1);
  });

  it("follows token pagination until the cursor runs out", async () => {
    const pages = [
      { data: { tokens: [{ address: "0xa", chainId: "8453", symbol: "A", decimals: 6, usdPrice: 1 }], nextCursor: "c2" } },
      { data: { tokens: [{ address: "0xb", chainId: "8453", symbol: "B", decimals: 18, usdPrice: "2.5" }, { bogus: true }] } },
    ];
    let i = 0;
    const { api, requests } = client(() => json(pages[i++]));
    const tokens = await api.tokens({ chainId: "8453" });
    expect(tokens.map((t) => t.symbol)).toEqual(["A", "B"]);
    expect(tokens[1].usdPrice).toBe(2.5);
    expect(requests[0].url).toContain("chainId=8453");
    expect(requests[1].url).toContain("cursor=c2");
  });

  it("accepts a bare array of tokens and drops tokens it can't price", async () => {
    const { api } = client(() =>
      json({ data: [{ address: "0xa", symbol: "A", decimals: 6, usdPrice: 0 }, { address: "0xb", symbol: "B", decimals: 6 }] }),
    );
    const tokens = await api.tokens({ chainId: "1" });
    expect(tokens).toHaveLength(2);
    expect(tokens.every((t) => t.usdPrice === undefined)).toBe(true);
    expect(tokens[0].chainId).toBe("1");
  });

  it("validates the key", async () => {
    const { api, requests } = client(() => json({ valid: true, status: "active" }));
    expect(await api.validate()).toMatchObject({ valid: true });
    expect(requests[0].url).toBe("https://api.example.test/api/v1/sdk/validate");
  });
});

describe("normalizeStatus", () => {
  it("reads Trustware's snake_case payload", () => {
    const status = normalizeStatus("fallback", {
      intent_id: "int-1",
      status: "SUCCESS",
      source_tx_hash: "0xsrc",
      dest_tx_hash: "0xdst",
      from_address: "0xa",
      to_address: "0xb",
      from_chain_id: 1,
      to_chain_id: 8453,
      to_amount_wei: "20000000",
      landed_amount_verified: true,
      routing_provider: "squid",
      next_poll_at: "2026-01-01T00:00:10.000Z",
      metadata: { invoiceId: "inv_1" },
    });
    expect(status).toMatchObject({
      intentId: "int-1",
      status: "success",
      sourceTxHash: "0xsrc",
      destTxHash: "0xdst",
      toAddress: "0xb",
      fromChainId: "1",
      toChainId: "8453",
      toAmount: 20_000_000n,
      landedAmountVerified: true,
      provider: "squid",
      metadata: { invoiceId: "inv_1" },
    });
    expect(status.nextPollAt?.toISOString()).toBe("2026-01-01T00:00:10.000Z");
  });

  it("also reads camelCase", () => {
    const status = normalizeStatus("x", { status: "bridging", toAmountWei: "5", destTxHash: "0xd", nextPollAt: "2026-01-01T00:00:00Z" });
    expect(status).toMatchObject({ status: "bridging", toAmount: 5n, destTxHash: "0xd" });
  });

  it("treats an unknown status as in flight, never as success", () => {
    expect(normalizeStatus("x", { status: "settled_maybe" }).status).toBe("submitted");
    expect(normalizeStatus("x", {}).status).toBe("pending");
  });

  it("rejects non-integer amounts and bad dates", () => {
    const status = normalizeStatus("x", { status: "success", to_amount_wei: "12.5", next_poll_at: "not a date" });
    expect(status.toAmount).toBeUndefined();
    expect(status.nextPollAt).toBeUndefined();
  });
});
