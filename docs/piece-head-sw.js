/* global self */

/**
 * PDP hosts return 405 for HEAD on piece URLs. Intercept HEAD for `/piece/*`,
 * probe with GET + Range: bytes=0-0, and synthesize a HEAD response (no body).
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/**
 * @param {string} pathname
 * @returns {boolean}
 */
function isPieceResourcePath(pathname) {
  return /\/piece\/.+/.test(pathname);
}

/**
 * @param {Response} inner
 * @returns {Promise<Response>}
 */
async function headFromRangedGetResponse(inner) {
  const outHeaders = new Headers(inner.headers);

  if (inner.status === 206) {
    const cr = inner.headers.get("Content-Range");
    const m = cr && /^bytes\s+\d+-\d+\/(\d+|\*)$/.exec(cr.trim());
    if (m && m[1] !== "*") {
      outHeaders.set("Content-Length", m[1]);
      outHeaders.delete("Content-Range");
      await inner.body?.cancel();
      return new Response(null, {
        status: 200,
        statusText: "OK",
        headers: outHeaders,
      });
    }
    await inner.body?.cancel();
    return new Response(null, {
      status: inner.status,
      statusText: inner.statusText,
      headers: outHeaders,
    });
  }

  await inner.body?.cancel();
  return new Response(null, {
    status: inner.status,
    statusText: inner.statusText,
    headers: outHeaders,
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "HEAD") {
    return;
  }
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (!isPieceResourcePath(url.pathname)) {
    return;
  }

  event.respondWith(
    (async () => {
      const headers = new Headers(req.headers);
      headers.set("Range", "bytes=0-0");
      try {
        const inner = await fetch(req.url, {
          method: "GET",
          headers,
          mode: req.mode,
          credentials: req.credentials,
          cache: req.cache,
          redirect: req.redirect,
          referrer: req.referrer,
          referrerPolicy: req.referrerPolicy,
          signal: req.signal,
        });
        return await headFromRangedGetResponse(inner);
      } catch {
        return new Response(null, { status: 503, statusText: "Service Unavailable" });
      }
    })()
  );
});
