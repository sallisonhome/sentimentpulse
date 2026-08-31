import type { Express, Request, Response } from "express";
import express from "express";
import { z } from "zod";
import {
  insertOpportunitySchema,
  insertRetailPartnerSchema,
  insertCEItemSchema,
} from "@shared/schema";
import {
  createOpportunity,
  updateOpportunity,
  flagOpportunityRemoved,
  listOpportunities,
  createRetailPartner,
  updateRetailPartner,
  flagRetailPartnerRemoved,
  listRetailPartners,
  createCEItem,
  deleteCEItem,
  listCEItems,
} from "./storage";
import { listTitles, getTitle } from "./signalpulse-read";
import { buildDashboard, buildPdp } from "./rollups";

export function registerRoutes(app: Express): void {
  app.use(express.json({ limit: "1mb" }));

  // ─── Health ────────────────────────────────────────────────────────────────
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, app: "partnerships", version: "0.2.0" });
  });

  // ─── Titles (read-only projection of SignalPulse products) ─────────────────
  app.get("/api/titles", (_req, res) => {
    res.json(listTitles());
  });

  app.get("/api/titles/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    const t = getTitle(id);
    if (!t) return res.status(404).json({ error: "title not found" });
    res.json(t);
  });

  // ─── Dashboard rollup ──────────────────────────────────────────────────────
  app.get("/api/dashboard", (_req, res) => {
    res.json(buildDashboard());
  });

  // ─── PDP payload ───────────────────────────────────────────────────────────
  app.get("/api/pdp/:productId", (req, res) => {
    const id = Number(req.params.productId);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });
    const payload = buildPdp(id);
    if (!payload) return res.status(404).json({ error: "title not found" });
    res.json(payload);
  });

  // ─── Opportunities ─────────────────────────────────────────────────────────
  app.get("/api/opportunities", (req, res) => {
    const productId = req.query.productId ? Number(req.query.productId) : undefined;
    res.json(listOpportunities(productId));
  });

  app.post("/api/opportunities", (req, res) => {
    const parsed = insertOpportunitySchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    res.status(201).json(createOpportunity(parsed.data));
  });

  app.patch("/api/opportunities/:id", (req, res) => {
    const parsed = insertOpportunitySchema.partial().safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    const out = updateOpportunity(req.params.id, parsed.data);
    if (!out) return res.status(404).json({ error: "not found" });
    res.json(out);
  });

  app.delete("/api/opportunities/:id", (req, res) => {
    const reason = String(req.body?.reason ?? "").slice(0, 500);
    const out = flagOpportunityRemoved(req.params.id, reason);
    if (!out) return res.status(404).json({ error: "not found" });
    res.json(out);
  });

  // ─── Physical Retail Partners ──────────────────────────────────────────────
  app.get("/api/retail-partners", (req, res) => {
    const productId = req.query.productId ? Number(req.query.productId) : undefined;
    res.json(listRetailPartners(productId));
  });

  app.post("/api/retail-partners", (req, res) => {
    const parsed = insertRetailPartnerSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    res.status(201).json(createRetailPartner(parsed.data));
  });

  app.patch("/api/retail-partners/:id", (req, res) => {
    const parsed = insertRetailPartnerSchema.partial().safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    const out = updateRetailPartner(req.params.id, parsed.data);
    if (!out) return res.status(404).json({ error: "not found" });
    res.json(out);
  });

  app.delete("/api/retail-partners/:id", (req, res) => {
    const reason = String(req.body?.reason ?? "").slice(0, 500);
    const out = flagRetailPartnerRemoved(req.params.id, reason);
    if (!out) return res.status(404).json({ error: "not found" });
    res.json(out);
  });

  // ─── Collectors Edition items ──────────────────────────────────────────────
  app.get("/api/ce-items", (req, res) => {
    const productId = req.query.productId ? Number(req.query.productId) : undefined;
    res.json(listCEItems(productId));
  });

  app.post("/api/ce-items", (req, res) => {
    const parsed = insertCEItemSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    res.status(201).json(createCEItem(parsed.data));
  });

  app.delete("/api/ce-items/:id", (req, res) => {
    const ok = deleteCEItem(req.params.id);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.status(204).end();
  });
}

function badRequest(res: Response, err: z.ZodError) {
  res.status(400).json({ error: "validation_error", details: err.flatten() });
}
