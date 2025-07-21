export interface Env {
  BUCKET: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let key = url.pathname.slice(1); // remove leading slash
    // Remap /data/metadata/* and /data/prediction/* to metadata/* and prediction/* in the bucket
    if (key.startsWith("data/metadata/")) {
      key = key.replace("data/metadata/", "metadata/");
    } else if (key.startsWith("data/prediction/")) {
      key = key.replace("data/prediction/", "prediction/");
    } else if (key.startsWith("data/normal/metadata/")) {
      key = key.replace("data/normal/metadata/", "normal/metadata/");
    } else if (key.startsWith("data/normal/prediction/")) {
      key = key.replace("data/normal/prediction/", "normal/prediction/");
    }

    if (
      !key.startsWith("normal/metadata/") &&
      !key.startsWith("normal/prediction/") &&
      !key.startsWith("metadata/") &&
      !key.startsWith("prediction/")
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
      : key.startsWith("normal/prediction/") || key.startsWith("prediction/")
      ? "public, max-age=3600"
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
