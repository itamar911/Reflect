'use client';

import { useState, useRef, useCallback, type CSSProperties } from 'react';
import { createClient } from '@/lib/supabase/client';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NotebookPage {
  id: string;
  user_id: string;
  title: string;
  content: string;
  page_type: 'journal' | 'insights' | 'plan';
  tags: string[];
  created_at: string;
  updated_at: string;
}

type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error';
type MobilePanel = 'list' | 'editor';

// ── Config ────────────────────────────────────────────────────────────────────

const PAGE_TYPES = [
  { value: 'journal',  label: 'יומן יומי',     icon: '📔', color: '#60A5FA' },
  { value: 'insights', label: 'תובנות מסחר',   icon: '💡', color: '#D4AF37' },
  { value: 'plan',     label: 'תוכנית מסחר',   icon: '📋', color: '#4ade80' },
] as const;

const PRESET_TAGS = ['חשוב', 'אסטרטגיה', 'פסיכולוגיה', 'ריגשי', 'ניהול סיכונים', 'לבדיקה'];

const GOLD   = '#D4AF37';
const BORDER = 'var(--color-tg-border)';
const SURF   = 'var(--color-tg-surface)';
const SURF2  = 'var(--color-tg-surface-2)';
const MUTED  = 'var(--color-tg-muted)';
const TEXT   = 'var(--color-tg-text)';
const TEXT2  = 'var(--color-tg-text-2)';

// ── Root component ────────────────────────────────────────────────────────────

