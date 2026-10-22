/**
 * Approved own-demo identities. Pure data so read-only operator planning
 * does not initialize writable application storage.
 *
 * Role since 2026-10-22: curated SEED, not the iteration source. Hub
 * discovery now flags Saber demos automatically from the Steam publisher
 * field (isSaberPublisher below), and all Saber collectors iterate
 * demo_titles WHERE is_saber_published=1. Add entries here only for demos
 * that need it: Saber-developed but externally published titles (Toxic
 * Commando), or to pin a parent link/genre/name explicitly. Newly shipped
 * standard Saber demos are picked up by the next discovery pass without a
 * code change.
 */
export interface SaberDemoSeed {
  steamAppId:string;name:string;genre:string;isActive:boolean;parentSteamAppId?:string;
}
export const SABER_DEMO_ROSTER:SaberDemoSeed[]=[
  {steamAppId:"5184670",parentSteamAppId:"1551980",name:"Clive Barker's Hellraiser: Revival Demo",genre:"Action, Adventure",isActive:true},
  {steamAppId:"4010800",parentSteamAppId:"2487300",name:"Docked Demo",genre:"Simulation",isActive:true},
  // Parent verified: https://steamdb.info/app/4354730/info/
  {steamAppId:"4354730",parentSteamAppId:"2157830",name:"John Carpenter's Toxic Commando Demo",genre:"Action",isActive:false},
  {steamAppId:"3462370",name:"The Knightling Demo",genre:"Adventure",isActive:false},
  // Parent verified: https://steamdb.info/app/4010830/
  {steamAppId:"4010830",parentSteamAppId:"2095420",name:"Bus Bound Demo",genre:"Simulation",isActive:false},
  {steamAppId:"4047990",name:"Painkiller Demo",genre:"Action",isActive:false},
  // Released 2026-10-18/19 for Steam Next Fest October 2026. Identity verified
  // via store appdetails (type=demo, publishers=[Saber Interactive],
  // fullgame.appid=2366590); genre is Steam's own string for the demo app.
  {steamAppId:"5102100",parentSteamAppId:"2366590",name:'Rideshare "Stimulator" Demo',genre:"Adventure, Simulation",isActive:true},
];

/**
 * Publisher-based Saber detection for hub discovery (live-verified
 * 2026-10-22: Store Browse basic_info.publishers for the Rideshare demo
 * returns exactly "Saber Interactive"). Steam publisher names are bound to
 * publisher accounts, so a third party cannot claim this name. Saber-
 * developed but externally published demos (Toxic Commando) still need a
 * roster entry above; discovery never downgrades an existing Saber flag.
 */
const SABER_PUBLISHER_NAMES = new Set(["Saber Interactive"]);
// Live-verified 2026-10-22: both Saber-published demos checked (Rideshare
// 5102100, Hellraiser 5184670) return creator_clan_account_id 32513338 --
// the publisher's Steam account id, a stronger identity than the display
// name. A match on either signal classifies as Saber-published.
export const SABER_PUBLISHER_CLAN_ID = 32513338;
export interface StorePublisher {
  name?: string;
  creatorClanAccountId?: number;
}
export function isSaberPublisher(publishers: readonly StorePublisher[]): boolean {
  return publishers.some(p =>
    SABER_PUBLISHER_NAMES.has(p.name ?? "") || p.creatorClanAccountId === SABER_PUBLISHER_CLAN_ID);
}
