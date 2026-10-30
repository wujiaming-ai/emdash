import { Button } from '@react/primitives/button';
import { Popover } from '@react/primitives/popover';
import { cx } from '@styles/utilities/cx';
import * as styles from './chat-composer.css';
import { composerThemeScope } from './composer-contract.css';

// ── Data type ─────────────────────────────────────────────────────────────────

export interface ContextUsage {
  used: number;
  size: number;
  windowSource?: 'resolved' | 'estimated' | 'unknown';
  cost?: { amount: number; currency: string } | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function formatCost(cost: { amount: number; currency: string }): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: cost.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(cost.amount);
  } catch {
    return `${cost.amount} ${cost.currency}`;
  }
}

// ── Donut SVG ─────────────────────────────────────────────────────────────────

function ContextDonut({ fraction }: { fraction: number }) {
  const pct = Math.round(fraction * 100);
  return (
    <svg viewBox="0 0 36 36" className={styles.donut} aria-hidden="true">
      <circle className={styles.donutTrack} cx="18" cy="18" r="15" fill="none" strokeWidth="5" />
      <circle
        className={fraction >= 0.9 ? styles.donutProgressWarn : styles.donutProgress}
        cx="18"
        cy="18"
        r="15"
        fill="none"
        strokeWidth="5"
        pathLength={100}
        strokeDasharray={`${pct} 100`}
        strokeLinecap="round"
        transform="rotate(-90 18 18)"
      />
    </svg>
  );
}

// ── Indicator ─────────────────────────────────────────────────────────────────

interface ContextUsageIndicatorProps {
  usage: ContextUsage;
  disabled?: boolean;
}

interface ContextUsageDetailsProps {
  usage: ContextUsage;
  known: boolean;
  fraction: number;
  pct: number;
}

export function ContextUsageIndicator({ usage, disabled }: ContextUsageIndicatorProps) {
  const known = Number.isFinite(usage.size) && usage.size > 0 && usage.windowSource !== 'unknown';
  const ratio = known ? Math.max(0, usage.used / usage.size) : 0;
  const fraction = Math.min(1, ratio);
  const pct = Math.round(ratio * 100);

  return (
    <Popover.Root>
      <Popover.Trigger
        render={
          <Button
            variant="ghost"
            size="xs"
            icon
            disabled={disabled}
            aria-label={
              known
                ? `Context window: ${pct}% used${usage.windowSource === 'estimated' ? ' (estimated)' : ''}`
                : `Context window: unknown, ${formatTokens(usage.used)} tokens used`
            }
          >
            <ContextDonut fraction={fraction} />
          </Button>
        }
      />
      {/* Portaled out of the composer root — must carry the theme-bridge scope. */}
      <Popover.Content className={composerThemeScope} align="end" side="top">
        <Popover.Header>
          <Popover.Title>Context usage</Popover.Title>
        </Popover.Header>
        <ContextUsageDetails usage={usage} known={known} fraction={fraction} pct={pct} />
      </Popover.Content>
    </Popover.Root>
  );
}

function ContextUsageDetails({ usage, known, fraction, pct }: ContextUsageDetailsProps) {
  return (
    <div className={styles.usagePopoverBody}>
      <div className={styles.usageStatsRow}>
        <span className={styles.usagePercent}>{known ? `${pct}%` : 'Window unknown'}</span>
        <span className={styles.usageTokenCount}>
          {formatTokens(usage.used)}
          {known ? ` / ${formatTokens(usage.size)}` : ''} Tokens
        </span>
      </div>
      <div className={styles.usageBarTrack} aria-hidden="true">
        <div
          className={cx(styles.usageBarFill, fraction >= 0.9 && styles.usageBarFillWarn)}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
      {usage.windowSource === 'estimated' && known ? (
        <div className={styles.usageCostRow}>Estimated window</div>
      ) : null}
      {usage.windowSource === 'resolved' && known ? (
        <div className={styles.usageCostRow}>
          Current Claude context window; may be limited by auto-compaction policy.
        </div>
      ) : null}
      {usage.cost ? (
        <div className={styles.usageCostRow}>Cost: {formatCost(usage.cost)}</div>
      ) : null}
    </div>
  );
}
