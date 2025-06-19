export interface Env {
  BUCKET: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key = url.pathname.slice(1); // remove leading slash

    if (
      !key.startsWith("normal/metadata/") &&
      !key.startsWith("normal/prediction/")
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    const object = await env.BUCKET.get(key);

    if (!object) {
      return new Response("Not Found", { status: 404 });
    }

    const origin = request.headers.get("Origin");
    const isDebug =
      url.searchParams.has("no-cache") || url.searchParams.has("debug");

    const allowOrigin =
      isDebug ? "*" : origin === "https://yuenimillion.live" ? origin : null;

    if (!allowOrigin) {
      return new Response("CORS Forbidden", { status: 403 });
    }

    const cacheControl = isDebug
      ? "no-cache"
      : key.startsWith("normal/prediction/")
      ? "public, max-age=18000"
      : "public, max-age=86400";

    return new Response(object.body, {
      headers: {
        "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
        "Access-Control-Allow-Origin": allowOrigin,
        Vary: "Origin",
        "Cache-Control": cacheControl,
      },
    });
  },
};
