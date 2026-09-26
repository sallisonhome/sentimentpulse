import { fileSteamCatalogCooldown, retryAfterMs, SteamCatalogDeferred, type SteamCatalogCooldown } from "./steam-catalog-cooldown";

/** Bounded, paced appdetails transport. Never turn throttling into eligibility.
 * A 429 defers the provider, not merely one SKU. All callers share disk state.
 */
export async function fetchSteamCatalogJson(
  url:string,
  fetcher:typeof fetch=fetch,
  pause:(ms:number)=>Promise<void>=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  cooldown:SteamCatalogCooldown=fileSteamCatalogCooldown(),
):Promise<unknown>{
  // Reconciliation is serial. Pace new requests as well as retries, especially
  // when discovery has just used the same host's storefront allowance.
  cooldown.check();
  await pause(750);
  for(let attempt=0;attempt<3;attempt++){
    cooldown.check(); // Another process may have observed a throttle while we paced.
    const response=await fetcher(url,{signal:AbortSignal.timeout(15000)});
    if(response.ok)return response.json();
    const status=response.status;
    const header=response.headers.get("retry-after");
    await response.body?.cancel();
    if(status===429 || (status===503 && retryAfterMs(header,Date.now())!=null)) {
      const until=cooldown.defer(header);
      throw new SteamCatalogDeferred(until,`HTTP_${status}`);
    }
    if(![502,503,504].includes(status))
      throw Error(`steam storefront HTTP ${status}`);
    const parsed=retryAfterMs(header,Date.now());
    const delay=parsed??1500*(attempt+1);
    // A long provider cooldown must be deferred, not shortened or hammered.
    if(delay>15000)throw new SteamCatalogDeferred(cooldown.defer(header),`HTTP_${status}`);
    if(attempt===2)throw Error(`steam storefront HTTP ${status}`);
    await pause(Math.max(750,delay));
  }
  throw Error("Steam request attempts exhausted");
}
