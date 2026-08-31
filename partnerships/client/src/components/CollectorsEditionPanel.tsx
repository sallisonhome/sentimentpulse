import { useState } from "react";
import { api } from "../lib/api";
import { dateShort, usd } from "../lib/format";
import type {
  CollectorsEditionItem,
  Opportunity,
} from "@shared/schema";

/**
 * Collectors Edition quadrant body — combines the parent opportunity(s) with
 * the +Item builder from the spec. Auto-sums manufacturing cost across items,
 * skipping TBD entries.
 */
export default function CollectorsEditionPanel({
  productId,
  secured,
  inDiscussion,
  items,
  workbackDate,
  onChange,
}: {
  productId: number;
  secured: Opportunity[];
  inDiscussion: Opportunity[];
  items: CollectorsEditionItem[];
  workbackDate: string;
  onChange: () => void;
}) {
  const hasParents = secured.length + inDiscussion.length > 0;
  const totalKnown = items
    .filter((i) => !i.manufacturingCostTbd)
    .reduce((a, b) => a + (b.manufacturingCostUsd || 0), 0);
  const tbdCount = items.filter((i) => i.manufacturingCostTbd).length;

  return (
    <div className="space-y-3">
      {!hasParents && (
        <div className="italic text-sm" style={{ color: "#7c8ec2" }}>
          Add a Collector's Edition opportunity to unlock the item builder.
        </div>
      )}
      {[...secured, ...inDiscussion].map((o) => (
        <div
          key={o.id}
          className="rounded-md p-2.5"
          style={{ background: "rgba(255,255,255,0.04)" }}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className={`chip ${
                  o.state === "Secured" ? "chip-secured" : "chip-discussion"
                }`}
              >
                {o.state}
              </span>
              <span className="font-medium text-sm text-white">{o.subtype}</span>
            </div>
            {o.revenueUsd != null && (
              <div className="text-sm tabular-nums" style={{ color: "#fff" }}>
                MG {usd(o.revenueUsd)}
              </div>
            )}
          </div>
          <div className="text-xs mt-1" style={{ color: "#a7b6dd" }}>
            Vendor pick target: {dateShort(workbackDate)} (release − 12mo)
          </div>
        </div>
      ))}

      {hasParents && (
        <div>
          <div
            className="text-[10px] uppercase tracking-widest mb-2"
            style={{ color: "#8ea5d6" }}
          >
            Items in the box
          </div>
          <ItemList items={items} onChange={onChange} />
          <div className="mt-2 flex items-center justify-between text-xs" style={{ color: "#a7b6dd" }}>
            <span>
              Manufacturing subtotal (excludes {tbdCount} TBD)
            </span>
            <span className="font-semibold text-white tabular-nums">
              {usd(totalKnown)}
            </span>
          </div>
          <AddItemRow productId={productId} onSaved={onChange} />
        </div>
      )}
    </div>
  );
}

function ItemList({
  items,
  onChange,
}: {
  items: CollectorsEditionItem[];
  onChange: () => void;
}) {
  if (items.length === 0) {
    return (
      <div
        className="italic text-xs"
        style={{ color: "#7c8ec2" }}
      >
        No items yet.
      </div>
    );
  }
  return (
    <ul className="space-y-1">
      {items.map((i) => (
        <li
          key={i.id}
          className="flex items-center justify-between text-sm rounded px-2 py-1"
          style={{ background: "rgba(255,255,255,0.03)" }}
        >
          <span className="text-white">{i.itemName}</span>
          <span className="flex items-center gap-2">
            <span
              className="tabular-nums"
              style={{ color: i.manufacturingCostTbd ? "#8ea5d6" : "#e2e8f0" }}
            >
              {i.manufacturingCostTbd ? "TBD" : usd(i.manufacturingCostUsd || 0)}
            </span>
            <button
              onClick={() => {
                if (confirm(`Remove item "${i.itemName}"?`)) {
                  api.deleteCEItem(i.id).then(onChange);
                }
              }}
              className="text-xs"
              style={{ color: "#f87171" }}
            >
              ×
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

function AddItemRow({
  productId,
  onSaved,
}: {
  productId: number;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [cost, setCost] = useState("");
  const [tbd, setTbd] = useState(false);
  const [saving, setSaving] = useState(false);

  async function add() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.createCEItem({
        productId,
        itemName: name.trim(),
        manufacturingCostUsd: tbd ? null : cost ? Number(cost) : null,
        manufacturingCostTbd: tbd,
      });
      setName("");
      setCost("");
      setTbd(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 grid grid-cols-[1fr_120px_auto_auto] gap-2 items-center">
      <input
        className="input text-sm"
        placeholder="Item name (e.g. Statue, Steelbook)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        type="number"
        className="input text-sm"
        placeholder="Mfg cost"
        value={cost}
        onChange={(e) => setCost(e.target.value)}
        disabled={tbd}
        min={0}
      />
      <label className="flex items-center gap-1 text-xs" style={{ color: "#a7b6dd" }}>
        <input type="checkbox" checked={tbd} onChange={(e) => setTbd(e.target.checked)} />
        TBD
      </label>
      <button
        onClick={add}
        disabled={saving || !name.trim()}
        className="btn-primary text-xs px-2 py-1"
      >
        + Item
      </button>
    </div>
  );
}
