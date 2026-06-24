export interface Env {
    BUCKET: R2Bucket;
}

// Origins that are allowed to hit the CDN. Anything not on this list gets
// 403 with no CORS headers — the response will be opaque to the caller's
// browser, which is what we want for unauthorized origins.
const ALLOWED_ORIGINS = new Set<string>([
    'https://yuenimillion.live',
    // Local dev — Vite default + the dev:debug variant we use.
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
]);

const CORS_BASE = {
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
} as const;

/**
 * Pick the value for `Access-Control-Allow-Origin`. In debug mode (the
 * `?debug` query param the frontend uses to bypass cache) we wildcard so
 * ad-hoc tools work; otherwise we echo the request's origin only when it's
 * on the allowlist.
 */
function resolveAllowOrigin(request: Request, isDebug: boolean): string | null {
    const origin = request.headers.get('Origin');
    if (isDebug) return '*';
    if (origin && ALLOWED_ORIGINS.has(origin)) return origin;
    return null;
}

/** Build a Response that always has CORS headers attached. */
function withCors(
    body: BodyInit | null,
    init: ResponseInit,
    allowOrigin: string | null,
): Response {
    const headers = new Headers(init.headers ?? {});
    if (allowOrigin) {
        headers.set('Access-Control-Allow-Origin', allowOrigin);
        headers.set('Vary', 'Origin');
    }
    Object.entries(CORS_BASE).forEach(([k, v]) => headers.set(k, v));
    // Allow callers to read detailed Resource Timing data
    // (transferSize, decodedBodySize, etc.) from cross-origin responses.
    // Required for performance measurements; safe for a public CDN.
    headers.set('Timing-Allow-Origin', '*');
    return new Response(body, { ...init, headers });
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        const isDebug = url.searchParams.has('no-cache') || url.searchParams.has('debug');

        // Path → R2 key remap.
        let key = url.pathname.slice(1); // remove leading slash
        if (key.startsWith('data/metadata/')) {
            key = key.replace('data/metadata/', 'metadata/');
        } else if (key.startsWith('data/prediction/')) {
            key = key.replace('data/prediction/', 'prediction/');
        } else if (key.startsWith('data/normal/metadata/')) {
            key = key.replace('data/normal/metadata/', 'normal/metadata/');
        } else if (key.startsWith('data/normal/prediction/')) {
            key = key.replace('data/normal/prediction/', 'normal/prediction/');
        } else if (key.startsWith('data/idol_icons/')) {
            key = key.replace('data/idol_icons/', 'idol_icons/');
        }

        // Idol icons are public static assets (loaded via <img>, which sends
        // no Origin header). They bypass the origin allowlist and are served
        // with a wildcard CORS origin. Everything else is the origin-gated
        // data API.
        const isIcon = key.startsWith('idol_icons/');
        const allowOrigin = isIcon ? '*' : resolveAllowOrigin(request, isDebug);

        // Reject disallowed origins for the data API. No CORS headers on this
        // path is intentional — the caller's browser will refuse to read it.
        if (!allowOrigin) {
            return new Response('CORS Forbidden', { status: 403 });
        }

        // Preflight.
        if (request.method === 'OPTIONS') {
            return withCors(null, { status: 204 }, allowOrigin);
        }

        if (
            !key.startsWith('normal/metadata/') &&
            !key.startsWith('normal/prediction/') &&
            !key.startsWith('metadata/') &&
            !key.startsWith('prediction/') &&
            !key.startsWith('idol_icons/')
        ) {
            return withCors('Forbidden', { status: 403 }, allowOrigin);
        }

        // For HEAD requests we can avoid streaming the body — `head()`
        // returns the same metadata without bothering with the object body.
        const object = request.method === 'HEAD'
            ? await env.BUCKET.head(key)
            : await env.BUCKET.get(key);
        if (!object) {
            return withCors('Not Found', { status: 404 }, allowOrigin);
        }

        const cacheControl = isDebug
            ? 'no-cache'
            : key.startsWith('idol_icons/')
                ? 'public, max-age=31536000, immutable'
                : key.startsWith('normal/prediction/') || key.startsWith('prediction/')
                    ? 'public, max-age=3600'
                    : 'public, max-age=86400';

        // R2 records the upload time on every object. Surface it as
        // `Last-Modified` so the frontend can do freshness checks via
        // HEAD probes (e.g. excluding leftover data from prior events).
        const lastModified = object.uploaded.toUTCString();
        const body = request.method === 'HEAD' ? null : (object as R2ObjectBody).body;

        return withCors(body, {
            status: 200,
            headers: {
                'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
                'Cache-Control': cacheControl,
                'Last-Modified': lastModified,
            },
        }, allowOrigin);
    },
};
