'use client';

import { Search, BookOpen } from 'lucide-react';
import {
  PAGE_TYPES, GOLD, BORDER, SURF, MUTED, TEXT, TEXT2, inputBase,
  tagChipStyle, formatDateTime,
  type NotebookPage,
} from './notebook-shared';

interface NotebookPageListProps {
  pages: NotebookPage[];
  search: string;
  onSearchChange: (value: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

export default function NotebookPageList({
  pages, search, onSearchChange, selectedId, onSelect, onDelete,
}: NotebookPageListProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: SURF, borderRight: `1px solid ${BORDER}`, borderLeft: `1px solid ${BORDER}` }}>
      {/* Header */}
      <div style={{ padding: '12px', borderBottom: `1px solid ${BORDER}`, display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ position: 'relative' }}>
          <Search size={13} color={MUTED} style={{ position: 'absolute', top: '50%', right: 10, transform: 'translateY(-50%)', pointerEvents: 'none' }} />
          <input
            type="text" placeholder="חיפוש דפים..." value={search}
            onChange={e => onSearchChange(e.target.value)}
            style={{ ...inputBase, fontSize: 12, padding: '6px 30px 6px 10px', direction: 'rtl' }}
          />
        </div>
        <p style={{ fontSize: 11, color: MUTED, padding: '0 2px' }}>{pages.length} דפים</p>
      </div>

      {/* Cards */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {pages.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: MUTED, fontSize: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            <BookOpen size={28} />
            {search ? 'אין תוצאות' : 'אין דפים עדיין'}
          </div>
        ) : pages.map(page => {
          const tc = PAGE_TYPES.find(t => t.value === page.page_type);
          const active = page.id === selectedId;
          return (
            <div
              key={page.id}
              onClick={() => onSelect(page.id)}
              className="rounded-2xl"
              style={{
                padding: '12px', cursor: 'pointer',
                background:   active ? 'rgba(0,210,210,0.08)' : 'var(--color-tg-bg)',
                border:       `1px solid ${active ? GOLD : BORDER}`,
                direction: 'rtl',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: GOLD, display: 'flex', flexShrink: 0 }}>{tc?.icon}</span>
                <span style={{ flex: 1, fontSize: 13.5, fontWeight: 700, color: active ? GOLD : TEXT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {page.title}
                </span>
                <button
                  onClick={e => { e.stopPropagation(); onDelete(page.id); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: MUTED, flexShrink: 0, padding: 2, borderRadius: 4 }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>

              <div style={{ fontSize: 10.5, color: MUTED, marginTop: 4 }}>
                {formatDateTime(page.created_at)}
              </div>

              {page.content && (
                <p style={{ fontSize: 11.5, color: TEXT2, marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {page.content.slice(0, 60)}
                </p>
              )}

              {page.tags.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 7 }}>
                  {page.tags.map(tag => (
                    <span key={tag} style={{ ...tagChipStyle(tag), padding: '1.5px 7px', borderRadius: 999, fontSize: 10, fontWeight: 600 }}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
