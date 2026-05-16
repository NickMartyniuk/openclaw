import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __testing } from "./ddg-client.js";

type DuckDuckGoSearchRuntimeOverrides = NonNullable<
  Parameters<typeof __testing.duckDuckGoSearchRuntimeLayer>[0]
>;
type DuckDuckGoRunEndpoint = NonNullable<DuckDuckGoSearchRuntimeOverrides["runEndpoint"]>;

function resultHtml(params: { title: string; url: string; snippet: string }) {
  return `
    <a class="result__a" href="${params.url}">${params.title}</a>
    <a class="result__snippet">${params.snippet}</a>
  `;
}

describe("duckduckgo effect runtime", () => {
  beforeEach(() => {
    __testing.DDG_SEARCH_CACHE.clear();
  });

  it("runs the search through an injectable Effect runtime and caches payloads", async () => {
    const cache: NonNullable<DuckDuckGoSearchRuntimeOverrides["cache"]> = new Map();
    const now = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_037);
    const runEndpoint = vi.fn<DuckDuckGoRunEndpoint>(async (request, run) => {
      expect(request.timeoutSeconds).toBe(12);
      expect(new URL(request.url).searchParams.get("q")).toBe("openclaw effect");
      expect(new URL(request.url).searchParams.get("kl")).toBe("us-en");
      expect(new URL(request.url).searchParams.get("kp")).toBe("-2");
      return await run(
        new Response(
          resultHtml({
            title: "OpenClaw &amp; Effect",
            url: "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.openclaw.ai%2F",
            snippet: "Typed effects &amp; plugin runtime",
          }),
          { status: 200 },
        ),
      );
    });
    const runtime = __testing.duckDuckGoSearchRuntimeLayer({
      cache,
      now,
      runEndpoint,
    });
    const search = {
      query: "openclaw effect",
      count: 3,
      region: "us-en",
      safeSearch: "off" as const,
      timeoutSeconds: 12,
    };

    const first = await Effect.runPromise(
      __testing.runDuckDuckGoSearchEffect(search).pipe(Effect.provide(runtime)),
    );
    const second = await Effect.runPromise(
      __testing.runDuckDuckGoSearchEffect(search).pipe(Effect.provide(runtime)),
    );

    expect(runEndpoint).toHaveBeenCalledOnce();
    expect(first).toMatchObject({
      count: 1,
      provider: "duckduckgo",
      query: "openclaw effect",
      tookMs: 37,
    });
    expect(first.results).toEqual([
      {
        title: expect.stringContaining("OpenClaw & Effect"),
        url: "https://docs.openclaw.ai/",
        snippet: expect.stringContaining("Typed effects & plugin runtime"),
        siteName: "docs.openclaw.ai",
      },
    ]);
    expect(second).toMatchObject({
      cached: true,
      count: 1,
      provider: "duckduckgo",
    });
  });

  it("fails through the Effect error channel for bot challenges", async () => {
    const runtime = __testing.duckDuckGoSearchRuntimeLayer({
      cache: new Map(),
      runEndpoint: async (_request, run) =>
        await run(new Response('<form id="challenge-form">Are you a human?</form>')),
    });

    await expect(
      Effect.runPromise(
        __testing
          .runDuckDuckGoSearchEffect({ query: "openclaw" })
          .pipe(Effect.provide(runtime)),
      ),
    ).rejects.toThrow("DuckDuckGo returned a bot-detection challenge.");
  });
});
