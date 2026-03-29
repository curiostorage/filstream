#!/usr/bin/env node
// Usage:
//   PRIVATE_KEY=0x... node scripts/terminate-all-datasets.mjs

import {
  Synapse,
  getChain,
  http,
  privateKeyToAccount,
} from "../docs/vendor/synapse-browser.mjs";

const RPC_URL = "https://api.calibration.node.glif.io/rpc/v1";
const CHAIN_ID = 314159;

/**
 * @param {unknown} v
 * @returns {bigint | null}
 */
function asBigInt(v) {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.floor(v));
    if (typeof v === "string" && v.trim() !== "") return BigInt(v.trim());
  } catch {
    // no-op
  }
  return null;
}

const pkRaw = String(process.env.PRIVATE_KEY || "").trim();
if (!pkRaw) {
  throw new Error("Missing PRIVATE_KEY env var");
}
const privateKey = pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`;

const account = privateKeyToAccount(/** @type {`0x${string}`} */ (privateKey));
const chain = getChain(CHAIN_ID);
const synapse = Synapse.create({
  account,
  chain,
  transport: http(RPC_URL),
  source: "terminate-all-datasets",
});

console.log(`Wallet: ${account.address}`);
console.log("Fetching owned datasets...");

const raw = await synapse.storage.findDataSets({ address: account.address });
if (!Array.isArray(raw) || raw.length === 0) {
  console.log("No datasets found.");
  process.exit(0);
}

/** @type {Set<string>} */
const seen = new Set();
/** @type {{ id: bigint, providerId: unknown, isLive: unknown }[]} */
const datasets = [];
for (const ds of raw) {
  const id = asBigInt(
    /** @type {{ dataSetId?: unknown, pdpVerifierDataSetId?: unknown }} */ (ds)?.dataSetId ??
      /** @type {{ dataSetId?: unknown, pdpVerifierDataSetId?: unknown }} */ (ds)
        ?.pdpVerifierDataSetId,
  );
  if (id == null) continue;
  const key = id.toString();
  if (seen.has(key)) continue;
  seen.add(key);
  datasets.push({
    id,
    providerId: /** @type {{ providerId?: unknown }} */ (ds)?.providerId ?? null,
    isLive: /** @type {{ isLive?: unknown }} */ (ds)?.isLive,
  });
}

datasets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

let terminated = 0;
let skipped = 0;
let failed = 0;

for (const ds of datasets) {
  if (ds.isLive === false) {
    console.log(`SKIP dataSetId=${ds.id} (already not live)`);
    skipped += 1;
    continue;
  }

  try {
    console.log(`Terminating dataSetId=${ds.id} providerId=${String(ds.providerId)}`);
    const txHash = await synapse.storage.terminateDataSet({ dataSetId: ds.id });
    console.log(`  tx: ${txHash}`);
    const receipt = await synapse.client.waitForTransactionReceipt({ hash: txHash });
    const status = /** @type {{ status?: unknown }} */ (receipt)?.status;
    const ok = status === "success" || status === "0x1" || status === 1 || status === 1n;
    if (!ok) {
      throw new Error(`terminate tx reverted: ${txHash}`);
    }
    terminated += 1;
  } catch (err) {
    failed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FAIL dataSetId=${ds.id}: ${msg}`);
  }
}

console.log("\nDone.");
console.log(`Terminated: ${terminated}`);
console.log(`Skipped:    ${skipped}`);
console.log(`Failed:     ${failed}`);
