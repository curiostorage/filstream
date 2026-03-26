/**
 * ESBuild entry: Synapse + session-key + viem re-exports for the browser upload module.
 */
export { Synapse, getChain } from "@filoz/synapse-sdk";
export {
  DefaultFwssPermissions,
  fromSecp256k1,
  loginSync,
} from "@filoz/synapse-core/session-key";
export { createWalletClient, custom, getAddress, http, numberToHex } from "viem";
export { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
