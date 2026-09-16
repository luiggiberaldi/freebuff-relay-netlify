import type { Config, Context } from "@netlify/functions";

const UPSTREAM = "https://www.codebuff.com";
const UPSTREAM_HOST = "www.codebuff.com";

const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "client-ip",
  "x-real-ip",
  "true-client-ip",
  "x-country",
  "cdn-loop",
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

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);

  // Health check
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/healthz" || url.pathname === "/api/healthz")) {
    return new Response(
      JSON.stringify({
        status: "ok",
        ok: true,
        platform: "netlify-functions-v2",
        geo: context.geo || null,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store, no-cache, must-revalidate",
        },
      }
    );
  }

  const targetUrl = new URL(url.pathname + url.search, UPSTREAM);
  const headers = new Headers();
  headers.set("host", UPSTREAM_HOST);

  for (const [key, value] of req.headers.entries()) {
    const lower = key.toLowerCase();
    if (
      !STRIP_REQUEST_HEADERS.has(lower) &&
      !lower.startsWith("cf-") &&
      !lower.startsWith("x-nf-") &&
      !lower.startsWith("x-forwarded-") &&
      !lower.startsWith("x-vercel-")
    ) {
      headers.set(key, value);
    }
  }

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

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: respHeaders,
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({
        error: "relay_upstream_error",
        message: err?.message || "Failed to reach Codebuff upstream server",
      }),
      {
        status: 502,
        headers: { "content-type": "application/json" },
      }
    );
  }
};

export const config: Config = {
  path: ["/", "/*"],
};
