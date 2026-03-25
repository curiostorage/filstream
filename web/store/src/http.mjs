import { HttpError } from "./errors.mjs";

/**
 * Write a JSON response.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

/**
 * Read and parse JSON body with a byte limit.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {number} limitBytes
 * @returns {Promise<unknown>}
 */
export async function readJsonBody(req, limitBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const b = /** @type {Buffer} */ (chunk);
    total += b.length;
    if (total > limitBytes) {
      throw new HttpError(413, `Request body exceeds ${limitBytes} bytes`);
    }
    chunks.push(b);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

/**
 * Parse a base64 field into bytes.
 *
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {Uint8Array}
 */
export function parseBase64(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `Missing ${fieldName}`);
  }
  let decoded;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    throw new HttpError(400, `Invalid base64 in ${fieldName}`);
  }
  if (!decoded.length) {
    throw new HttpError(400, `${fieldName} decodes to empty bytes`);
  }
  return new Uint8Array(decoded);
}

/**
 * Parse a required string field.
 *
 * @param {unknown} value
 * @param {string} fieldName
 * @returns {string}
 */
export function parseRequiredString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `Missing ${fieldName}`);
  }
  return value.trim();
}
