/**
 * The network gate (SPEC.md §4 invariants): the Kalshi client and every feed adapter call
 * `assertNetworkAllowed()` before any request. While the global kill switch is on the gate rejects
 * with `NetworkPaused`, so the app makes zero outgoing HTTP requests; requests already in flight are
 * allowed to finish. The switch is read on every call (from the database), never cached.
 */

export class NetworkPaused extends Error {
  override name = 'NetworkPaused';
  constructor() {
    super('outgoing requests are paused: the global kill switch is on');
  }
}

export interface NetworkGate {
  /** Throws `NetworkPaused` while the global kill switch is on. */
  assertNetworkAllowed(): void;
}

/** A gate reading the kill switch through `isKillSwitchOn` on every call (errors propagate: fail closed). */
export function createNetworkGate(isKillSwitchOn: () => boolean): NetworkGate {
  return {
    assertNetworkAllowed() {
      if (isKillSwitchOn()) throw new NetworkPaused();
    },
  };
}
