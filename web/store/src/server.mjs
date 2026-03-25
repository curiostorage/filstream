import http from "node:http";
import { loadConfig } from "./config.mjs";
import { HttpError, toHttpError } from "./errors.mjs";
import { parseRequiredString, readJsonBody, sendJson } from "./http.mjs";
import { StoreService } from "./service.mjs";

/**
 * Parse `/api/store/uploads/:uploadId/...` paths.
 *
 * @param {string} pathname
 * @returns {{ uploadId: string | null, suffix: string | null }}
 */
function parseUploadPath(pathname) {
  const m = pathname.match(/^\/api\/store\/uploads\/([^/]+)(\/.*)?$/);
  if (!m) return { uploadId: null, suffix: null };
  return { uploadId: m[1], suffix: m[2] || "" };
}

/**
 * Return true when request content-type indicates JSON.
 *
 * @param {string | undefined} contentType
 * @returns {boolean}
 */
function isJsonContentType(contentType) {
  if (!contentType) return false;
  return contentType.toLowerCase().startsWith("application/json");
}

/**
 * Parse a required object field from request body.
 *
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {Record<string, unknown>}
 */
function parseRequiredObject(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `Missing ${fieldName}`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Build HTTP handler for the store API.
 *
 * @param {StoreService} service
 * @param {number} bodyLimitBytes
 * @returns {import("node:http").RequestListener}
 */
function buildHandler(service, bodyLimitBytes) {
  return async (req, res) => {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;

    try {
      if (method === "GET" && pathname === "/api/store/healthz") {
        sendJson(res, 200, {
          ok: true,
          service: "store",
          uptimeSec: Math.round(process.uptime()),
        });
        return;
      }

      if (method === "POST" && pathname === "/api/store/uploads/init") {
        if (!isJsonContentType(req.headers["content-type"])) {
          throw new HttpError(415, "Content-Type must be application/json");
        }
        const body = /** @type {Record<string, unknown>} */ (
          await readJsonBody(req, bodyLimitBytes)
        );
        const result = await service.createUploadSession({
          assetId: parseRequiredString(body.assetId, "assetId"),
          clientAddress: parseRequiredString(body.clientAddress, "clientAddress"),
          sessionPrivateKey: parseRequiredString(
            body.sessionPrivateKey,
            "sessionPrivateKey",
          ),
          sessionExpirations: parseRequiredObject(
            body.sessionExpirations,
            "sessionExpirations",
          ),
        });
        sendJson(res, 200, result);
        return;
      }

      const { uploadId, suffix } = parseUploadPath(pathname);
      if (!uploadId) {
        throw new HttpError(404, "Route not found");
      }

      if (method === "GET" && suffix === "/status") {
        sendJson(res, 200, service.getStatus(uploadId));
        return;
      }

      if (method === "POST" && suffix === "/abort") {
        sendJson(res, 200, service.abortUpload(uploadId));
        return;
      }

      if (method === "POST" && suffix === "/delete-account") {
        sendJson(res, 200, await service.deleteAccountData(uploadId));
        return;
      }

      if (method === "POST" && suffix === "/delete-asset") {
        sendJson(res, 200, await service.deleteAsset(uploadId));
        return;
      }

      if (!isJsonContentType(req.headers["content-type"])) {
        throw new HttpError(415, "Content-Type must be application/json");
      }
      const body = /** @type {Record<string, unknown>} */ (
        await readJsonBody(req, bodyLimitBytes)
      );

      if (method === "POST" && suffix === "/events") {
        const type = parseRequiredString(body.type, "type");
        sendJson(
          res,
          200,
          await service.ingestEvent(uploadId, {
            type,
            detail: body.detail ?? {},
          }),
        );
        return;
      }

      if (method === "POST" && suffix === "/finalize") {
        sendJson(res, 200, await service.finalizeUpload(uploadId));
        return;
      }

      throw new HttpError(404, "Route not found");
    } catch (error) {
      const normalized = toHttpError(error);
      sendJson(res, normalized.status, {
        error: normalized.message,
        details: normalized.details,
      });
    }
  };
}

/**
 * Start the store service.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const config = loadConfig();
  const service = new StoreService(config);
  await service.init();
  const server = http.createServer(
    buildHandler(service, config.requestBodyLimitBytes),
  );
  server.listen(config.port, config.host, () => {
    console.log(
      `[store] listening on http://${config.host}:${config.port} (providerId=${config.providerId}, filstreamId=${config.filstreamId}, env=${config.envPath})`,
    );
  });
}

await main();
