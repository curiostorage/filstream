/**
 * Incremental Fil piece commitment (CommP) as a multiformats CID.
 * Output: docs/piece-commp-incremental.mjs (run `npm run build` in bundle-synapse).
 */
import * as Multihash from "@web3-storage/data-segment/multihash";
import * as Piece from "@web3-storage/data-segment/piece";

/**
 * Streaming hasher for one piece payload; call {@link pieceLinkFromHasher} after all bytes are written.
 *
 * @returns {ReturnType<typeof Multihash.create>}
 */
export function createPieceHasher() {
  return Multihash.create();
}

/**
 * @param {ReturnType<typeof Multihash.create>} hasher
 */
export function pieceLinkFromHasher(hasher) {
  const digest = hasher.digest();
  return Piece.toLink(Piece.fromDigest(digest));
}
