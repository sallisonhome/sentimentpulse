import { useState } from "react";

/** Verify native dimensions, not the CSS box. Never crop a banner into a cover. */
export function PortraitCover({ candidates = [], className = "" }: { candidates?: string[]; className?: string }) {
  return <PortraitAttempt key={JSON.stringify(candidates)} candidates={candidates} className={className} />;
}
function PortraitAttempt({ candidates, className }: { candidates: string[]; className: string }) {
  const [index, setIndex] = useState(0);
  const [ready, setReady] = useState(false);
  const next = () => { setReady(false); setIndex(i => i + 1); };
  if (!candidates[index]) return <div className={className} role="img" aria-label="Portrait artwork unavailable"
    style={{ display: "grid", placeItems: "center", background: "var(--muted)", fontSize: 12, textAlign: "center" }}>Artwork unavailable</div>;
  return <img key={candidates[index]} src={candidates[index]} alt="" className={className}
    style={{ objectFit: "contain", visibility: ready ? "visible" : "hidden" }}
    onError={next} onLoad={e => {
      const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
      if (w >= 120 && h > w && w / h >= 0.45) setReady(true); else next();
    }} />;
}
