import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { PageHeader } from "../components/PageHeader";
import { Spinner, ErrorBox } from "../components/EmptyState";
import { api } from "../lib/api";
import { useDeckTheme } from "../lib/theme";
import type { FormInputs, GameType, InnerRing, Platform, ThreatLevel, Theme } from "../lib/types";

const STEPS = [
  { id: 1, label: "Theme" },
  { id: 2, label: "Game" },
  { id: 3, label: "Cohorts · USPs · Reach" },
  { id: 4, label: "Release date" },
  { id: 5, label: "Commercial potential" },
  { id: 6, label: "Commercial risks" },
  { id: 7, label: "Description & razors" },
];
const LAST_STEP = STEPS.length; // 7

const ALL_PLATFORMS: Platform[] = ["PC", "PS5", "XSX", "SWITCH2"];
const THREAT_LEVELS: ThreatLevel[] = ["critical", "high", "medium", "low"];

const DRAFT_KEY = "gtm:new:draft:v1";

function emptyInputs(): FormInputs {
  return {
    title: "",
    genre: "",
    game_type: "sequel",
    inner: "prev",
    release_date: "",
    cohorts: [
      { name: "", size: 0 },
      { name: "", size: 0 },
      { name: "", size: 0 },
      { name: "", size: 0 },
    ],

    // --- Step 5: Median Commercial Potential ---
    // median_revenue_usd_millions is MILLIONS of dollars (e.g. 4.7 = $4.7M).
    // avg_price_usd is PLAIN dollars. median_units_sold is a raw integer
    // count. Never scale these in the UI -- send exactly what's entered.
    comp_set_name: "",
    median_revenue_usd_millions: 0,
    avg_price_usd: 0,
    median_units_sold: 0,
    avg_hours_played: 0,
    platforms: ["PC", "PS5", "XSX", "SWITCH2"],

    usps: [
      { title: "", description: "", proof: "", strategy: "", enabled: true },
      { title: "", description: "", proof: "", strategy: "", enabled: true },
      { title: "", description: "", proof: "", strategy: "", enabled: true },
    ],
    reach: [
      { cohort: "", channel: "", message: "", kpi: "" },
      { cohort: "", channel: "", message: "", kpi: "" },
      { cohort: "", channel: "", message: "", kpi: "" },
      { cohort: "", channel: "", message: "", kpi: "" },
    ],

    // --- Step 6: Commercial Risks ---
    risks: [
      { threat_level: "high", proof: "", mitigation: "" },
    ],
    risks_wedge: "",
    risks_wedge_support: "",

    // --- Step 7: Description & Razors ---
    description_100: "",
    razor_20: "",
    razor_10: "",
  };
}

