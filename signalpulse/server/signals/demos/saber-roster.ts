/** Approved own-demo identities. Pure data so read-only operator planning
 * does not initialize writable application storage. */
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
];
