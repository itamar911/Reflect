/**
 * What a contract is CALLED, cached, and null when we could not find out.
 *
 * SERVER ONLY, and a module of its own since REF-117 Stage 6, because it now
 * has two callers with the same need and the same failure rule:
 *
 *   - ./positions.ts, for the live position line. A name is decoration there —
 *     "you are holding 2 contracts" is still worth saying when we cannot say of
 *     what.
 *   - ./fills.ts, for a HELD group. A group the cycle walk refused to state is
 *     reported to the trader by the contract it is on ("עסקאות ב-MNQZ6
 *     ממתינות"), and that is the only trader-facing name we have for it:
 *     {@link import('./cycles').HeldGroup} carries a `contractId`, which is a
 *     broker id and never leaves the server.
 *
 * THIS IS NOT ./fills.ts' CONTRACT CHAIN AND MUST NOT BE CONFUSED WITH IT.
 * `loadContractUnits` there reads three entities to reach `valuePerPoint` and
 * THROWS on any gap, because a missing value per point means a figure in points
 * measured against a dollar threshold — REF-90 §4. This reads one entity for
 * one string and swallows everything. A held group must never be able to fail
 * the pull: the whole point of {@link import('./fills').HeldGroup} is that an
 * absence travels beside the rows instead of taking them down.
 *
 * SO THE TWO CACHES ARE KEYED DIFFERENTLY ON PURPOSE. `unitByContractName` is
 * keyed by NAME so it can be shared across hosts — a name is an exchange fact,
 * and that is what buys the calls back. This one is keyed BY ID, because the id
 * is what we have before the lookup, and nothing documents live and demo as
 * sharing an id space. An id-keyed cache without the host prefix would
 * eventually label one host's contract with the other host's name, which is a
 * quiet wrong answer on a screen the trader is watching.
 */

import type { TradovateReader } from './fills';
import type { TradovateEnvironment } from './hosts';
import type { TradovateContract } from './types';

/**
 * Contract names, by host-qualified id.
 *
 * No expiry: a contract's name does not change, and the natural TTL is the
 * process, which on Vercel is short. The cap is what stops a long-lived
 * instance from growing an entry per contract per trader forever.
 *
 * A NULL IS CACHED TOO, which is deliberate and is the opposite of
 * `unitByContractName`'s rule. There, a body with no usable name is not
 * remembered, because the name is the cache's own key. Here the key is the id,
 * so "this contract has no readable name" is an answer worth keeping for the
 * process rather than re-asking for on every fifteen-second poll.
 */
const nameByHostContract = new Map<string, string | null>();
const MAX_CACHED_CONTRACTS = 500;

/** Test seam. Nothing in production calls this. */
export function forgetContractNames(): void {
  nameByHostContract.clear();
}

/**
 * `contractId` → its name, or null. ONE ENTITY READ PER UNCACHED ID, SWALLOWED.
 *
 * Sequential rather than `Promise.all`, which is the live route's shape and is
 * right for both callers: a trader holds one or two contracts, and a held group
 * is one abnormal `(account, contract)`. What this must not become is a fan-out
 * proportional to a day's contract count against a rate limit whose penalty is
 * a `p-captcha` a third-party application cannot clear.
 */
export async function loadContractNames(
  reader: TradovateReader,
  host: TradovateEnvironment,
  contractIds: ReadonlySet<number>
): Promise<Map<number, string | null>> {
  const names = new Map<number, string | null>();

  for (const contractId of contractIds) {
    const key = `${host}:${contractId}`;
    const cached = nameByHostContract.get(key);
    if (cached !== undefined) {
      names.set(contractId, cached);
      continue;
    }

    // A lookup that fails costs the NAME and not the thing it was naming. See
    // the header on why the day pull's contract chain takes the opposite line.
    let name: string | null = null;
    try {
      const contract = await reader.get<TradovateContract>('/contract/item', { id: contractId });
      const raw = contract?.name;
      name = typeof raw === 'string' && raw.trim() !== '' ? raw : null;
    } catch {
      name = null;
    }

    if (nameByHostContract.size >= MAX_CACHED_CONTRACTS) {
      nameByHostContract.delete(nameByHostContract.keys().next().value as string);
    }
    nameByHostContract.set(key, name);
    names.set(contractId, name);
  }

  return names;
}
