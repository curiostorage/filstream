/**
 * EIP-6963 injected wallet discovery (https://eips.ethereum.org/EIPS/eip-6963).
 * No npm deps — edit and refresh.
 */

/**
 * @typedef {{ uuid: string, name: string, icon: string, rdns: string }} Eip6963ProviderInfo
 * @typedef {{
 *   request: (args: { method: string, params?: unknown[] }) => Promise<unknown>
 * }} Eip1193Provider
 * @typedef {{ info: Eip6963ProviderInfo, provider: Eip1193Provider }} Eip6963AnnouncedWallet
 */

const LEGACY_UUID = "eip6963:legacy-window-ethereum";

/** @param {Eip6963AnnouncedWallet[]} list */
function mergeLegacyEthereum(list) {
  const eth = typeof window !== "undefined" ? window.ethereum : undefined;
  if (!eth || typeof eth.request !== "function") return list;

  const sameRef = list.some((w) => w.provider === eth);
  if (sameRef) return list;

  return [
    ...list,
    {
      info: {
        uuid: LEGACY_UUID,
        name: "Browser wallet (window.ethereum)",
        icon: "",
        rdns: "window.ethereum",
      },
      provider: eth,
    },
  ];
}

/**
 * Subscribe to announced providers; dedupes by `info.uuid`.
 * Dispatches `eip6963:requestProvider` once when subscribing.
 * @param {(wallets: Eip6963AnnouncedWallet[]) => void} onChange
 * @returns {() => void} unsubscribe
 */
export function subscribeInjectedWallets(onChange) {
  if (typeof window === "undefined") {
    onChange([]);
    return () => {};
  }

  /** @type {Map<string, Eip6963AnnouncedWallet>} */
  const byUuid = new Map();

  const emit = () => {
    const announced = [...byUuid.values()];
    onChange(mergeLegacyEthereum(announced));
  };

  /** @param {Event} ev */
  const onAnnounce = (ev) => {
    const ce = /** @type {CustomEvent<Eip6963AnnouncedWallet>} */ (ev);
    const d = ce.detail;
    if (!d?.info?.uuid || !d.provider?.request) return;
    byUuid.set(d.info.uuid, { info: d.info, provider: d.provider });
    emit();
  };

  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  emit();

  return () => {
    window.removeEventListener("eip6963:announceProvider", onAnnounce);
  };
}

/** Ask injectors to re-announce (e.g. after installing an extension). */
export function requestInjectedProviders() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/**
 * @param {Eip1193Provider} provider
 * @returns {Promise<string | null>} first checksummed-ish hex address or null
 */
export async function connectInjectedProvider(provider) {
  const accounts = /** @type {string[]} */ (
    await provider.request({ method: "eth_requestAccounts" })
  );
  const a = accounts?.[0];
  return typeof a === "string" && a.startsWith("0x") ? a : null;
}
