import { db } from "./db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  opportunities,
  physicalRetailPartners,
  collectorsEditionItems,
  opportunityAuditLog,
  type InsertOpportunity,
  type InsertPhysicalRetailPartner,
  type InsertCollectorsEditionItem,
  type Opportunity,
  type PhysicalRetailPartner,
  type CollectorsEditionItem,
} from "@shared/schema";

const now = () => new Date().toISOString();

// ─── Opportunities ───────────────────────────────────────────────────────────

export function listOpportunities(productId?: number): Opportunity[] {
  const where = productId != null
    ? and(eq(opportunities.productId, productId), isNull(opportunities.flaggedRemovedAt))
    : isNull(opportunities.flaggedRemovedAt);
  return db.select().from(opportunities).where(where).orderBy(desc(opportunities.createdAt)).all();
}

export function listAllOpportunities(): Opportunity[] {
  return db
    .select()
    .from(opportunities)
    .where(isNull(opportunities.flaggedRemovedAt))
    .all();
}

export function createOpportunity(input: InsertOpportunity): Opportunity {
  const row = {
    ...input,
    id: nanoid(12),
    createdAt: now(),
    updatedAt: now(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.insert(opportunities).values(row as any).run();
  audit("opportunity", row.id, "create", null, row.state, row);
  return row as Opportunity;
}

export function updateOpportunity(
  id: string,
  patch: Partial<InsertOpportunity>,
): Opportunity | null {
  const existing = db.select().from(opportunities).where(eq(opportunities.id, id)).get();
  if (!existing) return null;
  const updated = { ...existing, ...patch, updatedAt: now() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.update(opportunities).set(updated as any).where(eq(opportunities.id, id)).run();
  audit(
    "opportunity",
    id,
    existing.state !== updated.state ? "state_change" : "update",
    existing.state,
    updated.state,
    patch,
  );
  return updated as Opportunity;
}

export function flagOpportunityRemoved(
  id: string,
  reason: string,
  actor?: string,
): Opportunity | null {
  const existing = db.select().from(opportunities).where(eq(opportunities.id, id)).get();
  if (!existing) return null;
  const updated = {
    ...existing,
    flaggedRemovedAt: now(),
    flaggedReason: reason,
    updatedBy: actor ?? existing.updatedBy,
    updatedAt: now(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.update(opportunities).set(updated as any).where(eq(opportunities.id, id)).run();
  audit("opportunity", id, "flag_removed", existing.state, existing.state, { reason });
  return updated as Opportunity;
}

// ─── Physical Retail Partners ────────────────────────────────────────────────

export function listRetailPartners(productId?: number): PhysicalRetailPartner[] {
  const where = productId != null
    ? and(eq(physicalRetailPartners.productId, productId), isNull(physicalRetailPartners.flaggedRemovedAt))
    : isNull(physicalRetailPartners.flaggedRemovedAt);
  return db
    .select()
    .from(physicalRetailPartners)
    .where(where)
    .orderBy(desc(physicalRetailPartners.createdAt))
    .all();
}

export function createRetailPartner(
  input: InsertPhysicalRetailPartner,
): PhysicalRetailPartner {
  const row = {
    ...input,
    id: nanoid(12),
    createdAt: now(),
    updatedAt: now(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.insert(physicalRetailPartners).values(row as any).run();
  audit("retail_partner", row.id, "create", null, row.state, row);
  return row as PhysicalRetailPartner;
}

export function updateRetailPartner(
  id: string,
  patch: Partial<InsertPhysicalRetailPartner>,
): PhysicalRetailPartner | null {
  const existing = db
    .select()
    .from(physicalRetailPartners)
    .where(eq(physicalRetailPartners.id, id))
    .get();
  if (!existing) return null;
  const updated = { ...existing, ...patch, updatedAt: now() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.update(physicalRetailPartners).set(updated as any).where(eq(physicalRetailPartners.id, id)).run();
  audit(
    "retail_partner",
    id,
    existing.state !== updated.state ? "state_change" : "update",
    existing.state,
    updated.state,
    patch,
  );
  return updated as PhysicalRetailPartner;
}

export function flagRetailPartnerRemoved(
  id: string,
  reason: string,
): PhysicalRetailPartner | null {
  const existing = db
    .select()
    .from(physicalRetailPartners)
    .where(eq(physicalRetailPartners.id, id))
    .get();
  if (!existing) return null;
  const updated = {
    ...existing,
    flaggedRemovedAt: now(),
    flaggedReason: reason,
    updatedAt: now(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db.update(physicalRetailPartners).set(updated as any).where(eq(physicalRetailPartners.id, id)).run();
  audit("retail_partner", id, "flag_removed", existing.state, existing.state, { reason });
  return updated as PhysicalRetailPartner;
}

// ─── Collectors Edition Items ────────────────────────────────────────────────

export function listCEItems(productId?: number): CollectorsEditionItem[] {
  const where = productId != null ? eq(collectorsEditionItems.productId, productId) : undefined;
  const q = db.select().from(collectorsEditionItems);
  const withWhere = where ? q.where(where) : q;
  return withWhere.orderBy(desc(collectorsEditionItems.createdAt)).all();
}

export function createCEItem(input: InsertCollectorsEditionItem): CollectorsEditionItem {
  const row = {
    ...input,
    id: nanoid(12),
    createdAt: now(),
  };
  db.insert(collectorsEditionItems).values(row).run();
  audit("ce_item", row.id, "create", null, null, row);
  return row as CollectorsEditionItem;
}

export function deleteCEItem(id: string): boolean {
  const existing = db
    .select()
    .from(collectorsEditionItems)
    .where(eq(collectorsEditionItems.id, id))
    .get();
  if (!existing) return false;
  db.delete(collectorsEditionItems).where(eq(collectorsEditionItems.id, id)).run();
  audit("ce_item", id, "flag_removed", null, null, existing);
  return true;
}

// ─── Audit helper ────────────────────────────────────────────────────────────

function audit(
  entityType: string,
  entityId: string,
  action: string,
  fromState: string | null,
  toState: string | null,
  changes: unknown,
): void {
  db.insert(opportunityAuditLog)
    .values({
      id: nanoid(16),
      entityType,
      entityId,
      action,
      fromState,
      toState,
      changesJson: JSON.stringify(changes ?? null),
      actor: null, // filled by saber-auth PR
      createdAt: now(),
    })
    .run();
}
