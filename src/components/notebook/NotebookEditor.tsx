'use client';

import { BookOpen } from 'lucide-react';
import {
  PAGE_TYPES, PRESET_TAGS, GOLD, BORDER, SURF, MUTED, TEXT, TEXT2, inputBase, btnStyle,
  tagChipStyle, formatDateLong,
  type NotebookPage, type SaveStatus, type PageType,
} from './notebook-shared';

interface NotebookEditorProps {
  selected: NotebookPage | null;
  saveStatus: SaveStatus;
  tagInput: string;
  onTagInputChange: (value: string) => void;
  onAddTag: () => void;
  onToggleTag: (tag: string) => void;
  onUpdateField: <K extends keyof NotebookPage>(field: K, value: NotebookPage[K]) => void;
  onCreate: () => void;
}

export default function NotebookEditor({
  selected, saveStatus, tagInput, onTagInputChange, onAddTag, onToggleTag, onUpdateField, onCreate,
}: NotebookEditorProps) {
  if (!selected) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, direction: 'rtl', height: '100%', color: MUTED }}>
        <BookOpen size={48} />
        <p style={{ fontSize: 14 }}>בחר דף קיים או צור אחד חדש</p>
        <button onClick={onCreate} style={{ ...btnStyle, width: 'auto', padding: '9px 20px' }}>+ דף חדש</button>
      </div>
    );
  }

  const customTags = selected.tags.filter(t => !PRESET_TAGS.includes(t));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', direction: 'rtl' }}>
      {/* Header */}
      <div style={{ borderBottom: `1px solid ${BORDER}`, background: SURF }}>
        {/* Title + save status */}
        <div style={{ padding: '12px 16px 8px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            value={selected.title}
            onChange={e => onUpdateField('title', e.target.value)}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 18, fontWeight: 700, color: TEXT, direction: 'rtl' }}
            placeholder="כותרת הדף"
          />
          <SaveBadge status={saveStatus} />
        </div>

        {/* Page type + dates */}
        <div style={{ padding: '0 16px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {PAGE_TYPES.map(t => {
              const active = selected.page_type === t.value;
              return (
                <button key={t.value}
                  onClick={() => onUpdateField('page_type', t.value as PageType)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                    padding: '4px 10px', borderRadius: 999,
                    border:      `1px solid ${active ? t.color : BORDER}`,
                    background:  active ? `${t.color}18` : 'transparent',
                    color:       active ? t.color : TEXT2,
                    fontSize:    11.5, fontWeight: 600,
                  }}>
                  <span style={{ color: GOLD, display: 'flex' }}>{t.icon}</span>
                  {t.label}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 10.5, color: MUTED, fontWeight: 600, display: 'flex', gap: 10 }}>
            <span>נוצר: {formatDateLong(selected.created_at)}</span>
            <span>עודכן: {formatDateLong(selected.updated_at)}</span>
          </div>
        </div>

        {/* Tags */}
        <div style={{ padding: '0 16px 12px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5 }}>
          {PRESET_TAGS.map(tag => {
            const on = selected.tags.includes(tag);
            const hex = tagChipStyle(tag);
            return (
              <button key={tag} onClick={() => onToggleTag(tag)} style={{
                padding: '3px 9px', borderRadius: 999, cursor: 'pointer', fontSize: 11, fontWeight: 600,
                border:     on ? hex.border : `1px solid ${BORDER}`,
                background: on ? hex.background : 'transparent',
                color:      on ? hex.color : MUTED,
              }}>{tag}</button>
            );
          })}

          {customTags.map(tag => (
            <span key={tag} style={{ ...tagChipStyle(tag), display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 999, fontSize: 11, fontWeight: 600 }}>
              {tag}
              <button onClick={() => onToggleTag(tag)} className="hit-40 relative" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, lineHeight: 1 }}>×</button>
            </span>
          ))}

          <input
            value={tagInput}
            onChange={e => onTagInputChange(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && onAddTag()}
            placeholder="+ תגית חדשה"
            style={{ ...inputBase, width: 110, fontSize: 11, padding: '4px 8px', direction: 'rtl' }}
          />
        </div>
      </div>

      {/* Body */}
      <textarea
        value={selected.content}
        onChange={e => onUpdateField('content', e.target.value)}
        placeholder="התחל לכתוב..."
        style={{
          flex: 1, padding: '20px 24px',
          background: 'transparent', border: 'none', outline: 'none',
          resize: 'none', fontSize: 15, lineHeight: '1.85',
          color: TEXT, fontFamily: 'var(--font-sans)', direction: 'rtl',
        }}
      />

      {/* Footer */}
      <div style={{ padding: '5px 16px', borderTop: `1px solid ${BORDER}`, fontSize: 10, color: MUTED, textAlign: 'left' }}>
        {selected.content.trim().split(/\s+/).filter(Boolean).length} מילים
        &nbsp;·&nbsp;{selected.content.length} תווים
      </div>
    </div>
  );
}

function SaveBadge({ status }: { status: SaveStatus }) {
  const map = {
    saved:   { text: 'נשמר',         color: '#4ade80' },
    saving:  { text: '⟳ שומר...',   color: 'var(--color-tg-muted)' },
    unsaved: { text: '● לא נשמר',   color: 'var(--color-tg-warning)' },
    error:   { text: 'שגיאה',        color: '#f87171' },
  };
  const s = map[status];
  return <span style={{ fontSize: 11, color: s.color, flexShrink: 0, transition: 'color 0.2s' }}>{s.text}</span>;
}
