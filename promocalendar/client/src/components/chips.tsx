import type { CSSProperties } from "react";
import { daysLabel, platCls } from "../lib/format";

export function PlatformChip({ platform }: { platform: string }) {
  return <span className={`chip ${platCls(platform)}`}>{platform}</span>;
}

export function StatusChip({ daysUntilStart, isActive }: { daysUntilStart: number; isActive: boolean }) {
  if (isActive) {
    return (
      <span className="chip live">
        <span className="dot" aria-hidden />LIVE
      </span>
    );
  }
  return <span className="chip">{daysLabel(daysUntilStart, isActive)}</span>;
}

export function GameChip({ code }: { code: string }) {
  return <span className="chip game">{gameShort(code)}</span>;
}

/** Small short-code for a game — matches the mockup's abbreviations. */
export function gameShort(code: string): string {
  return SHORT[code] || code;
}

const SHORT: Record<string, string> = {
  "SM2": "SM2",
  "ROADCRAFT": "ROAD",
  "TOXIC COMMANDO": "TOXIC",
  "SNOW": "SNOW",
  "EXPE": "EXPE",
  "EXPEDITIONS": "EXPE",
  "ISS": "ISS",
};

export const Chip = ({ children, style }: { children: React.ReactNode; style?: CSSProperties }) => (
  <span className="chip" style={style}>{children}</span>
);
