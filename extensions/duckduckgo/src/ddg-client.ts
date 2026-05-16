import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { Context, Effect, Layer } from "effect";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_SEARCH_COUNT,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveSearchCount,
  resolveSiteName,
  resolveTimeoutSeconds,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import { resolveDdgRegion, resolveDdgSafeSearch, type DdgSafeSearch } from "./config.js";

const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html";
const DEFAULT_TIMEOUT_SECONDS = 20;
const DDG_SAFE_SEARCH_PARAM: Record<DdgSafeSearch, string> = {
  strict: "1",
  moderate: "-1",
  off: "-2",
};

const DDG_SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; insertedAt: number; expiresAt: number }
>();

type DuckDuckGoEndpointRequest = {
  url: string;
  timeoutSeconds: number;
  init: RequestInit;
  signal?: AbortSignal;
};

type DuckDuckGoSearchRuntime = {
  cache: typeof DDG_SEARCH_CACHE;
  now: () => number;
  runEndpoint: <T>(
    request: DuckDuckGoEndpointRequest,
    run: (response: Response) => Promise<T>,
  ) => Promise<T>;
};

const DuckDuckGoSearchRuntimeTag = Context.GenericTag<DuckDuckGoSearchRuntime>(
  "openclaw/duckduckgo/SearchRuntime",
);

function createDefaultDuckDuckGoSearchRuntime(): DuckDuckGoSearchRuntime {
  return {
    cache: DDG_SEARCH_CACHE,
    now: Date.now,
    runEndpoint: withTrustedWebSearchEndpoint,
  };
}

function duckDuckGoSearchRuntimeLayer(
  runtime?: Partial<DuckDuckGoSearchRuntime>,
): Layer.Layer<DuckDuckGoSearchRuntime> {
  return Layer.succeed(DuckDuckGoSearchRuntimeTag, {
    ...createDefaultDuckDuckGoSearchRuntime(),
    ...runtime,
  });
}

type DuckDuckGoResult = {
  title: string;
  url: string;
  snippet: string;
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, "--")
    .replace(/&hellip;/g, "...")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeDuckDuckGoUrl(rawUrl: string): string {
  try {
    const normalized = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
    const parsed = new URL(normalized);
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) {
      return uddg;
    }
  } catch {
    // Keep the original value when DuckDuckGo already returns a direct link.
  }
  return rawUrl;
}

function readHrefAttribute(tagAttributes: string): string {
  return /\bhref="([^"]*)"/i.exec(tagAttributes)?.[1] ?? "";
}

function isBotChallenge(html: string): boolean {
  if (/class="[^"]*\bresult__a\b[^"]*"/i.test(html)) {
    return false;
  }
  return /g-recaptcha|are you a human|id="challenge-form"|name="challenge"/i.test(html);
}

