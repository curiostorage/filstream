import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

/**
 * Resolve the first existing `.env` file candidate for local development.
 * We intentionally support running from repo root or from `web/store`.
 *
 * @returns {string | null}
 */
function resolveEnvPath() {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(process.cwd(), "..", ".env"),
    path.join(process.cwd(), "..", "..", ".env"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Return a deterministic target path where we should persist `.env` keys
 * when no `.env` file exists yet.
 *
 * @returns {string}
 */
function fallbackEnvPath() {
  return path.join(process.cwd(), ".env");
}

/**
 * Parse a required integer environment variable.
 *
 * @param {string | undefined} raw
 * @param {string} name
 * @returns {number}
 */
function parseRequiredInt(raw, name) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`Missing or invalid ${name}`);
  }
  return n;
}

/**
 * Parse a required non-empty string environment variable.
 *
 * @param {string | undefined} raw
 * @param {string} name
 * @returns {string}
 */
function parseRequiredString(raw, name) {
  const value = (raw || "").trim();
  if (value === "") {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

/**
 * Parse an optional positive integer with fallback.
 *
 * @param {string | undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function parseOptionalPositiveInt(raw, fallback) {
  if (!raw || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return fallback;
  }
  return n;
}

/**
 * Upsert one `KEY=value` entry in a dotenv file.
 *
 * @param {string} filePath
 * @param {string} key
 * @param {string} value
 * @returns {void}
 */
function upsertEnvValue(filePath, key, value) {
  const normalizedPath = path.resolve(filePath);
  const exists = fs.existsSync(normalizedPath);
  let content = exists ? fs.readFileSync(normalizedPath, "utf8") : "";
  const keyPattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  const line = `${key}=${value}`;
  if (keyPattern.test(content)) {
    content = content.replace(keyPattern, line);
  } else {
    if (content.length > 0 && !content.endsWith("\n")) {
      content += "\n";
    }
    content += `${line}\n`;
  }
  fs.writeFileSync(normalizedPath, content, "utf8");
}

/**
 * Ensure STORE_FILSTREAM_ID exists in `.env`. If missing/blank, generate a UUID,
 * persist it, and return it.
 *
 * @param {string | null} envPath
 * @returns {string}
 */
function ensureFilstreamId(envPath) {
  const existing = (process.env.STORE_FILSTREAM_ID || "").trim();
  if (existing !== "") {
    return existing;
  }
  const generated = crypto.randomUUID();
  const target = envPath || fallbackEnvPath();
  upsertEnvValue(target, "STORE_FILSTREAM_ID", generated);
  process.env.STORE_FILSTREAM_ID = generated;
  return generated;
}

/**
 * Load and validate service configuration from `.env`.
 *
 * @returns {{
 *   host: string,
 *   port: number,
 *   rpcUrl: string,
 *   providerId: number,
 *   source: string,
 *   chainId: number,
 *   requestBodyLimitBytes: number,
 *   maxPieceBytes: number,
 *   filstreamId: string,
 *   envPath: string,
 * }}
 */
export function loadConfig() {
  const envPath = resolveEnvPath();
  if (envPath) {
    dotenv.config({ path: envPath });
  } else {
    dotenv.config();
  }

  const host = (process.env.STORE_HOST || "127.0.0.1").trim();
  const port = parseOptionalPositiveInt(process.env.STORE_PORT, 8090);
  const rpcUrl = parseRequiredString(process.env.STORE_RPC_URL, "STORE_RPC_URL");
  const providerId = parseRequiredInt(
    process.env.STORE_PROVIDER_ID,
    "STORE_PROVIDER_ID",
  );
  const source = parseRequiredString(process.env.STORE_SOURCE, "STORE_SOURCE");
  const chainId = parseRequiredInt(
    process.env.STORE_CHAIN_ID,
    "STORE_CHAIN_ID",
  );
  const requestBodyLimitBytes = parseOptionalPositiveInt(
    process.env.STORE_REQUEST_BODY_LIMIT_BYTES,
    40 * 1024 * 1024,
  );
  const maxPieceBytes = parseOptionalPositiveInt(
    process.env.STORE_MAX_PIECE_BYTES,
    254 * 1024 * 1024,
  );

  const filstreamId = ensureFilstreamId(envPath);

  return {
    host,
    port,
    rpcUrl,
    providerId,
    source,
    chainId,
    requestBodyLimitBytes,
    maxPieceBytes,
    filstreamId,
    envPath: envPath || fallbackEnvPath(),
  };
}
