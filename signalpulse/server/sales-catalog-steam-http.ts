/** Bounded, paced appdetails transport. Never turn throttling into eligibility. */
export async function fetchSteamCatalogJson(
  url:string,
  fetcher:typeof fetch=fetch,
  pause:(ms:number)=>Promise<void>=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
):Promise<unknown>{
  // Reconciliation is serial. Pace new requests as well as retries, especially
  // when discovery has just used the same host's storefront allowance.
  await pause(750);
  for(let attempt=0;attempt<3;attempt++){
    const response=await fetcher(url,{signal:AbortSignal.timeout(15000)});
    if(response.ok)return response.json();
    const status=response.status;
    const header=response.headers.get("retry-after");
    await response.body?.cancel();
    if(![429,502,503,504].includes(status)||attempt===2)
      throw Error(`steam storefront HTTP ${status}`);
    const parsed=header==null?NaN:(Number.isFinite(Number(header))?Number(header)*1000:Date.parse(header)-Date.now());
    const delay=Number.isFinite(parsed)?Math.max(0,parsed):1500*(attempt+1);
    // A long provider cooldown must be deferred, not shortened or hammered.
    if(delay>15000)throw Error(`steam storefront HTTP ${status}: retry_after_deferred`);
    await pause(Math.max(750,delay));
  }
  throw Error("Steam request attempts exhausted");
}
