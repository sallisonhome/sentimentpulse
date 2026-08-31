import { useMemo, useState } from "react";
import { api } from "../lib/api";
import {
  CONSOLE_BUNDLE_PLATFORMS,
  DIGITAL_KEY_VENDORS,
  INCREMENTAL_REVENUE_SUBTYPES,
  MARKETING_IMPACT,
  MARKETING_PLATFORMS,
  MARKETING_SUBTYPES,
  OPPORTUNITY_STATES,
  PC_HARDWARE_BRANDS,
  RETAIL_PARTNERS,
  RETAIL_TERRITORIES,
  type IncrementalRevenueSubtype,
  type OpportunityState,
} from "@shared/schema";

export type FormMode =
  | { kind: "incremental" }
  | { kind: "retail" }
  | { kind: "collectors" }
  | { kind: "marketing" };

/**
 * A single form modal that handles all four opportunity flows. Conditional
 * dropdowns (Console bundle → PS/XBOX/Switch2, Digital Key → Genba/Fanatical/…,
 * OEM PC → Lenovo/HP/…) are wired here per spec.
 */
export default function OpportunityFormModal({
  mode,
  productId,
  onClose,
  onSaved,
}: {
  mode: FormMode;
  productId: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
    >
      <div
        className="card w-full max-w-lg max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="px-5 py-3 border-b flex items-center justify-between"
          style={{ borderColor: "var(--border)" }}
        >
          <h2 className="text-sm font-semibold uppercase tracking-wider">
            {titleFor(mode)}
          </h2>
          <button
            className="text-sm"
            style={{ color: "var(--text-muted)" }}
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="p-5">
          {mode.kind === "incremental" && (
            <IncrementalForm productId={productId} onSaved={onSaved} />
          )}
          {mode.kind === "retail" && (
            <RetailForm productId={productId} onSaved={onSaved} />
          )}
          {mode.kind === "collectors" && (
            <CollectorsForm productId={productId} onSaved={onSaved} />
          )}
          {mode.kind === "marketing" && (
            <MarketingForm productId={productId} onSaved={onSaved} />
          )}
        </div>
      </div>
    </div>
  );
}

function titleFor(m: FormMode) {
  return {
    incremental: "Add Incremental Revenue Opportunity",
    retail: "Add Physical Retail Partner",
    collectors: "Add Collector's Edition",
    marketing: "Add Marketing Opportunity",
  }[m.kind];
}

/* ─── Incremental Revenue ─────────────────────────────────────────────────── */

