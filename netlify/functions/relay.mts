import type { Config, Context } from "@netlify/functions";

const CODEBUFF_UPSTREAM = "https://www.codebuff.com";
const CODEBUFF_HOST = "www.codebuff.com";

const EXPERIENTIAL_UPSTREAM = "https://api.experientiallabs.ai";
const EXPERIENTIAL_HOST = "api.experientiallabs.ai";

// Comprehensive list of prefixes that leak client identity, IP or geolocation
const STRIP_REQUEST_HEADERS_PREFIX = [
  "cf-",           // Cloudflare headers (cf-connecting-ip, cf-ipcountry, cf-ray, etc.)
  "x-nf-",         // Netlify Edge headers (x-nf-client-connection-ip, x-nf-geo, etc.)
  "x-bb-",         // Bitballoon (Netlify internal legacy headers)
  "x-forwarded-",  // Proxies / CDNs (x-forwarded-for, x-forwarded-proto, etc.)
  "x-vercel-",     // Vercel proxy headers
  "x-render-",     // Render headers
  "x-real-",       // x-real-ip
  "x-client-",     // x-client-ip
  "x-cluster-",    // x-cluster-client-ip
  "x-country",     // x-country, x-country-code
  "x-geo",         // x-geoip-*, x-geo-*
];

const STRIP_EXACT_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "client-ip",
  "true-client-ip",
  "forwarded",
  "via",
  "cdn-loop",
  "x-envoy-external-address",
]);

const STRIP_RESPONSE_HEADERS = new Set([
  "server",
  "nel",
  "report-to",
  "alt-svc",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);

  // CORS Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
        "access-control-allow-headers": "*",
      },
    });
  }

  // Health check - Fixed & Sanitized (Never leaks user's real geo/IP)
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz" || url.pathname === "/api/healthz")) {
    return new Response(
      JSON.stringify({
        status: "ok",
        ok: true,
        platform: "netlify-functions-v2",
        region: "us-east-1",
        country: "US",
        timezone: "America/Los_Angeles",
        privacy: "anonymized_relay",
        services: ["codebuff", "experientiallabs"],
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store, no-cache, must-revalidate",
          "access-control-allow-origin": "*",
        },
      }
    );
  }

  // Determine target upstream (Codebuff vs ExperientialLabs)
  let upstreamBase = CODEBUFF_UPSTREAM;
  let upstreamHost = CODEBUFF_HOST;
  let targetPath = url.pathname;

  const authHeader = req.headers.get("authorization") || "";
  const isXpl = 
    url.pathname.startsWith("/xpl") || 
    (url.pathname.startsWith("/v1") && !url.pathname.startsWith("/api/v1")) ||
    req.headers.get("x-target-service") === "experientiallabs" ||
    authHeader.startsWith("Bearer xpl_");

  if (isXpl) {
    upstreamBase = EXPERIENTIAL_UPSTREAM;
    upstreamHost = EXPERIENTIAL_HOST;
    if (url.pathname.startsWith("/xpl")) {
      targetPath = url.pathname.replace(/^\/xpl/, "");
    }
  }

  const targetUrl = new URL(targetPath + url.search, upstreamBase);
  const headers = new Headers();

  // Forward only clean, sanitized headers
  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase();
    
    // Check if stripped
    if (STRIP_EXACT_HEADERS.has(lower)) continue;
    if (STRIP_REQUEST_HEADERS_PREFIX.some((prefix) => lower.startsWith(prefix))) continue;

    headers.set(key, value);
  }

  // Force upstream host and US locale/timezone parameters
  headers.set("host", upstreamHost);
  headers.set("accept-language", "en-US,en;q=0.9");
  headers.set("x-fb-timezone", "America/Los_Angeles");

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody ? req.body : undefined;

  try {
    const upstreamResp = await fetch(targetUrl.toString(), {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });

    const respHeaders = new Headers();
    for (const [key, value] of upstreamResp.headers.entries()) {
      const lower = key.toLowerCase();
      if (!STRIP_RESPONSE_HEADERS.has(lower) && !lower.startsWith("cf-")) {
        respHeaders.set(key, value);
      }
    }

    respHeaders.set("access-control-allow-origin", "*");
    respHeaders.set("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
    respHeaders.set("access-control-allow-headers", "*");

    // Ensure streaming SSE responses are never buffered or cut early
    if (respHeaders.get("content-type")?.includes("text/event-stream")) {
      respHeaders.set("cache-control", "no-cache, no-transform");
      respHeaders.set("x-accel-buffering", "no");
    }

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: respHeaders,
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        error: "relay_upstream_error",
        message: err?.message || `Failed to reach ${upstreamHost} upstream server`,
      }),
      {
        status: 502,
        headers: { 
          "content-type": "application/json",
          "access-control-allow-origin": "*" 
        },
      }
    );
  }
};

export const config: Config = {
  path: ["/", "/*"],
};
