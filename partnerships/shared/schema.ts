/**
 * Partnerships shared schema.
 *
 * PR 3 (schema + SignalPulse sync) will add real Drizzle tables here:
 *
 *   - titles_view                — read-only projection from SignalPulse
 *                                  (name, platforms, release_date, launch_msrp)
 *   - opportunities              — top-level opportunity row
 *   - physical_retail_partners   — many per title
 *   - collectors_edition_items   — many per title
 *   - opportunity_audit_log      — soft-delete + state-change history
 *
 * Shared enums (state, category, incremental-revenue subtype, marketing
 * subtype, marketing impact, retail partner name, PC hardware brand,
 * digital key vendor, territory) live here so both server and client can
 * import them from `@shared/schema`.
 *
 * This file is intentionally empty in the scaffold PR so drizzle-kit doesn't
 * try to migrate anything before the schema is designed.
 */

export {};