function IncrementalForm({
  productId,
  onSaved,
}: {
  productId: number;
  onSaved: () => void;
}) {
  const [state, setState] = useState<OpportunityState>("In Negotiation");
  const [subtype, setSubtype] = useState<IncrementalRevenueSubtype>(
    "Digital Key Sales",
  );
  const [revenue, setRevenue] = useState<string>("");
  const [details, setDetails] = useState("");
  // Conditional dropdown selection (Console bundle platform, Digital Key vendor,
  // OEM PC brand) — kept in a single string so the form is simple.
  const [conditional, setConditional] = useState<string>("");
  const [conditionalOther, setConditionalOther] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const conditionalConfig = useMemo(() => conditionalFor(subtype), [subtype]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      await api.createOpportunity({
        productId,
        bucket: "IncrementalRevenue",
        subtype,
        category: "Revenue",
        state,
        revenueUsd: revenue ? Number(revenue) : null,
        details: details || null,
        extra: JSON.stringify({
          conditionalSelection: conditional || null,
          conditionalOther: conditional === "Other" ? conditionalOther : null,
        }),
      });
      onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Subtype">
        <select
          className="select"
          value={subtype}
          onChange={(e) => {
            setSubtype(e.target.value as IncrementalRevenueSubtype);
            setConditional("");
          }}
        >
          {INCREMENTAL_REVENUE_SUBTYPES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </Field>

      {conditionalConfig && (
        <Field label={conditionalConfig.label}>
          <select
            className="select"
            value={conditional}
            onChange={(e) => setConditional(e.target.value)}
          >
            <option value="">Select…</option>
            {conditionalConfig.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          {conditional === "Other" && (
            <input
              className="input mt-2"
              placeholder="Other (please specify)"
              value={conditionalOther}
              onChange={(e) => setConditionalOther(e.target.value)}
            />
          )}
        </Field>
      )}

      <Field label="State">
        <StateToggle value={state} onChange={setState} />
      </Field>
      <Field label="Revenue value ($)">
        <input
          type="number"
          className="input"
          value={revenue}
          onChange={(e) => setRevenue(e.target.value)}
          placeholder="e.g. 250000"
          min={0}
        />
      </Field>
      <Field label="Details / notes">
        <textarea
          className="textarea"
          rows={3}
          value={details}
          onChange={(e) => setDetails(e.target.value)}
        />
      </Field>

      {err && <div className="text-sm" style={{ color: "var(--danger)" }}>{err}</div>}
      <div className="flex justify-end gap-2">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? "Saving…" : "Save opportunity"}
        </button>
      </div>
    </form>
  );
}

function conditionalFor(
  subtype: IncrementalRevenueSubtype,
): { label: string; options: readonly string[] } | null {
  if (subtype === "Hardware Bundle — Console")
    return { label: "Console", options: CONSOLE_BUNDLE_PLATFORMS };
  if (subtype === "OEM Hardware Bundle — PC Hardware")
    return { label: "OEM brand", options: PC_HARDWARE_BRANDS };
  if (subtype === "Digital Key Sales")
    return { label: "Key vendor", options: DIGITAL_KEY_VENDORS };
  if (subtype === "Cloud — Other")
    return { label: "Cloud vendor (other)", options: ["Other"] };
  return null;
}

/* ─── Physical Retail Partner ────────────────────────────────────────────── */

function RetailForm({
  productId,
  onSaved,
}: {
  productId: number;
  onSaved: () => void;
}) {
  const [state, setState] = useState<OpportunityState>("In Negotiation");
  const [partnerName, setPartnerName] = useState<string>(RETAIL_PARTNERS[0]);
  const [partnerNameOther, setPartnerNameOther] = useState("");
  const [territories, setTerritories] = useState<string[]>([]);
  const [otherCountries, setOtherCountries] = useState<string>("");
  const [mg, setMg] = useState("");
  const [royalty, setRoyalty] = useState("");
  const [details, setDetails] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function toggleTerritory(t: string) {
    setTerritories((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      await api.createRetailPartner({
        productId,
        partnerName,
        partnerNameOther: partnerName === "Other" ? partnerNameOther : null,
        territoriesJson: JSON.stringify(territories),
        territoryOtherCountriesJson: territories.includes("Other")
          ? JSON.stringify(
              otherCountries.split(",").map((s) => s.trim()).filter(Boolean),
            )
          : null,
        mgAmountUsd: mg ? Number(mg) : 0,
        royaltyPctNet: royalty ? Number(royalty) : 0,
        state,
        details: details || null,
      });
      onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Partner">
        <select
          className="select"
          value={partnerName}
          onChange={(e) => setPartnerName(e.target.value)}
        >
          {RETAIL_PARTNERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {partnerName === "Other" && (
          <input
            className="input mt-2"
            placeholder="Partner name"
            value={partnerNameOther}
            onChange={(e) => setPartnerNameOther(e.target.value)}
          />
        )}
      </Field>

      <Field label="Territories">
        <div className="flex flex-wrap gap-2">
          {RETAIL_TERRITORIES.map((t) => {
            const active = territories.includes(t);
            return (
              <button
                type="button"
                key={t}
                className="rounded-md px-2.5 py-1 text-xs font-medium"
                style={{
                  background: active ? "var(--accent)" : "var(--surface-2)",
                  color: active ? "#0a0c10" : "var(--text)",
                  border: "1px solid var(--border)",
                }}
                onClick={() => toggleTerritory(t)}
              >
                {t}
              </button>
            );
          })}
        </div>
        {territories.includes("Other") && (
          <input
            className="input mt-2"
            placeholder="Other countries (comma separated)"
            value={otherCountries}
            onChange={(e) => setOtherCountries(e.target.value)}
          />
        )}
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="MG amount ($)">
          <input
            type="number"
            className="input"
            value={mg}
            onChange={(e) => setMg(e.target.value)}
            min={0}
          />
        </Field>
        <Field label="Royalty % on net">
          <input
            type="number"
            step="0.1"
            className="input"
            value={royalty}
            onChange={(e) => setRoyalty(e.target.value)}
            min={0}
            max={100}
          />
        </Field>
      </div>

      <Field label="State">
        <StateToggle value={state} onChange={setState} />
      </Field>
      <Field label="Details / notes">
        <textarea
          className="textarea"
          rows={3}
          value={details}
          onChange={(e) => setDetails(e.target.value)}
        />
      </Field>

      {err && <div className="text-sm" style={{ color: "var(--danger)" }}>{err}</div>}
      <div className="flex justify-end gap-2">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? "Saving…" : "Save partner"}
        </button>
      </div>
    </form>
  );
}

/* ─── Collector's Edition (shell) ─────────────────────────────────────────── */
// The +Item widget lives in CollectorsEditionPanel; this form just creates
// the parent opportunity with vendor + MG. Items are added after in the panel.

function CollectorsForm({
  productId,
  onSaved,
}: {
  productId: number;
  onSaved: () => void;
}) {
  const [state, setState] = useState<OpportunityState>("In Negotiation");
  const [vendor, setVendor] = useState("");
  const [mg, setMg] = useState("");
  const [details, setDetails] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      await api.createOpportunity({
        productId,
        bucket: "CollectorsEdition",
        subtype: vendor || "Physical Collector's Edition",
        category: "Revenue",
        state,
        revenueUsd: mg ? Number(mg) : null,
        details: details || null,
        extra: JSON.stringify({ vendor: vendor || null }),
      });
      onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Vendor / manufacturer">
        <input
          className="input"
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
          placeholder="e.g. Limited Run, Fangamer"
        />
      </Field>
      <Field label="MG amount ($)">
        <input
          type="number"
          className="input"
          value={mg}
          onChange={(e) => setMg(e.target.value)}
          min={0}
        />
      </Field>
      <Field label="State">
        <StateToggle value={state} onChange={setState} />
      </Field>
      <Field label="Notes">
        <textarea
          className="textarea"
          rows={3}
          value={details}
          onChange={(e) => setDetails(e.target.value)}
        />
      </Field>
      <p className="text-xs" style={{ color: "var(--text-dim)" }}>
        After saving, add the specific items (statue, art book, steel case) from
        the Collectors Editions quadrant on the title page. Work-back date
        (release − 12 months) shows there automatically.
      </p>
      {err && <div className="text-sm" style={{ color: "var(--danger)" }}>{err}</div>}
      <div className="flex justify-end gap-2">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

/* ─── Marketing Opportunity ──────────────────────────────────────────────── */

function MarketingForm({
  productId,
  onSaved,
}: {
  productId: number;
  onSaved: () => void;
}) {
  const [state, setState] = useState<OpportunityState>("In Negotiation");
  const [subtype, setSubtype] = useState<string>(MARKETING_SUBTYPES[0]);
  const [subtypeOther, setSubtypeOther] = useState("");
  const [platform, setPlatform] = useState<string>(MARKETING_PLATFORMS[0]);
  const [impact, setImpact] = useState<string>("Medium");
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [valueUsd, setValueUsd] = useState("");
  const [reach, setReach] = useState("");
  const [details, setDetails] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      await api.createOpportunity({
        productId,
        bucket: "MarketingOpportunity",
        subtype: subtype === "Other" && subtypeOther ? subtypeOther : subtype,
        category: "Marketing",
        state,
        marketingName: name || null,
        marketingPlatform: platform,
        marketingStartDate: startDate || null,
        marketingEndDate: endDate || null,
        marketingValueUsd: valueUsd ? Number(valueUsd) : null,
        marketingReach: reach ? Number(reach) : null,
        marketingImpact: impact as "Small" | "Medium" | "Large",
        details: details || null,
      });
      onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Type of beat">
        <select
          className="select"
          value={subtype}
          onChange={(e) => setSubtype(e.target.value)}
        >
          {MARKETING_SUBTYPES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {subtype === "Other" && (
          <input
            className="input mt-2"
            placeholder="Describe the beat"
            value={subtypeOther}
            onChange={(e) => setSubtypeOther(e.target.value)}
          />
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Platform / storefront">
          <select
            className="select"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          >
            {MARKETING_PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Impact">
          <select
            className="select"
            value={impact}
            onChange={(e) => setImpact(e.target.value)}
          >
            {MARKETING_IMPACT.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Name / slug (optional)">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Aug State of Play — trailer slot"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start date">
          <input
            type="date"
            className="input"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </Field>
        <Field label="End date (optional)">
          <input
            type="date"
            className="input"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="In-kind value ($)">
          <input
            type="number"
            className="input"
            value={valueUsd}
            onChange={(e) => setValueUsd(e.target.value)}
            min={0}
          />
        </Field>
        <Field label="Reach / impressions">
          <input
            type="number"
            className="input"
            value={reach}
            onChange={(e) => setReach(e.target.value)}
            min={0}
          />
        </Field>
      </div>
      <Field label="State">
        <StateToggle value={state} onChange={setState} />
      </Field>
      <Field label="Details / notes">
        <textarea
          className="textarea"
          rows={3}
          value={details}
          onChange={(e) => setDetails(e.target.value)}
        />
      </Field>
      {err && <div className="text-sm" style={{ color: "var(--danger)" }}>{err}</div>}
      <div className="flex justify-end gap-2">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? "Saving…" : "Save opportunity"}
        </button>
      </div>
    </form>
  );
}

/* ─── Small primitives ───────────────────────────────────────────────────── */

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="label mb-1">{label}</div>
      {children}
    </div>
  );
}

function StateToggle({
  value,
  onChange,
}: {
  value: OpportunityState;
  onChange: (v: OpportunityState) => void;
}) {
  return (
    <div className="flex gap-2">
      {OPPORTUNITY_STATES.map((s) => (
        <button
          type="button"
          key={s}
          className="flex-1 rounded-md px-3 py-1.5 text-sm font-medium"
          style={{
            background:
              value === s
                ? s === "Secured"
                  ? "var(--secured-bg)"
                  : "var(--discussion-bg)"
                : "var(--surface-2)",
            color:
              value === s
                ? s === "Secured"
                  ? "var(--secured)"
                  : "var(--discussion)"
                : "var(--text-muted)",
            border: "1px solid var(--border)",
          }}
          onClick={() => onChange(s)}
        >
          {s}
        </button>
      ))}
    </div>
  );
}