export default function NotebookClient({
  initialPages,
  userId,
}: {
  initialPages: NotebookPage[];
  userId: string;
}) {
  const [pages,      setPages]      = useState<NotebookPage[]>(initialPages);
  const [selectedId, setSelectedId] = useState<string | null>(initialPages[0]?.id ?? null);
  const [search,     setSearch]     = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [panel,      setPanel]      = useState<MobilePanel>('list');
  const [tagInput,   setTagInput]   = useState('');

  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const supabase  = createClient();

  const selected     = pages.find(p => p.id === selectedId) ?? null;
  const filteredPages = pages.filter(p => {
    const q = search.trim().toLowerCase();
    return !q || p.title.toLowerCase().includes(q) || p.content.toLowerCase().includes(q);
  });

  // ── Auto-save ───────────────────────────────────────────────────────────────
  const scheduleSave = useCallback((id: string, patch: Partial<NotebookPage>) => {
    setSaveStatus('unsaved');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveStatus('saving');
      const { error } = await supabase
        .from('notebook_pages')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id);
      setSaveStatus(error ? 'error' : 'saved');
    }, 1400);
  }, [supabase]);

  function updateField<K extends keyof NotebookPage>(field: K, value: NotebookPage[K]) {
    if (!selected) return;
    const patch = { [field]: value } as Partial<NotebookPage>;
    setPages(prev => prev.map(p => p.id === selected.id
      ? { ...p, ...patch, updated_at: new Date().toISOString() }
      : p));
    scheduleSave(selected.id, patch);
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────
  async function createPage() {
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from('notebook_pages')
      .insert({ user_id: userId, title: 'דף ללא כותרת', content: '', page_type: 'journal', tags: [] })
      .select().single();
    if (!error && data) {
      setPages(prev => [data as NotebookPage, ...prev]);
      setSelectedId(data.id);
      setPanel('editor');
      setSaveStatus('saved');
    }
  }

  async function deletePage(id: string) {
    await supabase.from('notebook_pages').delete().eq('id', id);
    setPages(prev => prev.filter(p => p.id !== id));
    if (selectedId === id) {
      const rest = pages.filter(p => p.id !== id);
      setSelectedId(rest[0]?.id ?? null);
      if (rest.length === 0) setPanel('list');
    }
  }

  function toggleTag(tag: string) {
    if (!selected) return;
    const next = selected.tags.includes(tag)
      ? selected.tags.filter(t => t !== tag)
      : [...selected.tags, tag];
    updateField('tags', next);
  }

  function addCustomTag() {
    const t = tagInput.trim();
    if (!t || !selected || selected.tags.includes(t)) { setTagInput(''); return; }
    updateField('tags', [...selected.tags, t]);
    setTagInput('');
  }

  function selectPage(id: string) {
    setSelectedId(id);
    setPanel('editor');
  }

  // ── Shared column renders ──────────────────────────────────────────────────

  function renderPageList() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: SURF, borderLeft: `1px solid ${BORDER}` }}>
        {/* Header */}
        <div style={{ padding: '12px', borderBottom: `1px solid ${BORDER}`, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button onClick={createPage} style={btnStyle}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            דף חדש
          </button>
          <input
            type="text" placeholder="חיפוש..." value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ ...inputBase, fontSize: 12, padding: '6px 10px', direction: 'rtl' }}
          />
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {filteredPages.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: MUTED, fontSize: 12 }}>
              {search ? 'אין תוצאות' : 'אין דפים עדיין'}
            </div>
          ) : filteredPages.map(page => {
            const tc = PAGE_TYPES.find(t => t.value === page.page_type);
            const active = page.id === selectedId;
            return (
              <div
                key={page.id}
                onClick={() => selectPage(page.id)}
                style={{
                  padding: '10px 12px', cursor: 'pointer',
                  borderBottom: `1px solid ${BORDER}`,
                  background:   active ? 'rgba(212,175,55,0.07)' : 'transparent',
                  borderRight:  active ? `3px solid ${GOLD}` : '3px solid transparent',
                  direction: 'rtl',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13 }}>{tc?.icon}</span>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: active ? GOLD : TEXT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {page.title}
                  </span>
                  <button
                    onClick={e => { e.stopPropagation(); deletePage(page.id); }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: MUTED, flexShrink: 0, padding: 2, borderRadius: 4 }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>
                <div style={{ fontSize: 10, color: MUTED, marginTop: 2 }}>
                  {new Date(page.updated_at).toLocaleDateString('he-IL', { day: 'numeric', month: 'short' })}
                  {page.tags.length > 0 && <span> · {page.tags.length} תגיות</span>}
                </div>
                {page.content && (
                  <p style={{ fontSize: 11, color: TEXT2, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {page.content.slice(0, 55)}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ padding: '7px 12px', borderTop: `1px solid ${BORDER}`, fontSize: 10, color: MUTED, textAlign: 'center' }}>
          {pages.length} דפים
        </div>
      </div>
    );
  }

  function renderEditor() {
    if (!selected) {
      return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, direction: 'rtl' }}>
          <div style={{ fontSize: 48 }}>📓</div>
          <p style={{ color: TEXT2, fontSize: 14 }}>בחר דף או צור דף חדש</p>
          <button onClick={createPage} style={btnStyle}>+ דף חדש</button>
        </div>
      );
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', direction: 'rtl' }}>
        {/* Title bar */}
        <div style={{ padding: '10px 16px', borderBottom: `1px solid ${BORDER}`, background: SURF, display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            value={selected.title}
            onChange={e => updateField('title', e.target.value)}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 18, fontWeight: 700, color: TEXT, direction: 'rtl' }}
            placeholder="כותרת הדף"
          />
          <SaveBadge status={saveStatus} />
        </div>

        {/* Textarea */}
        <textarea
          value={selected.content}
          onChange={e => updateField('content', e.target.value)}
          placeholder="התחל לכתוב..."
          style={{
            flex: 1, padding: '20px 24px',
            background: 'transparent', border: 'none', outline: 'none',
            resize: 'none', fontSize: 15, lineHeight: '1.85',
            color: TEXT, fontFamily: 'var(--font-sans)', direction: 'rtl',
          }}
        />

        {/* Word count */}
        <div style={{ padding: '5px 16px', borderTop: `1px solid ${BORDER}`, fontSize: 10, color: MUTED, textAlign: 'left' }}>
          {selected.content.trim().split(/\s+/).filter(Boolean).length} מילים
          &nbsp;·&nbsp;{selected.content.length} תווים
        </div>
      </div>
    );
  }

  function renderMeta() {
    if (!selected) return <div style={{ padding: 20, color: MUTED, fontSize: 12, textAlign: 'center', direction: 'rtl' }}>בחר דף לעריכה</div>;
    return (
      <div style={{ padding: '16px 12px', display: 'flex', flexDirection: 'column', gap: 20, overflowY: 'auto', direction: 'rtl' }}>

        {/* Page type */}
        <section>
          <p style={{ fontSize: 11, fontWeight: 600, color: MUTED, marginBottom: 8 }}>סוג דף</p>
          {PAGE_TYPES.map(t => {
            const active = selected.page_type === t.value;
            return (
              <button key={t.value}
                onClick={() => updateField('page_type', t.value as NotebookPage['page_type'])}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7, width: '100%',
                  padding: '7px 10px', borderRadius: 10, marginBottom: 5, cursor: 'pointer',
                  border:      `1px solid ${active ? t.color : BORDER}`,
                  background:  active ? `${t.color}18` : 'transparent',
                  color:       active ? t.color : TEXT2,
                  fontSize:    12, fontWeight: active ? 600 : 400, textAlign: 'right',
                }}>
                <span>{t.icon}</span>
                <span>{t.label}</span>
              </button>
            );
          })}
        </section>

        {/* Tags */}
        <section>
          <p style={{ fontSize: 11, fontWeight: 600, color: MUTED, marginBottom: 8 }}>תגיות</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
            {PRESET_TAGS.map(tag => {
              const on = selected.tags.includes(tag);
              return (
                <button key={tag} onClick={() => toggleTag(tag)} style={{
                  padding: '3px 8px', borderRadius: 20, cursor: 'pointer', fontSize: 11,
                  border:     `1px solid ${on ? GOLD : BORDER}`,
                  background: on ? 'rgba(212,175,55,0.14)' : 'transparent',
                  color:      on ? GOLD : MUTED,
                  fontWeight: on ? 600 : 400,
                }}>{tag}</button>
              );
            })}
          </div>

          {/* Custom tags */}
          {selected.tags.filter(t => !PRESET_TAGS.includes(t)).map(tag => (
            <span key={tag} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 7px', borderRadius: 20, border: `1px solid ${GOLD}`, background: 'rgba(212,175,55,0.12)', color: GOLD, fontSize: 11, marginLeft: 4, marginBottom: 4 }}>
              {tag}
              <button onClick={() => toggleTag(tag)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, lineHeight: 1 }}>×</button>
            </span>
          ))}

          {/* Add custom tag */}
          <input
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addCustomTag()}
            placeholder="+ תגית חדשה"
            style={{ ...inputBase, fontSize: 11, padding: '5px 8px', marginTop: 6, direction: 'rtl' }}
          />
        </section>

        {/* Dates */}
        <section style={{ fontSize: 10, color: MUTED, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div>נוצר: {new Date(selected.created_at).toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
          <div>עודכן: {new Date(selected.updated_at).toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
        </section>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Desktop: 3-column grid */}
      <div
        className="hidden md:grid"
        style={{ gridTemplateColumns: '236px 1fr 216px', height: '100dvh', direction: 'ltr', overflow: 'hidden' }}
      >
        {/* Col 1 — page list */}
        {renderPageList()}

        {/* Col 2 — editor */}
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--color-tg-bg)', borderLeft: `1px solid ${BORDER}` }}>
          {renderEditor()}
        </div>

        {/* Col 3 — metadata */}
        <div style={{ background: SURF, borderLeft: `1px solid ${BORDER}`, height: '100%', overflowY: 'auto' }}>
          {renderMeta()}
        </div>
      </div>

      {/* Mobile: single panel */}
      <div className="md:hidden flex flex-col" style={{ height: '100dvh', direction: 'rtl' }}>
        {panel === 'list' ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {renderPageList()}
          </div>
        ) : (
          <>
            {/* Back button */}
            <button
              onClick={() => setPanel('list')}
              className="flex items-center gap-1.5 px-4 py-2 text-sm"
              style={{ background: SURF, borderBottom: `1px solid ${BORDER}`, color: TEXT2, flexShrink: 0 }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
              כל הדפים
            </button>

            {/* Editor */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--color-tg-bg)' }}>
              {renderEditor()}
            </div>

            {/* Meta (collapsed inline) */}
            <div style={{ background: SURF, borderTop: `1px solid ${BORDER}`, maxHeight: 240, overflowY: 'auto' }}>
              {renderMeta()}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ── Mini components ───────────────────────────────────────────────────────────

function SaveBadge({ status }: { status: SaveStatus }) {
  const map = {
    saved:   { text: '✓ נשמר',      color: '#4ade80' },
    saving:  { text: '⟳ שומר...',   color: 'var(--color-tg-muted)' },
    unsaved: { text: '● לא נשמר',   color: 'var(--color-tg-warning)' },
    error:   { text: '✗ שגיאה',     color: '#f87171' },
  };
  const s = map[status];
  return <span style={{ fontSize: 11, color: s.color, flexShrink: 0, transition: 'color 0.2s' }}>{s.text}</span>;
}

// ── Shared style helpers ──────────────────────────────────────────────────────

const btnStyle: CSSProperties = {
  width: '100%', padding: '8px 12px', borderRadius: 10,
  background: GOLD, color: '#0a0a0f',
  fontSize: 13, fontWeight: 600,
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  cursor: 'pointer', border: 'none', direction: 'rtl',
};

const inputBase: CSSProperties = {
  width: '100%', padding: '7px 10px', borderRadius: 8,
  background: SURF2, border: `1px solid ${BORDER}`,
  color: TEXT, outline: 'none', boxSizing: 'border-box',
};
