import { useTheme } from "./theme-provider";
import darkLogo from "@assets/saber-logo-dark-mode.jpg";
import lightLogo from "@assets/saber-logo-light-mode.jpg";

interface LeaderboardBannerProps {
  title: string;
  subtitle?: string;
}

/**
 * Shared banner for the Steam Leaderboards pages — Saber logo (theme-
 * conditional mark) + bold condensed title treatment, per the plan's
 * "bold professional title treatment/font for the Leaderboard titles"
 * requirement (CLAUDE_STEAM_LEADERBOARDS.md §6.1).
 */
export function LeaderboardBanner({ title, subtitle }: LeaderboardBannerProps) {
  const { theme } = useTheme();
  const logo = theme === "dark" ? darkLogo : lightLogo;

  return (
    <div className="flex items-center gap-4 mb-6 pb-5 border-b">
      <img
        src={logo}
        alt="Saber Interactive"
        className="h-14 w-14 rounded-md object-cover shrink-0"
        data-testid="img-leaderboard-saber-logo"
      />
      <div>
        <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Saber
        </span>
        <h1
          className="text-2xl font-extrabold uppercase tracking-tight leading-tight -mt-0.5"
          data-testid="text-leaderboard-title"
        >
          {title}
        </h1>
        {subtitle && (
          <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
        )}
      </div>
    </div>
  );
}