function parseDuckDuckGoHtml(html: string): DuckDuckGoResult[] {
  const results: DuckDuckGoResult[] = [];
  const resultRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")([^>]*)>([\s\S]*?)<\/a>/gi;
  const nextResultRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__a\b[^"]*")[^>]*>/i;
  const snippetRegex = /<a\b(?=[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*")[^>]*>([\s\S]*?)<\/a>/i;

  for (const match of html.matchAll(resultRegex)) {
    const rawAttributes = match[1] ?? "";
    const rawTitle = match[2] ?? "";
    const rawUrl = readHrefAttribute(rawAttributes);
    const matchEnd = (match.index ?? 0) + match[0].length;
    const trailingHtml = html.slice(matchEnd);
    const nextResultIndex = trailingHtml.search(nextResultRegex);
    const scopedTrailingHtml =
      nextResultIndex >= 0 ? trailingHtml.slice(0, nextResultIndex) : trailingHtml;
    const rawSnippet = snippetRegex.exec(scopedTrailingHtml)?.[1] ?? "";
    const title = decodeHtmlEntities(stripHtml(rawTitle));
    const url = decodeDuckDuckGoUrl(decodeHtmlEntities(rawUrl));
    const snippet = decodeHtmlEntities(stripHtml(rawSnippet));

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

export async function runDuckDuckGoSearch(params: {
  config?: OpenClawConfig;
  query: string;
  count?: number;
  region?: string;
  safeSearch?: DdgSafeSearch;
  timeoutSeconds?: number;
  cacheTtlMinutes?: number;
}): Promise<Record<string, unknown>> {
  return await Effect.runPromise(
    runDuckDuckGoSearchEffect(params).pipe(Effect.provide(duckDuckGoSearchRuntimeLayer())),
  );
}

function runDuckDuckGoSearchEffect(params: {
  config?: OpenClawConfig;
  query: string;
  count?: number;
  region?: string;
  safeSearch?: DdgSafeSearch;
  timeoutSeconds?: number;
  cacheTtlMinutes?: number;
}): Effect.Effect<Record<string, unknown>, unknown, DuckDuckGoSearchRuntime> {
  return Effect.flatMap(DuckDuckGoSearchRuntimeTag, (runtime) =>
    Effect.tryPromise({
      try: async () => {
        const count = resolveSearchCount(params.count, DEFAULT_SEARCH_COUNT);
        const region = params.region ?? resolveDdgRegion(params.config);
        const safeSearch =
          params.safeSearch === "strict" ||
          params.safeSearch === "moderate" ||
          params.safeSearch === "off"
            ? params.safeSearch
            : resolveDdgSafeSearch(params.config);
        const timeoutSeconds = resolveTimeoutSeconds(params.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
        const cacheTtlMs = resolveCacheTtlMs(params.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES);
        const cacheKey = normalizeCacheKey(
          JSON.stringify({
            provider: "duckduckgo",
            query: params.query,
            count,
            region: region ?? "",
            safeSearch,
          }),
        );
        const cached = readCache(runtime.cache, cacheKey);
        if (cached) {
          return { ...cached.value, cached: true };
        }

        const url = new URL(DDG_HTML_ENDPOINT);
        url.searchParams.set("q", params.query);
        if (region) {
          url.searchParams.set("kl", region);
        }
        url.searchParams.set("kp", DDG_SAFE_SEARCH_PARAM[safeSearch]);

        const startedAt = runtime.now();
        const results = await runtime.runEndpoint(
          {
            url: url.toString(),
            timeoutSeconds,
            init: {
              method: "GET",
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
              },
            },
          },
          async (response) => {
            if (!response.ok) {
              const detail = (await readResponseText(response, { maxBytes: 64_000 })).text;
              throw new Error(
                `DuckDuckGo search error (${response.status}): ${detail || response.statusText}`,
              );
            }

            const html = await response.text();
            if (isBotChallenge(html)) {
              throw new Error("DuckDuckGo returned a bot-detection challenge.");
            }
            return parseDuckDuckGoHtml(html).slice(0, count);
          },
        );

        const payload = {
          query: params.query,
          provider: "duckduckgo",
          count: results.length,
          tookMs: runtime.now() - startedAt,
          externalContent: {
            untrusted: true,
            source: "web_search",
            provider: "duckduckgo",
            wrapped: true,
          },
          results: results.map((result) => ({
            title: wrapWebContent(result.title, "web_search"),
            url: result.url,
            snippet: result.snippet ? wrapWebContent(result.snippet, "web_search") : "",
            siteName: resolveSiteName(result.url) || undefined,
          })),
        } satisfies Record<string, unknown>;

        writeCache(runtime.cache, cacheKey, payload, cacheTtlMs);
        return payload;
      },
      catch: (error) => error,
    }),
  );
}

export const __testing = {
  DDG_SEARCH_CACHE,
  decodeDuckDuckGoUrl,
  decodeHtmlEntities,
  duckDuckGoSearchRuntimeLayer,
  isBotChallenge,
  parseDuckDuckGoHtml,
  runDuckDuckGoSearchEffect,
};
