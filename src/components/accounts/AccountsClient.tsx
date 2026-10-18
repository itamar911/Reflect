'use client';

/**
 * The "התיקים שלי" cards, and the three things a trader can do to them
 * (REF-110 Stage 4).
 *
 * RENAME, HIDE, ASSIGN. All three are writes to the trader's own rows, made
 * from the browser under 037's `accounts_owner` policy — no route handler and
 * no service-role client, because there is nothing here a trader is not
 * already allowed to do to their own data. The statements live in
 * lib/portfolios/read.ts so the suite can assert their shape without a
 * browser; this file holds only what needs one.
 *
 * Every figure arrives precomputed from the server. Nothing in this file does
 * arithmetic on money — see the header on lib/portfolios/figures.ts.
 *
 *
 * THE WHOLE-CARD LINK, AND WHY IT IS A PSEUDO-ELEMENT
 * ---------------------------------------------------
 *
 * REF-110 asks for "click card → /trades?account=<id>", and the card also
 * carries two buttons. Nesting buttons inside an <a> is invalid HTML and
 * behaves differently in every browser. So the card is a plain container, the
 * portfolio's NAME is the only link, and that link's ::after is stretched over
 * the whole card — one link, one accessible name, full-card hit area. The
 * action buttons sit above it on the stacking context and keep their own
 * clicks.
 *
 *
 * WHAT EXPLAINS ITSELF, AND WHERE
 * -------------------------------
 *
 * Imri's 17.10 requirement, as applied here. Three of the six lines land on
 * this screen and each one renders at the moment it is needed rather than
 * permanently:
 *
 *   - "נסגר" carries its sentence as a sub-line under the chip, always,
 *     because a trader seeing a portfolio marked closed wants to know
 *     immediately whether their trades went with it. (They did not.)
 *   - The hide action's sentence appears when the trader presses הסתר, inside
 *     the confirm, where it is answering a question they have just asked.
 *     Permanently under every card it would be noise on the cards they are
 *     not hiding.
 *   - "ללא תיק" carries its sentence always, because that card is the one
 *     thing on this screen nobody asked for and everybody has to understand.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Pencil, Check, X, Inbox } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { formatMoney } from '@/lib/money';
import {
  NEW_PORTFOLIO_VALUE,
  PORTFOLIO_COPY,
  UNASSIGNED_VALUE,
  statusLabel,
  type PortfolioBroker,
  type PortfolioStatus,
} from '@/lib/portfolios/portfolio';
import {
  assignAllUnassigned,
  assignTradesToPortfolio,
  ensureManualPortfolio,
  renamePortfolio,
  setPortfolioHidden,
} from '@/lib/portfolios/read';
import LivePnlSlot from './LivePnlSlot';

// ── Design tokens, the ones this screen uses ────────────────────────────────
const SURF = 'var(--color-tg-surface)';
const SURF2 = 'var(--color-tg-surface-2)';
const BORDER = 'var(--color-tg-border)';
const MUTED = 'var(--color-tg-muted)';
const TEXT = 'var(--color-tg-text)';
const GREEN = 'var(--color-tg-success)';
const RED = 'var(--color-tg-danger)';

/** One card's worth of already-computed facts. Nothing derivable is derived here. */
export interface PortfolioCardData {
  id: string;
  /** `nickname ?? display_name`, resolved on the server. */
  label: string;
  /** The broker's own name, only when the trader has renamed over it. */
  brokerName: string | null;
  broker: PortfolioBroker;
  status: PortfolioStatus;
  hidden: boolean;
  trades: number;
  netPnl: number;
  winRate: number | null;
  lastTradeLabel: string | null;
}

/** One row in the "ללא תיק" picker. */
export interface UnassignedTrade {
  id: string;
  symbol: string | null;
  dateLabel: string | null;
}

interface Props {
  userId: string;
  cards: PortfolioCardData[];
  unassignedCount: number;
  unassignedPnl: number;
  unassignedWinRate: number | null;
  unassignedSample: UnassignedTrade[];
}

