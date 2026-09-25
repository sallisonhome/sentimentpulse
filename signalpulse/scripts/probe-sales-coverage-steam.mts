/** Read-only native transport check; no storage import and no DB writes. */
import {fetchSteamCatalogJson} from "../server/sales-catalog-steam-http";
const ids=(process.argv[2]??"").split(",").filter(Boolean);
if(!ids.length||ids.some(id=>!/^[1-9]\d*$/.test(id)))throw Error("Pass comma-separated Steam App IDs");
let failed=0;
for(const id of ids){
  let attempts=0;
  try{
    const body=await fetchSteamCatalogJson(
      `https://store.steampowered.com/api/appdetails?appids=${id}&cc=us&l=english`,
      ((...args:Parameters<typeof fetch>)=>{attempts++;return fetch(...args);}) as typeof fetch,
    ) as Record<string,any>;
    const matches=Object.values(body).filter(p=>p?.success && String(p.data?.steam_appid)===id);
    if(matches.length!==1)throw Error("No unique exact native App ID");
    const p=matches[0].data;
    console.log(JSON.stringify({id,attempts,name:p.name,type:p.type,isFree:p.is_free,
      price:p.price_overview,release:p.release_date}));
  }catch(e){failed++;console.log(JSON.stringify({id,attempts,error:String(e)}));}
}
console.log(JSON.stringify({checked:ids.length,failed,readOnly:true}));
process.exitCode=failed?1:0;
