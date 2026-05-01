/**
 * Standalone bundle: Filcoin piece commitment (CommP) as a multiformats CID.
 * Output: docs/services/piece-cid-from-bytes.mjs (run `npm run build` in bundle-synapse).
 */
import * as Piece from "@web3-storage/data-segment/piece";

/**
 * @param {Uint8Array} bytes
 */
export function computePieceCidFromBytes(bytes) {
  const p = Piece.fromPayload(bytes);
  return Piece.toLink(p);
}