export function NewWizard() {
  const [, setLoc] = useLocation();
  const { deckTheme, setDeckTheme } = useDeckTheme();

  const [step, setStep] = useState<number>(() => {
    const sp = new URLSearchParams(window.location.hash.split("?")[1] || "");
    const s = parseInt(sp.get("step") || "1", 10);
    return Math.min(Math.max(s, 1), LAST_STEP);
  });
  const [inputs, setInputs] = useState<FormInputs>(emptyInputs);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Handle ?clone=… from Library
  useEffect(() => {
    const sp = new URLSearchParams(window.location.hash.split("?")[1] || "");
    const c = sp.get("clone");
    if (c) {
      try {
        const parsed = JSON.parse(decodeURIComponent(c));
        if (parsed.theme) setDeckTheme(parsed.theme as Theme);
        if (parsed.inputs) setInputs({ ...emptyInputs(), ...parsed.inputs });
      } catch {}
    }
  }, []);

  function update<K extends keyof FormInputs>(k: K, v: FormInputs[K]) {
    setInputs((prev) => ({ ...prev, [k]: v }));
  }

  function goStep(n: number) {
    const next = Math.min(Math.max(n, 1), LAST_STEP);
    setStep(next);
    const hash = window.location.hash.split("?")[0] || "#/new";
    window.history.replaceState(null, "", `${hash}?step=${next}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function saveDraft() {
    try {
      localStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ inputs, theme: deckTheme })
      );
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e: any) {
      setErr("Could not save draft: " + String(e.message || e));
    }
  }
  function loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed.theme) setDeckTheme(parsed.theme);
      if (parsed.inputs) setInputs({ ...emptyInputs(), ...parsed.inputs });
    } catch {}
  }

  async function generatePreview() {
    setErr(null);
    setSubmitting(true);
    try {
      const r = await api.preview({ inputs, theme: deckTheme });
      setLoc(`/preview/${r.session_id}`);
    } catch (e: any) {
      setErr(String(e.message || e));
      setSubmitting(false);
    }
  }

  const stepValid = useMemo(() => isStepValid(step, inputs), [step, inputs]);

  return (
    <div>
      <PageHeader
        eyebrow="New slide pack"
        title="Build a GTM pack in four steps"
        subtitle="Each step shapes one section of the 12-slide deck. You can navigate back at any time — your progress is held in the URL."
        actions={
          <>
            <button className="btn-ghost" onClick={loadDraft} data-testid="button-load-draft">
              Load draft
            </button>
            <button className="btn-secondary" onClick={saveDraft} data-testid="button-save-draft">
              Save draft{savedAt ? ` · ${savedAt}` : ""}
            </button>
          </>
        }
      />

      <Stepper step={step} onJump={goStep} />

      <div className="card p-6 md:p-8">
        {step === 1 && <StepTheme inputs={inputs} update={update} />}
        {step === 2 && <StepGame inputs={inputs} update={update} />}
        {step === 3 && <StepCohorts inputs={inputs} update={update} setInputs={setInputs} />}
        {step === 4 && <StepDate inputs={inputs} update={update} />}
        {step === 5 && <StepCommercialPotential inputs={inputs} update={update} setInputs={setInputs} />}
        {step === 6 && <StepCommercialRisks inputs={inputs} update={update} setInputs={setInputs} />}
        {step === 7 && <StepDescriptionRazors inputs={inputs} update={update} />}

        {err && (
          <div className="mt-6">
            <ErrorBox message={err} />
          </div>
        )}

        <div className="mt-8 pt-6 border-t border-border flex items-center justify-between gap-3">
          <button
            className="btn-ghost"
            onClick={() => goStep(step - 1)}
            disabled={step === 1}
            data-testid="button-prev-step"
          >
            ← Back
          </button>
          <div className="text-xs text-dim">
            Step {step} of {LAST_STEP}
            {!stepValid && <span className="text-red-300"> · please complete required fields</span>}
          </div>
          {step < LAST_STEP ? (
            <button
              className="btn-primary"
              onClick={() => goStep(step + 1)}
              disabled={!stepValid}
              data-testid="button-next-step"
            >
              Next →
            </button>
          ) : (
            <button
              className="btn-primary"
              onClick={generatePreview}
              disabled={!stepValid || submitting}
              data-testid="button-generate-preview"
            >
              {submitting ? "Generating…" : "Generate preview"}
            </button>
          )}
        </div>
      </div>

      <div className="mt-6 text-xs text-dim flex items-center gap-2">
        <Link href="/" className="hover:text-ink">← Cancel and go home</Link>
      </div>
    </div>
  );
}

/* ----- Stepper ----- */
function Stepper({ step, onJump }: { step: number; onJump: (n: number) => void }) {
  return (
    <div className="mb-6 flex items-center gap-2 overflow-x-auto pb-1">
      {STEPS.map((s, i) => {
        const active = s.id === step;
        const done = s.id < step;
        return (
          <button
            key={s.id}
            onClick={() => onJump(s.id)}
            className={`flex items-center gap-2 px-3 py-2 rounded-md text-[13px] font-medium border transition-colors ${
              active
                ? "bg-accent-glow text-accent border-accent/30"
                : done
                ? "bg-surface text-ink border-border hover:border-border-strong"
                : "bg-surface/40 text-muted border-border"
            }`}
            data-testid={`stepper-${s.id}`}
          >
            <span
              className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold ${
                active
                  ? "bg-accent text-bg"
                  : done
                  ? "bg-surface-elev text-ink border border-border-strong"
                  : "bg-surface text-dim border border-border"
              }`}
            >
              {done ? "✓" : s.id}
            </span>
            {s.label}
            {i < STEPS.length - 1 && <span className="text-dim/60 ml-1">/</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ----- Step 1: Theme ----- */
function StepTheme({
  inputs,
  update,
}: {
  inputs: FormInputs;
  update: <K extends keyof FormInputs>(k: K, v: FormInputs[K]) => void;
}) {
  const { deckTheme, setDeckTheme } = useDeckTheme();
  return (
    <div>
      <h2 className="text-lg font-semibold mb-1">Theme & title</h2>
      <p className="text-sm text-muted mb-6">
        Pick the deck's visual treatment and give the pack a working title. Theme can also
        be changed later from the preview screen.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div>
          <label className="label">Pack title</label>
          <input
            className="input"
            placeholder="World War Z — Aftermath GTM"
            value={inputs.title}
            onChange={(e) => update("title", e.target.value)}
            data-testid="input-title"
          />
          <p className="hint">Internal name. Used in the file output.</p>
        </div>
        <div>
          <label className="label">Genre</label>
          <input
            className="input"
            placeholder="Co-op horror shooter"
            value={inputs.genre}
            onChange={(e) => update("genre", e.target.value)}
            data-testid="input-genre"
          />
        </div>
      </div>

      <label className="label">Deck theme</label>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <ThemeCard
          label="Dark"
          tag="Default · warm gold accent"
          active={deckTheme === "dark"}
          onClick={() => setDeckTheme("dark")}
          surfaceClass="bg-bg border-border"
          accentClass="bg-accent"
        />
        <ThemeCard
          label="Light"
          tag="Cream surface · teal accent"
          active={deckTheme === "light"}
          onClick={() => setDeckTheme("light")}
          surfaceClass="bg-light-bg border-light-hair"
          accentClass="bg-light-accent"
          inverted
        />
      </div>
    </div>
  );
}

function ThemeCard({
  label,
  tag,
  active,
  onClick,
  surfaceClass,
  accentClass,
  inverted,
}: {
  label: string;
  tag: string;
  active: boolean;
  onClick: () => void;
  surfaceClass: string;
  accentClass: string;
  inverted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-lg border p-4 transition-all ${
        active
          ? "border-accent/60 ring-2 ring-accent/20 bg-surface"
          : "border-border bg-surface hover:border-border-strong"
      }`}
      data-testid={`theme-${label.toLowerCase()}`}
    >
      <div className={`rounded-md border h-24 mb-3 ${surfaceClass} relative overflow-hidden`}>
        <div className={`absolute left-3 top-3 w-10 h-1 rounded ${accentClass}`} />
        <div className={`absolute left-3 top-6 w-24 h-1.5 rounded ${inverted ? "bg-light-ink/70" : "bg-ink/70"}`} />
        <div className={`absolute left-3 top-10 w-32 h-1 rounded ${inverted ? "bg-light-muted/60" : "bg-muted/60"}`} />
        <div className={`absolute left-3 top-13 w-28 h-1 rounded ${inverted ? "bg-light-muted/40" : "bg-muted/40"}`} style={{ top: 52 }} />
      </div>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-ink">{label}</div>
          <div className="text-xs text-muted">{tag}</div>
        </div>
        <span
          className={`w-4 h-4 rounded-full border ${
            active ? "border-accent bg-accent" : "border-border"
          }`}
        />
      </div>
    </button>
  );
}

/* ----- Step 2: Game ----- */
function StepGame({
  inputs,
  update,
}: {
  inputs: FormInputs;
  update: <K extends keyof FormInputs>(k: K, v: FormInputs[K]) => void;
}) {
  const gameTypes: { id: GameType; label: string; desc: string }[] = [
    { id: "sequel", label: "Sequel", desc: "Established IP with a known prior installment." },
    { id: "new_ip_with_fans", label: "New IP with fans", desc: "New title built atop an existing dev studio fanbase." },
    { id: "custom", label: "Custom", desc: "Neither — define your own inner-ring audience." },
  ];
  const innerOptions: { id: InnerRing; label: string; hint: string }[] = [
    { id: "prev", label: "Previous-game owners", hint: "Sequel — wishlist + lapsed players." },
    { id: "dev", label: "Dev studio followers", hint: "New IP — existing fanbase of the team." },
    { id: "other", label: "Custom audience", hint: "Define your own inner ring below." },
  ];
  return (
    <div>
      <h2 className="text-lg font-semibold mb-1">Game profile</h2>
      <p className="text-sm text-muted mb-6">
        These choices shape the innermost circle on the audience-tier slide.
      </p>

      <label className="label">Game type</label>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        {gameTypes.map((g) => {
          const active = inputs.game_type === g.id;
          return (
            <button
              key={g.id}
              type="button"
              onClick={() => update("game_type", g.id)}
              className={`text-left p-4 rounded-md border transition-colors ${
                active
                  ? "border-accent/60 bg-accent-glow text-ink"
                  : "border-border bg-surface hover:border-border-strong"
              }`}
              data-testid={`game-type-${g.id}`}
            >
              <div className="text-sm font-semibold text-ink">{g.label}</div>
              <div className="text-xs text-muted mt-1">{g.desc}</div>
            </button>
          );
        })}
      </div>

      <label className="label">Inner ring (highest intent)</label>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        {innerOptions.map((g) => {
          const active = inputs.inner === g.id;
          return (
            <button
              key={g.id}
              type="button"
              onClick={() => update("inner", g.id)}
              className={`text-left p-4 rounded-md border transition-colors ${
                active
                  ? "border-accent/60 bg-accent-glow"
                  : "border-border bg-surface hover:border-border-strong"
              }`}
              data-testid={`inner-${g.id}`}
            >
              <div className="text-sm font-semibold text-ink">{g.label}</div>
              <div className="text-xs text-muted mt-1">{g.hint}</div>
            </button>
          );
        })}
      </div>

      {inputs.inner === "other" && (
        <div>
          <label className="label">Inner-ring definition</label>
          <textarea
            className="input min-h-[80px]"
            placeholder="e.g. Players of co-op horror shooters in the last 24 months who own at least 3 titles in the genre."
            value={inputs.inner_definition || ""}
            onChange={(e) => update("inner_definition", e.target.value)}
            data-testid="input-inner-def"
          />
        </div>
      )}
    </div>
  );
}

/* ----- Step 3: Cohorts / USPs / Reach ----- */
function StepCohorts({
  inputs,
  update,
  setInputs,
}: {
  inputs: FormInputs;
  update: <K extends keyof FormInputs>(k: K, v: FormInputs[K]) => void;
  setInputs: (fn: (prev: FormInputs) => FormInputs) => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [phasesLoading, setPhasesLoading] = useState(false);
  const [phasesText, setPhasesText] = useState<string>("");
  const [phasesErr, setPhasesErr] = useState<string | null>(null);

  function setCohort(i: number, patch: Partial<{ name: string; size: number }>) {
    setInputs((prev) => {
      const next = [...prev.cohorts];
      next[i] = { ...next[i], ...patch };
      return { ...prev, cohorts: next };
    });
  }
  function setUsp(
    i: number,
    patch: Partial<{ title: string; description: string; proof: string; strategy: string; enabled: boolean }>
  ) {
    setInputs((prev) => {
      const next = [...prev.usps];
      next[i] = { ...next[i], ...patch };
      return { ...prev, usps: next };
    });
  }
  function setReach(i: number, patch: Partial<{ cohort: string; channel: string; message: string; kpi: string }>) {
    setInputs((prev) => {
      const next = [...prev.reach];
      next[i] = { ...next[i], ...patch };
      return { ...prev, reach: next };
    });
  }
  function addUsp() {
    if (inputs.usps.length >= 5) return;
    setInputs((p) => ({
      ...p,
      usps: [...p.usps, { title: "", description: "", proof: "", strategy: "", enabled: true }],
    }));
  }
  function removeUsp(i: number) {
    if (inputs.usps.length <= 1) return;
    setInputs((p) => ({ ...p, usps: p.usps.filter((_, idx) => idx !== i) }));
  }

  async function toggleAdvanced() {
    const next = !showAdvanced;
    setShowAdvanced(next);
    if (next && !phasesText) {
      setPhasesLoading(true);
      setPhasesErr(null);
      try {
        const data = await api.roadmapPhases();
        setPhasesText(JSON.stringify(data, null, 2));
      } catch (e: any) {
        setPhasesErr(String(e.message || e));
      } finally {
        setPhasesLoading(false);
      }
    }
  }

  function applyPhases() {
    try {
      const parsed = JSON.parse(phasesText);
      update("phases_override", parsed);
    } catch (e: any) {
      setPhasesErr("Invalid JSON: " + String(e.message || e));
    }
  }

  return (
    <div>
      <h2 className="text-lg font-semibold mb-1">Audiences, USPs, and reach plan</h2>
      <p className="text-sm text-muted mb-6">
        Four cohorts (innermost first), three to five USPs, and one row of reach plan per cohort.
      </p>

      {/* Cohorts */}
      <section className="mb-8">
        <SectionHeading n="01" title="Cohorts" hint="Exactly four. Order matters — innermost first." />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {inputs.cohorts.map((c, i) => (
            <div key={i} className="card p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="eyebrow">Ring {i + 1}</div>
                <span className="chip">{["Innermost", "Second", "Third", "Outer"][i]}</span>
              </div>
              <input
                className="input mb-2"
                placeholder="Cohort name"
                value={c.name}
                onChange={(e) => setCohort(i, { name: e.target.value })}
                data-testid={`cohort-name-${i}`}
              />
              <input
                className="input"
                type="number"
                min={0}
                placeholder="Estimated size"
                value={c.size || ""}
                onChange={(e) => setCohort(i, { size: parseInt(e.target.value || "0", 10) })}
                data-testid={`cohort-size-${i}`}
              />
            </div>
          ))}
        </div>
      </section>

      {/* USPs */}
      <section className="mb-8">
        <SectionHeading
          n="02"
          title="Unique selling points"
          hint="One to five (at least one must be enabled). Each gets a title, description, proof point, and an optional strategy note."
          right={
            <button
              type="button"
              className="btn-ghost"
              onClick={addUsp}
              disabled={inputs.usps.length >= 5}
            >
              + Add USP
            </button>
          }
        />
        <div className="space-y-3">
          {inputs.usps.map((u, i) => (
            <div key={i} className={`card p-4 ${u.enabled === false ? "opacity-50" : ""}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                  <div className="eyebrow">USP {i + 1}</div>
                  <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
                    <input
                      type="checkbox"
                      checked={u.enabled !== false}
                      onChange={(e) => setUsp(i, { enabled: e.target.checked })}
                      className="accent-accent"
                      data-testid={`usp-enabled-${i}`}
                    />
                    Enabled
                  </label>
                </div>
                {inputs.usps.length > 1 && (
                  <button
                    type="button"
                    className="text-xs text-muted hover:text-red-300"
                    onClick={() => removeUsp(i)}
                  >
                    Remove
                  </button>
                )}
              </div>
              <input
                className="input mb-2"
                placeholder="Headline"
                value={u.title}
                onChange={(e) => setUsp(i, { title: e.target.value })}
                data-testid={`usp-title-${i}`}
              />
              <textarea
                className="input mb-2 min-h-[60px]"
                placeholder="Description"
                value={u.description}
                onChange={(e) => setUsp(i, { description: e.target.value })}
                data-testid={`usp-desc-${i}`}
              />
              <input
                className="input mb-2"
                placeholder="Proof point (review, sales data, expert quote…)"
                value={u.proof}
                onChange={(e) => setUsp(i, { proof: e.target.value })}
                data-testid={`usp-proof-${i}`}
              />
              <input
                className="input"
                placeholder="Strategy to leverage (optional)"
                value={u.strategy || ""}
                onChange={(e) => setUsp(i, { strategy: e.target.value })}
                data-testid={`usp-strategy-${i}`}
              />
            </div>
          ))}
        </div>
      </section>

      {/* Reach */}
      <section className="mb-8">
        <SectionHeading n="03" title="Reach plan" hint="One row per cohort." />
        <div className="overflow-x-auto -mx-2 px-2">
          <table className="w-full text-sm border-collapse min-w-[680px]">
            <thead>
              <tr className="text-left text-xs text-dim uppercase tracking-wider">
                <th className="py-2 pr-2 font-semibold">Cohort</th>
                <th className="py-2 pr-2 font-semibold">Channel</th>
                <th className="py-2 pr-2 font-semibold">Message</th>
                <th className="py-2 font-semibold">KPI</th>
              </tr>
            </thead>
            <tbody>
              {inputs.reach.map((r, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="py-2 pr-2">
                    <input
                      className="input"
                      value={r.cohort}
                      placeholder={inputs.cohorts[i]?.name || `Ring ${i + 1}`}
                      onChange={(e) => setReach(i, { cohort: e.target.value })}
                      data-testid={`reach-cohort-${i}`}
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      className="input"
                      placeholder="Twitch, IG, Steam…"
                      value={r.channel}
                      onChange={(e) => setReach(i, { channel: e.target.value })}
                      data-testid={`reach-channel-${i}`}
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      className="input"
                      placeholder="Key message"
                      value={r.message}
                      onChange={(e) => setReach(i, { message: e.target.value })}
                      data-testid={`reach-message-${i}`}
                    />
                  </td>
                  <td className="py-2">
                    <input
                      className="input"
                      placeholder="Wishlists, CTR…"
                      value={r.kpi}
                      onChange={(e) => setReach(i, { kpi: e.target.value })}
                      data-testid={`reach-kpi-${i}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Advanced — Step 4 checklist override */}
      <section>
        <button
          type="button"
          className="btn-ghost"
          onClick={toggleAdvanced}
          data-testid="button-advanced-toggle"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            style={{ transform: showAdvanced ? "rotate(90deg)" : "rotate(0)" }}>
            <path d="M9 6l6 6-6 6" />
          </svg>
          Advanced: edit Step 4 checklist (roadmap phases)
        </button>

        {showAdvanced && (
          <div className="mt-3 card p-4">
            <p className="text-xs text-muted mb-3">
              Override the default six-stage roadmap. Edit the JSON, then click "Apply override".
              Leave blank to use the bundled defaults.
            </p>
            {phasesLoading && <Spinner label="Loading defaults…" />}
            {phasesErr && <ErrorBox message={phasesErr} />}
            {!phasesLoading && (
              <>
                <textarea
                  className="input font-mono text-xs min-h-[260px]"
                  value={phasesText}
                  onChange={(e) => setPhasesText(e.target.value)}
                  spellCheck={false}
                  data-testid="textarea-phases"
                />
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={applyPhases}
                    data-testid="button-apply-phases"
                  >
                    Apply override
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      update("phases_override", undefined);
                    }}
                  >
                    Clear override
                  </button>
                  {inputs.phases_override && (
                    <span className="text-xs text-accent">Override active</span>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function SectionHeading({
  n,
  title,
  hint,
  right,
}: {
  n: string;
  title: string;
  hint?: string;
  right?: JSX.Element;
}) {
  return (
    <div className="flex items-end justify-between gap-4 mb-3">
      <div>
        <div className="eyebrow">Section {n}</div>
        <div className="text-base font-semibold text-ink">{title}</div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
      {right}
    </div>
  );
}

/* ----- Step 4: Release date ----- */
function StepDate({
  inputs,
  update,
}: {
  inputs: FormInputs;
  update: <K extends keyof FormInputs>(k: K, v: FormInputs[K]) => void;
}) {
  return (
    <div>
      <h2 className="text-lg font-semibold mb-1">Release date</h2>
      <p className="text-sm text-muted mb-6">
        The roadmap timeline is anchored to this date. T-windows on the roadmap slides
        (T-12, T-9, T-3, T-1, T+0, T+30, T+365) are calculated from it.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div>
          <label className="label">Release date</label>
          <input
            type="date"
            className="input"
            value={inputs.release_date}
            onChange={(e) => update("release_date", e.target.value)}
            data-testid="input-release-date"
          />
        </div>
        <div>
          <label className="label">Wedge headline (optional)</label>
          <input
            className="input"
            placeholder="e.g. The only co-op horror shooter with…"
            value={inputs.wedge || ""}
            onChange={(e) => update("wedge", e.target.value)}
            data-testid="input-wedge"
          />
        </div>
      </div>

      <div>
        <label className="label">Wedge support (optional)</label>
        <textarea
          className="input min-h-[80px]"
          placeholder="One sentence reinforcing the wedge headline above."
          value={inputs.wedge_support || ""}
          onChange={(e) => update("wedge_support", e.target.value)}
          data-testid="input-wedge-support"
        />
      </div>
    </div>
  );
}

/* ----- Step 5: Median Commercial Potential ----- */
function StepCommercialPotential({
  inputs,
  update,
  setInputs,
}: {
  inputs: FormInputs;
  update: <K extends keyof FormInputs>(k: K, v: FormInputs[K]) => void;
  setInputs: (fn: (prev: FormInputs) => FormInputs) => void;
}) {
  const [loadingDefaults, setLoadingDefaults] = useState(false);
  const [defaultsErr, setDefaultsErr] = useState<string | null>(null);

  function togglePlatform(p: Platform) {
    setInputs((prev) => {
      const has = prev.platforms.includes(p);
      const next = has
        ? prev.platforms.filter((x) => x !== p)
        : [...prev.platforms, p];
      return { ...prev, platforms: next.length ? next : prev.platforms };
    });
  }

  async function fetchGenreDefaults() {
    if (!inputs.genre.trim()) {
      setDefaultsErr("Enter a genre on Step 1 first.");
      return;
    }
    setLoadingDefaults(true);
    setDefaultsErr(null);
    try {
      const comps = await api.genrePulseComps(inputs.genre.trim());
      setInputs((prev) => ({
        ...prev,
        comp_set_name: comps.comp_set_name,
        median_revenue_usd_millions: comps.median_revenue_usd_millions,
        avg_price_usd: comps.avg_price_usd,
        median_units_sold: comps.median_units_sold,
        avg_hours_played: comps.avg_hours_played,
      }));
    } catch (e: any) {
      setDefaultsErr(String(e.message || e));
    } finally {
      setLoadingDefaults(false);
    }
  }

  return (
    <div>
      <h2 className="text-lg font-semibold mb-1">Median commercial potential</h2>
      <p className="text-sm text-muted mb-6">
        Genre-benchmark KPIs and a per-platform revenue/units projection. Renders as Step 5 in
        the pack (output position 2, right after the sizing chart).
      </p>

      <div className="mb-6">
        <button
          type="button"
          className="btn-secondary"
          onClick={fetchGenreDefaults}
          disabled={loadingDefaults}
          data-testid="button-fetch-genre-defaults"
        >
          {loadingDefaults ? "Fetching…" : "Pull defaults from Genre Pulse"}
        </button>
        <p className="hint">
          Looks up genre-benchmark medians from howmanyareplaying.com and pre-fills the fields
          below. You can still edit any value afterward.
        </p>
        {defaultsErr && <ErrorBox message={defaultsErr} />}
      </div>

      <div className="mb-4">
        <label className="label">Comp set name</label>
        <input
          className="input"
          placeholder="e.g. Horror — 19 titles"
          value={inputs.comp_set_name || ""}
          onChange={(e) => update("comp_set_name", e.target.value)}
          data-testid="input-comp-set-name"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div>
          <label className="label">Median revenue (comp set)</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-dim text-sm">$</span>
            <input
              className="input pl-6"
              type="number"
              step="0.1"
              min={0}
              placeholder="4.7"
              value={inputs.median_revenue_usd_millions || ""}
              onChange={(e) =>
                update("median_revenue_usd_millions", parseFloat(e.target.value || "0"))
              }
              data-testid="input-median-revenue"
            />
          </div>
          <p className="hint">
            In millions of dollars — e.g. "4.7" means $4,700,000. Renders on the slide as
            "$4.70" with a small "in millions" label. Do not enter a raw dollar amount here.
          </p>
        </div>
        <div>
          <label className="label">Median units sold (comp set)</label>
          <input
            className="input"
            type="number"
            min={0}
            placeholder="1782675"
            value={inputs.median_units_sold || ""}
            onChange={(e) => update("median_units_sold", parseInt(e.target.value || "0", 10))}
            data-testid="input-median-units"
          />
          <p className="hint">Raw unit count — not in millions.</p>
        </div>
        <div>
          <label className="label">Avg price (comp set)</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-dim text-sm">$</span>
            <input
              className="input pl-6"
              type="number"
              step="0.01"
              min={0}
              placeholder="39.99"
              value={inputs.avg_price_usd || ""}
              onChange={(e) => update("avg_price_usd", parseFloat(e.target.value || "0"))}
              data-testid="input-avg-price"
            />
          </div>
          <p className="hint">Plain dollars — not in millions.</p>
        </div>
        <div>
          <label className="label">Avg hours played (comp set)</label>
          <input
            className="input"
            type="number"
            step="0.1"
            min={0}
            placeholder="18.7"
            value={inputs.avg_hours_played || ""}
            onChange={(e) => update("avg_hours_played", parseFloat(e.target.value || "0"))}
            data-testid="input-avg-hours"
          />
        </div>
      </div>

      <label className="label">Platforms</label>
      <p className="hint mb-2">
        Select 1-4. The projection table splits median revenue/units across your selection using
        locked platform-share weights (PC &gt; PS5 &gt; XSX &gt; SWITCH2).
      </p>
      <div className="flex flex-wrap gap-2">
        {ALL_PLATFORMS.map((p) => {
          const active = inputs.platforms.includes(p);
          return (
            <button
              key={p}
              type="button"
              onClick={() => togglePlatform(p)}
              className={`px-3 py-2 rounded-md text-sm font-medium border transition-colors ${
                active
                  ? "border-accent/60 bg-accent-glow text-accent"
                  : "border-border bg-surface text-muted hover:border-border-strong"
              }`}
              data-testid={`platform-${p.toLowerCase()}`}
            >
              {p}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ----- Step 6: Commercial Risks ----- */
function StepCommercialRisks({
  inputs,
  update,
  setInputs,
}: {
  inputs: FormInputs;
  update: <K extends keyof FormInputs>(k: K, v: FormInputs[K]) => void;
  setInputs: (fn: (prev: FormInputs) => FormInputs) => void;
}) {
  function setRisk(
    i: number,
    patch: Partial<{ threat_level: ThreatLevel; proof: string; mitigation: string }>
  ) {
    setInputs((prev) => {
      const next = [...prev.risks];
      next[i] = { ...next[i], ...patch };
      return { ...prev, risks: next };
    });
  }
  function addRisk() {
    if (inputs.risks.length >= 5) return;
    setInputs((p) => ({
      ...p,
      risks: [...p.risks, { threat_level: "medium", proof: "", mitigation: "" }],
    }));
  }
  function removeRisk(i: number) {
    if (inputs.risks.length <= 1) return;
    setInputs((p) => ({ ...p, risks: p.risks.filter((_, idx) => idx !== i) }));
  }

  return (
    <div>
      <h2 className="text-lg font-semibold mb-1">Commercial risks</h2>
      <p className="text-sm text-muted mb-6">
        One to five risks, each with a threat level, supporting proof, and a mitigation plan.
        Renders as Step 6 in the pack (output position 11).
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <div>
          <label className="label">Risks wedge headline (optional)</label>
          <input
            className="input"
            placeholder="e.g. The biggest threats to this launch — and how we handle them."
            value={inputs.risks_wedge || ""}
            onChange={(e) => update("risks_wedge", e.target.value)}
            data-testid="input-risks-wedge"
          />
          <p className="hint">Falls back to the shared wedge headline from Step 4 if left blank.</p>
        </div>
        <div>
          <label className="label">Risks wedge support (optional)</label>
          <input
            className="input"
            placeholder="One sentence reinforcing the risks wedge headline."
            value={inputs.risks_wedge_support || ""}
            onChange={(e) => update("risks_wedge_support", e.target.value)}
            data-testid="input-risks-wedge-support"
          />
        </div>
      </div>

      <SectionHeading
        n="06"
        title="Risks"
        hint="One to five. Threat level drives the badge color on the slide."
        right={
          <button
            type="button"
            className="btn-ghost"
            onClick={addRisk}
            disabled={inputs.risks.length >= 5}
          >
            + Add risk
          </button>
        }
      />
      <div className="space-y-3">
        {inputs.risks.map((r, i) => (
          <div key={i} className="card p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="eyebrow">Risk {i + 1}</div>
              {inputs.risks.length > 1 && (
                <button
                  type="button"
                  className="text-xs text-muted hover:text-red-300"
                  onClick={() => removeRisk(i)}
                >
                  Remove
                </button>
              )}
            </div>
            <label className="label">Threat level</label>
            <div className="flex flex-wrap gap-2 mb-3">
              {THREAT_LEVELS.map((lvl) => {
                const active = r.threat_level === lvl;
                return (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => setRisk(i, { threat_level: lvl })}
                    className={`px-3 py-1.5 rounded-md text-xs font-bold uppercase tracking-wide border transition-colors ${
                      active
                        ? "border-accent/60 bg-accent-glow text-accent"
                        : "border-border bg-surface text-muted hover:border-border-strong"
                    }`}
                    data-testid={`risk-level-${i}-${lvl}`}
                  >
                    {lvl}
                  </button>
                );
              })}
            </div>
            <textarea
              className="input mb-2 min-h-[60px]"
              placeholder="Proof (data point, precedent, market signal…)"
              value={r.proof}
              onChange={(e) => setRisk(i, { proof: e.target.value })}
              data-testid={`risk-proof-${i}`}
            />
            <textarea
              className="input min-h-[60px]"
              placeholder="Mitigation plan"
              value={r.mitigation}
              onChange={(e) => setRisk(i, { mitigation: e.target.value })}
              data-testid={`risk-mitigation-${i}`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ----- Step 7: Description & Razors ----- */
function StepDescriptionRazors({
  inputs,
  update,
}: {
  inputs: FormInputs;
  update: <K extends keyof FormInputs>(k: K, v: FormInputs[K]) => void;
}) {
  const wc = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
  return (
    <div>
      <h2 className="text-lg font-semibold mb-1">Game description & razors</h2>
      <p className="text-sm text-muted mb-6">
        A ~100-word description plus a 20-word and a 10-word tagline ("razor"). Renders as Step 7
        in the pack (output position 12, the final slide). Word-count limits are nominal —
        going over just shows a warning, it won't block generation.
      </p>

      <div className="mb-6">
        <label className="label">Description (~100 words)</label>
        <textarea
          className="input min-h-[140px]"
          placeholder="A short, evocative description of the game for press and platform listings…"
          value={inputs.description_100}
          onChange={(e) => update("description_100", e.target.value)}
          data-testid="input-description-100"
        />
        <p className={`hint ${wc(inputs.description_100) > 100 ? "text-amber-400" : ""}`}>
          {wc(inputs.description_100)} / 100 words
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="label">Razor (~20 words)</label>
          <textarea
            className="input min-h-[80px]"
            placeholder="A tight one-sentence hook."
            value={inputs.razor_20}
            onChange={(e) => update("razor_20", e.target.value)}
            data-testid="input-razor-20"
          />
          <p className={`hint ${wc(inputs.razor_20) > 20 ? "text-amber-400" : ""}`}>
            {wc(inputs.razor_20)} / 20 words
          </p>
        </div>
        <div>
          <label className="label">Razor (~10 words)</label>
          <textarea
            className="input min-h-[80px]"
            placeholder="An even tighter hook."
            value={inputs.razor_10}
            onChange={(e) => update("razor_10", e.target.value)}
            data-testid="input-razor-10"
          />
          <p className={`hint ${wc(inputs.razor_10) > 10 ? "text-amber-400" : ""}`}>
            {wc(inputs.razor_10)} / 10 words
          </p>
        </div>
      </div>
    </div>
  );
}

/* ----- Validation ----- */
function isStepValid(step: number, inputs: FormInputs): boolean {
  if (step === 1) return Boolean(inputs.title.trim() && inputs.genre.trim());
  if (step === 2) {
    if (inputs.inner === "other") return Boolean(inputs.inner_definition?.trim());
    return true;
  }
  if (step === 3) {
    if (inputs.cohorts.length !== 4) return false;
    if (!inputs.cohorts.every((c) => c.name.trim() && c.size >= 0)) return false;
    if (inputs.usps.length < 1 || inputs.usps.length > 5) return false;
    if (!inputs.usps.every((u) => u.title.trim() && u.description.trim())) return false;
    if (!inputs.usps.some((u) => u.enabled !== false)) return false; // at least 1 enabled
    if (inputs.reach.length !== 4) return false;
    if (!inputs.reach.every((r) => r.channel.trim() && r.message.trim())) return false;
    return true;
  }
  if (step === 4) return Boolean(inputs.release_date);
  if (step === 5) {
    if (inputs.median_revenue_usd_millions <= 0) return false;
    if (inputs.median_units_sold <= 0) return false;
    if (inputs.avg_price_usd <= 0) return false;
    if (inputs.avg_hours_played <= 0) return false;
    if (!inputs.platforms || inputs.platforms.length < 1) return false;
    return true;
  }
  if (step === 6) {
    if (inputs.risks.length < 1 || inputs.risks.length > 5) return false;
    if (!inputs.risks.every((r) => r.proof.trim() && r.mitigation.trim())) return false;
    return true;
  }
  if (step === 7) {
    return Boolean(
      inputs.description_100.trim() && inputs.razor_20.trim() && inputs.razor_10.trim()
    );
  }
  return true;
}
