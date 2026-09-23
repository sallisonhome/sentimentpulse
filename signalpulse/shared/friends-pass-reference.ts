/**
 * Curated reference, NOT an ingestion roster or estimate input.
 * appdetails.package_groups verifies the free pass offer; packagedetails.apps
 * verifies that it grants the paid game's runtime. Checked 2026-09-22.
 * No metric fields: public App-ID totals cannot isolate the pass population.
 */
export interface SharedRuntimePassReference {
  name: string;
  storeAppId: string;
  runtimeAppId: string;
  packageId: string;
  listingKind: "base_game_offer" | "pass_storefront";
  storeUrl: string;
  offerEvidenceUrl: string;
  runtimeEvidenceUrl: string;
  verifiedOn: string;
}

export const SHARED_RUNTIME_PASS_REFERENCES: readonly SharedRuntimePassReference[] = [
  {
    name: "Eyes of Hellfire",
    storeAppId: "3951790", runtimeAppId: "1724030", packageId: "1396319",
    listingKind: "pass_storefront",
    storeUrl: "https://store.steampowered.com/app/3951790/Eyes_of_Hellfire_Friends_Pass/",
    offerEvidenceUrl: "https://store.steampowered.com/api/appdetails?appids=3951790&cc=US&l=english",
    runtimeEvidenceUrl: "https://store.steampowered.com/api/packagedetails?packageids=1396319&cc=US&l=english",
    verifiedOn: "2026-09-22",
  },
  {
    name: "LEGO Voyagers",
    storeAppId: "1538550", runtimeAppId: "1538550", packageId: "1308601",
    listingKind: "base_game_offer",
    storeUrl: "https://store.steampowered.com/app/1538550/LEGO_Voyagers/",
    offerEvidenceUrl: "https://store.steampowered.com/api/appdetails?appids=1538550&cc=US&l=english",
    runtimeEvidenceUrl: "https://store.steampowered.com/api/packagedetails?packageids=1308601&cc=US&l=english",
    verifiedOn: "2026-09-22",
  },
  {
    name: "Lords of the Fallen",
    storeAppId: "3664720", runtimeAppId: "1501750", packageId: "1267389",
    listingKind: "pass_storefront",
    storeUrl: "https://store.steampowered.com/app/3664720/Lords_of_the_Fallen__Free_Friends_Pass/",
    offerEvidenceUrl: "https://store.steampowered.com/api/appdetails?appids=3664720&cc=US&l=english",
    runtimeEvidenceUrl: "https://store.steampowered.com/api/packagedetails?packageids=1267389&cc=US&l=english",
    verifiedOn: "2026-09-22",
  },
  {
    name: "REANIMAL",
    storeAppId: "2129530", runtimeAppId: "2129530", packageId: "1545529",
    listingKind: "base_game_offer",
    storeUrl: "https://store.steampowered.com/app/2129530/REANIMAL/",
    offerEvidenceUrl: "https://store.steampowered.com/api/appdetails?appids=2129530&cc=US&l=english",
    runtimeEvidenceUrl: "https://store.steampowered.com/api/packagedetails?packageids=1545529&cc=US&l=english",
    verifiedOn: "2026-09-22",
  },
  {
    name: "Split Fiction",
    storeAppId: "3052150", runtimeAppId: "2001120", packageId: "1084787",
    listingKind: "pass_storefront",
    storeUrl: "https://store.steampowered.com/app/3052150/Split_Fiction__Friends_Pass/",
    offerEvidenceUrl: "https://store.steampowered.com/api/appdetails?appids=3052150&cc=US&l=english",
    runtimeEvidenceUrl: "https://store.steampowered.com/api/packagedetails?packageids=1084787&cc=US&l=english",
    verifiedOn: "2026-09-22",
  },
];
