import {test} from "node:test";
import assert from "node:assert/strict";
import {xboxBundledSaleEvidence} from "./sales-catalog-eligibility";
const name="EA SPORTS FC™ 26 Xbox Series X|S",sku="9P9FTXPKQ35P";
const child={Product:{ProductId:sku,ProductType:"Game",LocalizedProperties:[{ProductTitle:name}],
  Properties:{XboxConsoleGenCompatible:["ConsoleGen9"]},
  MarketProperties:[{OriginalReleaseDate:"9998-12-30T00:00:00Z"}]}};
const parent={Product:{ProductId:"9MXZBTLG26VX",ProductType:"Game",
  LocalizedProperties:[{ProductTitle:"EA SPORTS FC™ 26 Standard Edition Xbox One & Xbox Series X|S"}],
  Properties:{XboxConsoleGenCompatible:["ConsoleGen8","ConsoleGen9"]},
  MarketProperties:[{OriginalReleaseDate:"2025-09-26T04:00:00Z"}],
  DisplaySkuAvailabilities:[{Sku:{SkuType:"full",Properties:{IsBundle:true,IsPreOrder:false,
    BundledSkus:[{BigId:sku,IsPrimary:true}]}},
    Availabilities:[{Actions:["Purchase"],Conditions:{StartDate:"2026-07-21T10:00:00Z",EndDate:"2599-12-30T23:59:59Z"},
      OrderManagementData:{Price:{CurrencyCode:"USD",MSRP:69.99}}}]}]}};
const now=new Date("2026-09-26T12:00:00Z");
test("exact standard-bundle membership repairs child eligibility, not its rating identity",()=>{
  const e=xboxBundledSaleEvidence(child,parent,sku,name,now);
  assert.equal(e.eligible,true);assert.equal(e.sku,sku);assert.equal(e.msrpUsdCents,6999);
  assert.equal(e.released,"2025-09-26");assert.equal(e.subscriptionIncluded,true);
  assert.equal(e.retailParentSku,"9MXZBTLG26VX");
});
test("wrong product, other family, missing membership, trial, preorder and license-only cannot qualify",()=>{
  const mutations=[
    (p:any)=>p.ProductId="WRONG",
    (p:any)=>p.LocalizedProperties[0].ProductTitle="EA SPORTS FC™ 27 Standard Edition",
    (p:any)=>p.DisplaySkuAvailabilities[0].Sku.Properties.BundledSkus=[],
    (p:any)=>p.DisplaySkuAvailabilities[0].Sku.Properties.IsTrial=true,
    (p:any)=>p.DisplaySkuAvailabilities[0].Sku.Properties.IsPreOrder=true,
    (p:any)=>p.DisplaySkuAvailabilities[0].Availabilities[0].Actions=["License"],
    (p:any)=>p.DisplaySkuAvailabilities[0].Availabilities[0].OrderManagementData.Price.CurrencyCode="GBP",
    (p:any)=>p.MarketProperties[0].OriginalReleaseDate="2027-01-01",
  ];
  for(const mutate of mutations){const p=structuredClone(parent);mutate(p.Product);
    assert.equal(xboxBundledSaleEvidence(child,p,sku,name,now).eligible,false);}
  assert.equal(xboxBundledSaleEvidence(child,parent,sku,"Control Resonant",now).eligible,false);
});