export default function AccountsClient({
  userId, cards, unassignedCount, unassignedPnl, unassignedWinRate, unassignedSample,
}: Props) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showHidden, setShowHidden] = useState(false);

  const visible = cards.filter((card) => !card.hidden);
  const hidden = cards.filter((card) => card.hidden);

  /** Every write on this screen goes through here: one busy flag, one error
   *  line, one refresh. A failed write leaves the card exactly as it was —
   *  there is no optimistic update, because an assignment that appears to
   *  have happened and did not is worse than a slow one that did. */
  async function run(write: () => Promise<boolean>) {
    setBusy(true);
    setError('');
    const ok = await write();
    setBusy(false);
    if (!ok) {
      setError('לא הצלחנו לשמור את השינוי. אפשר לנסות שוב.');
      return false;
    }
    router.refresh();
    return true;
  }

  return (
    <div className="flex flex-col gap-5">
      {error !== '' && (
        <p role="alert" className="text-xs" style={{ color: RED }}>{error}</p>
      )}

      {visible.length === 0 && unassignedCount === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {visible.map((card) => (
            <PortfolioCard
              key={card.id}
              card={card}
              busy={busy}
              onRename={(nickname) => run(() => renamePortfolio(supabase, userId, card.id, nickname))}
              onHide={() => run(() => setPortfolioHidden(supabase, userId, card.id, true))}
            />
          ))}
        </div>
      )}

      {unassignedCount > 0 && (
        <UnassignedCard
          count={unassignedCount}
          netPnl={unassignedPnl}
          winRate={unassignedWinRate}
          sample={unassignedSample}
          targets={visible}
          busy={busy}
          onAssign={(ids, portfolioId) =>
            run(() => assignTradesToPortfolio(supabase, userId, ids, portfolioId))}
          onAssignAll={(portfolioId) =>
            run(() => assignAllUnassigned(supabase, userId, portfolioId))}
          onCreate={(name) => ensureManualPortfolio(supabase, userId, name, true)}
        />
      )}

      {hidden.length > 0 && (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setShowHidden((v) => !v)}
            aria-expanded={showHidden}
            className="self-start flex items-center gap-1.5 text-xs font-semibold rounded-xl px-3 py-1.5 border transition-colors"
            style={{ background: SURF, borderColor: BORDER, color: MUTED }}
          >
            <Eye aria-hidden="true" size={13} />
            תיקים מוסתרים ({hidden.length})
          </button>
          {showHidden && (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {hidden.map((card) => (
                <PortfolioCard
                  key={card.id}
                  card={card}
                  busy={busy}
                  onRename={(nickname) => run(() => renamePortfolio(supabase, userId, card.id, nickname))}
                  onUnhide={() => run(() => setPortfolioHidden(supabase, userId, card.id, false))}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── The card ────────────────────────────────────────────────────────────────

function PortfolioCard({ card, busy, onRename, onHide, onUnhide }: {
  card: PortfolioCardData;
  busy: boolean;
  onRename: (nickname: string) => Promise<boolean>;
  onHide?: () => Promise<boolean>;
  onUnhide?: () => Promise<boolean>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(card.label);
  const [confirmHide, setConfirmHide] = useState(false);

  const closed = card.status === 'closed';

  return (
    <div
      className="relative rounded-2xl border p-4 flex flex-col gap-3"
      style={{ background: SURF, borderColor: BORDER, opacity: card.hidden ? 0.65 : 1 }}
    >
      {/* ── Heading row ──────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="relative z-10 flex items-center gap-1.5">
              <label className="sr-only" htmlFor={`rename-${card.id}`}>שם התיק</label>
              <input
                id={`rename-${card.id}`}
                autoFocus
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="flex-1 min-w-0 h-8 px-2 rounded-lg text-sm border focus:outline-none focus:border-tg-primary"
                style={{ background: SURF2, borderColor: BORDER, color: TEXT }}
              />
              <IconButton
                label="שמור שם"
                disabled={busy}
                onClick={async () => {
                  if (await onRename(draft)) setRenaming(false);
                }}
              >
                <Check aria-hidden="true" size={14} />
              </IconButton>
              <IconButton
                label="בטל"
                onClick={() => { setDraft(card.label); setRenaming(false); }}
              >
                <X aria-hidden="true" size={14} />
              </IconButton>
            </div>
          ) : (
            <>
              {/* The only link on the card, stretched over all of it. */}
              <Link
                href={`/trades?account=${card.id}`}
                className="text-sm font-bold truncate block after:content-[''] after:absolute after:inset-0 after:rounded-2xl"
                style={{ color: TEXT }}
              >
                {card.label}
              </Link>
              {/* The broker's own name, kept visible under a rename so the
                  trader can still tell which account they renamed. */}
              {card.brokerName !== null && (
                <p className="text-[11px] truncate" style={{ color: MUTED }}>{card.brokerName}</p>
              )}
            </>
          )}
        </div>

        <div className="relative z-10 flex items-center gap-1 shrink-0">
          <StatusChip status={card.status} manual={card.broker === 'manual'} />
          {!renaming && (
            <IconButton label="שנה שם" disabled={busy} onClick={() => { setDraft(card.label); setRenaming(true); }}>
              <Pencil aria-hidden="true" size={13} />
            </IconButton>
          )}
          {!renaming && onHide && (
            <IconButton label="הסתר תיק" title={PORTFOLIO_COPY.hide} disabled={busy} onClick={() => setConfirmHide(true)}>
              <EyeOff aria-hidden="true" size={13} />
            </IconButton>
          )}
          {!renaming && onUnhide && (
            <IconButton label="הצג תיק" disabled={busy} onClick={() => void onUnhide()}>
              <Eye aria-hidden="true" size={13} />
            </IconButton>
          )}
        </div>
      </div>

      {/* The "נסגר" sentence, always, directly under the chip it explains.
          A trader who sees a portfolio marked closed wants to know in the same
          glance whether their trades went with it. */}
      {closed && (
        <p className="text-[11px] leading-snug" style={{ color: MUTED }}>
          {PORTFOLIO_COPY.closedStatus}
        </p>
      )}

      {/* The hide confirm, carrying its own sentence. Inline rather than a
          modal: the trader is three words from undoing it either way, and the
          sentence is the whole of what they need to decide. */}
      {confirmHide && (
        <div className="relative z-10 rounded-xl p-3 flex flex-col gap-2" style={{ background: SURF2, border: `1px solid ${BORDER}` }}>
          <p className="text-[11px] leading-snug" style={{ color: TEXT }}>{PORTFOLIO_COPY.hide}</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={async () => { if (await onHide!()) setConfirmHide(false); }}
              className="px-3 py-1 rounded-lg text-xs font-semibold disabled:opacity-50"
              style={{ background: 'rgba(0,210,210,0.12)', color: '#00d2d2' }}
            >
              הסתר
            </button>
            <button
              type="button"
              onClick={() => setConfirmHide(false)}
              className="px-3 py-1 rounded-lg text-xs font-semibold"
              style={{ color: MUTED }}
            >
              ביטול
            </button>
          </div>
        </div>
      )}

      {/* ── REF-108's reserved region. Fixed height, above the figures. ── */}
      <LivePnlSlot portfolioId={card.id} />

      {/* ── The three realised figures ───────────────────────────────── */}
      <div className="grid grid-cols-3 gap-2">
        <Figure label="עסקאות" value={String(card.trades)} />
        <Figure
          label="רווח/הפסד"
          value={card.trades === 0 ? '—' : formatMoney(card.netPnl, { decimals: 0 })}
          color={card.trades === 0 ? undefined : card.netPnl < 0 ? RED : GREEN}
          ltr
        />
        <Figure label="אחוז הצלחה" value={card.winRate === null ? '—' : `${card.winRate}%`} ltr />
      </div>

      <p className="text-[11px]" style={{ color: MUTED }}>
        עסקה אחרונה{' '}
        <span style={{ color: card.lastTradeLabel ? TEXT : MUTED }}>
          {card.lastTradeLabel ?? '—'}
        </span>
      </p>
    </div>
  );
}

function Figure({ label, value, color, ltr }: {
  label: string; value: string; color?: string; ltr?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] font-semibold truncate" style={{ color: MUTED }}>{label}</span>
      {/* dir="ltr" on the amounts: a bare "-$2,000" dropped into Hebrew flow
          has its sign carried to the wrong end (lib/money.ts's header). */}
      <span
        dir={ltr ? 'ltr' : undefined}
        className="text-base font-bold truncate"
        style={{ color: color ?? TEXT, textAlign: 'right' }}
      >
        {value}
      </span>
    </div>
  );
}

function StatusChip({ status, manual }: { status: PortfolioStatus; manual: boolean }) {
  const tone =
    status === 'active' ? { bg: 'rgba(34,197,94,0.12)', fg: GREEN }
    : status === 'closed' ? { bg: 'rgba(239,68,68,0.10)', fg: RED }
    : { bg: 'var(--color-tg-surface-2)', fg: MUTED };

  return (
    <span
      // The same sentence the sub-line carries, for the pointer. The sub-line
      // is the accessible one; this is a convenience, not the explanation.
      title={status === 'closed' ? PORTFOLIO_COPY.closedStatus : undefined}
      className="px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap"
      style={{ background: tone.bg, color: tone.fg }}
    >
      {manual && status === 'active' ? 'ידני' : statusLabel(status)}
    </span>
  );
}

function IconButton({ label, title, disabled, onClick, children }: {
  label: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors hover:bg-white/5 disabled:opacity-40"
      style={{ color: MUTED }}
    >
      {children}
    </button>
  );
}

// ── The "ללא תיק" bucket ────────────────────────────────────────────────────

function UnassignedCard({
  count, netPnl, winRate, sample, targets, busy, onAssign, onAssignAll, onCreate,
}: {
  count: number;
  netPnl: number;
  winRate: number | null;
  sample: UnassignedTrade[];
  targets: PortfolioCardData[];
  busy: boolean;
  onAssign: (ids: string[], portfolioId: string) => Promise<boolean>;
  onAssignAll: (portfolioId: string) => Promise<boolean>;
  onCreate: (name: string) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<string>(UNASSIGNED_VALUE);
  const [newName, setNewName] = useState('');

  const truncated = count > sample.length;

  /** The portfolio the trader picked, creating it first if they chose
   *  "תיק חדש…". Lazily, and once by name — the same function and the same
   *  guarantee as the trade form's. A trader whose only portfolios are
   *  broker ones would otherwise have no way to file a manual backlog
   *  without first logging a trade. */
  async function resolveTarget(): Promise<string | null> {
    if (target === NEW_PORTFOLIO_VALUE) return onCreate(newName);
    return target === UNASSIGNED_VALUE ? null : target;
  }

  return (
    <div className="rounded-2xl border p-4 flex flex-col gap-3" style={{ background: SURF, borderColor: BORDER }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-bold flex items-center gap-1.5" style={{ color: TEXT }}>
            <Inbox aria-hidden="true" size={15} />
            ללא תיק
          </h2>
          {/* Always on, because this card is the one thing on the screen the
              trader did not create and has to understand. */}
          <p className="text-[11px] mt-0.5 leading-snug" style={{ color: MUTED }}>
            {PORTFOLIO_COPY.unassigned}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="shrink-0 px-3 py-1.5 rounded-xl text-xs font-semibold"
          style={{ background: 'rgba(0,210,210,0.12)', color: '#00d2d2' }}
        >
          {open ? 'סגור' : 'שייך עסקאות'}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Figure label="עסקאות" value={String(count)} />
        <Figure
          label="רווח/הפסד"
          value={formatMoney(netPnl, { decimals: 0 })}
          color={netPnl < 0 ? RED : GREEN}
          ltr
        />
        <Figure label="אחוז הצלחה" value={winRate === null ? '—' : `${winRate}%`} ltr />
      </div>

      {open && (
        <div className="flex flex-col gap-3 pt-1">
          <div className="flex flex-col gap-1">
            <label htmlFor="assign-target" className="text-xs font-medium" style={{ color: MUTED }}>שייך לתיק</label>
            <select
              id="assign-target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="w-full h-10 px-3 rounded-xl text-sm border focus:outline-none focus:border-tg-primary appearance-none cursor-pointer"
              style={{ background: SURF2, borderColor: BORDER, color: TEXT }}
            >
              <option value={UNASSIGNED_VALUE}>בחר תיק…</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
              <option value={NEW_PORTFOLIO_VALUE}>תיק חדש…</option>
            </select>
            {target === NEW_PORTFOLIO_VALUE && (
              <div className="flex flex-col gap-1 mt-1">
                <label htmlFor="assign-new-name" className="text-xs font-medium" style={{ color: MUTED }}>שם התיק החדש</label>
                <input
                  id="assign-new-name"
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="למשל: אינטראקטיב, אישי"
                  className="w-full h-10 px-3 rounded-xl text-sm border focus:outline-none focus:border-tg-primary"
                  style={{ background: SURF2, borderColor: BORDER, color: TEXT }}
                />
                <p className="text-[11px]" style={{ color: MUTED }}>{PORTFOLIO_COPY.createManual}</p>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              disabled={busy || selected.size === 0}
              onClick={async () => {
                const id = await resolveTarget();
                if (id === null) return;
                if (await onAssign([...selected], id)) setSelected(new Set());
              }}
              className="px-3 py-1.5 rounded-xl text-xs font-bold disabled:opacity-40"
              style={{ background: '#00d2d2', color: '#000' }}
            >
              שייך {selected.size > 0 ? `(${selected.size})` : ''}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                const id = await resolveTarget();
                if (id === null) return;
                if (await onAssignAll(id)) setSelected(new Set());
              }}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold border disabled:opacity-40"
              style={{ borderColor: BORDER, color: TEXT }}
            >
              שייך את כל {count} העסקאות
            </button>
            <button
              type="button"
              onClick={() => setSelected(
                selected.size === sample.length ? new Set() : new Set(sample.map((t) => t.id)),
              )}
              className="text-xs font-semibold"
              style={{ color: MUTED }}
            >
              {selected.size === sample.length ? 'נקה בחירה' : 'בחר הכל ברשימה'}
            </button>
          </div>

          {/* The list is bounded; the "assign all" button above is not. Saying
              so is the difference between a trader filing 200 of 800 rows and
              thinking they are done, and filing all 800. */}
          {truncated && (
            <p className="text-[11px]" style={{ color: MUTED }}>
              מוצגות {sample.length} העסקאות האחרונות מתוך {count}. הכפתור &quot;שייך את כל {count} העסקאות&quot; מטפל בכולן.
            </p>
          )}

          <ul className="flex flex-col gap-1 max-h-72 overflow-y-auto rounded-xl p-2" style={{ background: SURF2 }}>
            {sample.map((t) => (
              <li key={t.id}>
                <label className="flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-white/5">
                  <input
                    type="checkbox"
                    checked={selected.has(t.id)}
                    onChange={(e) => setSelected((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(t.id);
                      else next.delete(t.id);
                      return next;
                    })}
                  />
                  <span className="text-xs font-semibold" style={{ color: TEXT }}>{t.symbol ?? '—'}</span>
                  <span className="text-[11px]" style={{ color: MUTED }}>{t.dateLabel ?? ''}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div
      className="text-center py-12 rounded-2xl border"
      style={{ background: SURF, borderColor: BORDER }}
    >
      <div className="mb-3 flex justify-center" style={{ color: MUTED }}>
        <Inbox aria-hidden="true" size={36} />
      </div>
      <h3 className="text-base font-semibold mb-1" style={{ color: TEXT }}>אין עדיין תיקים</h3>
      <p className="text-sm" style={{ color: 'var(--color-tg-text-2)' }}>
        תיק מהברוקר נוצר לבד בסנכרון הבא. תיק ידני נוצר מתוך טופס העסקה, בשדה &quot;תיק&quot;.
      </p>
    </div>
  );
}
