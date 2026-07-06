import type { CSSProperties, ReactNode } from 'react';
import { BookOpen, Lightbulb, ClipboardList } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PageType = 'journal' | 'insights' | 'plan';
export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error';

export interface NotebookPage {
  id: string;
  user_id: string;
  title: string;
  content: string;
  page_type: PageType;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface PageTypeConfig {
  value: PageType;
  label: string;
  icon: ReactNode;
  color: string;
}

// ── Config ────────────────────────────────────────────────────────────────────

export const PAGE_TYPES: PageTypeConfig[] = [
  { value: 'journal',  label: 'יומן יומי',     icon: <BookOpen size={14} />,      color: '#60A5FA' },
  { value: 'insights', label: 'תובנות מסחר',   icon: <Lightbulb size={14} />,     color: '#00d2d2' },
  { value: 'plan',     label: 'תוכנית מסחר',   icon: <ClipboardList size={14} />, color: '#4ade80' },
];

export const PRESET_TAGS = ['חשוב', 'אסטרטגיה', 'פסיכולוגיה', 'ריגשי', 'ניהול סיכונים', 'לבדיקה'];

export const GOLD   = '#00d2d2';
export const BORDER = 'var(--color-tg-border)';
export const SURF   = 'var(--color-tg-surface)';
export const SURF2  = 'var(--color-tg-surface-2)';
export const MUTED  = 'var(--color-tg-muted)';
export const TEXT   = 'var(--color-tg-text)';
export const TEXT2  = 'var(--color-tg-text-2)';

// ── Tag color helper ────────────────────────────────────────────────────────
// Deterministic hash → fixed 8-color palette, so a given tag always renders
// with the same chip color everywhere (sidebar, cards, editor) without
// persisting a color anywhere.

const TAG_PALETTE = ['#f87171', '#60a5fa', '#a78bfa', '#4ade80', '#fbbf24', '#f472b6', '#22d3ee', '#fb923c'];

function hashTag(tag: string): number {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return h % TAG_PALETTE.length;
}

export function tagHex(tag: string): string {
  return TAG_PALETTE[hashTag(tag)];
}

export function tagChipStyle(tag: string): CSSProperties {
  const hex = tagHex(tag);
  return {
    color: hex,
    background: `${hex}1a`,
    border: `1px solid ${hex}40`,
  };
}

// ── Date formatting ───────────────────────────────────────────────────────────

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long' });
  const time = d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${time}`;
}

export function formatDateLong(iso: string): string {
  return new Date(iso).toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ── Shared style helpers ──────────────────────────────────────────────────────

export const btnStyle: CSSProperties = {
  width: '100%', padding: '9px 12px', borderRadius: 10,
  background: GOLD, color: '#0a0a0f',
  fontSize: 13, fontWeight: 600,
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  cursor: 'pointer', border: 'none', direction: 'rtl',
};

export const inputBase: CSSProperties = {
  width: '100%', padding: '7px 10px', borderRadius: 8,
  background: SURF2, border: `1px solid ${BORDER}`,
  color: TEXT, outline: 'none', boxSizing: 'border-box',
};
