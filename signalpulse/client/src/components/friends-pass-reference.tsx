import React from "react";
import { SHARED_RUNTIME_PASS_REFERENCES } from "@shared/friends-pass-reference";

/** Reference content only. Deliberately independent of leaderboard filters,
 * rows, counts, period estimates and scheduled ingestion.
 */
export function FriendsPassReference() {
  return (
    <details className="rounded-md border border-border bg-muted/20 text-sm"
      data-testid="details-friends-pass-reference">
      <summary className="cursor-pointer px-4 py-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="font-medium">Shared-runtime reference</span>
        <span className="ml-2 text-xs text-muted-foreground">
          {SHARED_RUNTIME_PASS_REFERENCES.length} verified passes · not separately measurable
        </span>
      </summary>
      <div className="px-4 pb-4 space-y-3">
        <p className="text-xs leading-5 text-muted-foreground">
          These free pass packages grant the paid game’s runtime. Public Steam App-ID reviews and player
          counts cannot isolate pass users from paid owners, so we do not derive pass downloads from them.
          This reference adds no leaderboard rows, ranks or totals.
        </p>
        <ul className="divide-y divide-border" aria-label="Shared-runtime pass reference">
          {SHARED_RUNTIME_PASS_REFERENCES.map(pass => (
            <li key={pass.packageId} className="grid gap-3 py-4 first:pt-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]"
              data-testid={`reference-pass-${pass.storeAppId}`}>
              <div className="min-w-0 space-y-1">
                <a href={pass.storeUrl} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                  {pass.name}
                </a>
                <p className="text-xs text-muted-foreground">
                  {pass.listingKind === "base_game_offer" ? "Base-game offer · reference only" : "Separate pass storefront · shared runtime"}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  Runtime App ID {pass.runtimeAppId} · Package {pass.packageId}
                </p>
                {pass.listingKind === "pass_storefront" && <p className="text-xs text-muted-foreground tabular-nums">
                  Pass storefront App ID {pass.storeAppId}
                </p>}
              </div>
              <div className="min-w-0 space-y-2">
                <p className="text-xs leading-5 text-muted-foreground">
                  {pass.listingKind === "base_game_offer"
                    ? "The pass is offered on the paid game’s page, using the same runtime App ID. It is not added to the measured pass catalog."
                    : "The pass has its own store page, but its free package grants the paid game’s runtime. The catalog keeps that pass SKU; unavailable pass metrics stay blank rather than inherit the paid game’s activity."}
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
                  <a href={pass.offerEvidenceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">Steam offer evidence</a>
                  <a href={pass.runtimeEvidenceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">Package-to-runtime evidence</a>
                  <span className="text-muted-foreground">Verified <time dateTime={pass.verifiedOn}>{pass.verifiedOn}</time></span>
                </div>
              </div>
            </li>
          ))}
        </ul>
        <p className="text-xs leading-5 text-muted-foreground">
          Curated US/English reference, verified on the dates shown; not a complete or automatically refreshed
          list of every pass. Table search, genre and period controls do not filter this reference.
          The existing daily collection schedule is unchanged.
        </p>
      </div>
    </details>
  );
}
