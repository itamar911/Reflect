'use client';

import { Plus, Layers, Folder, Tag as TagIcon } from 'lucide-react';
import {
  PAGE_TYPES, GOLD, SURF, MUTED, TEXT, TEXT2, btnStyle, tagHex,
  type PageType,
} from './notebook-shared';

interface NotebookSidebarProps {
  activeFolder: PageType | 'all';
  activeTag: string | null;
  tagsInUse: string[];
  onFolderChange: (folder: PageType | 'all') => void;
  onTagChange: (tag: string | null) => void;
  onCreate: () => void;
}

export default function NotebookSidebar({
  activeFolder, activeTag, tagsInUse, onFolderChange, onTagChange, onCreate,
}: NotebookSidebarProps) {
  const allActive = activeFolder === 'all' && activeTag === null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: SURF, padding: 12, gap: 16, overflowY: 'auto', direction: 'rtl' }}>
      <button onClick={onCreate} style={btnStyle}>
        <Plus size={13} />
        דף חדש
      </button>

      <button
        onClick={() => { onFolderChange('all'); onTagChange(null); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          padding: '8px 10px', borderRadius: 10, cursor: 'pointer', border: 'none',
          background: allActive ? 'rgba(0,210,210,0.12)' : 'transparent',
          color: allActive ? GOLD : TEXT,
          fontSize: 13, fontWeight: allActive ? 600 : 500, textAlign: 'right',
        }}
      >
        <Layers size={14} />
        כל הדפים
      </button>

      <section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '0 2px', marginBottom: 6 }}>
          <Folder size={11} color={MUTED} />
          <p style={{ fontSize: 11, fontWeight: 600, color: MUTED }}>תיקיות</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {PAGE_TYPES.map(t => {
            const active = activeFolder === t.value;
            return (
              <button
                key={t.value}
                onClick={() => onFolderChange(t.value)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '7px 10px', borderRadius: 10, cursor: 'pointer',
                  border: `1px solid ${active ? t.color : 'transparent'}`,
                  background: active ? `${t.color}18` : 'transparent',
                  color: active ? t.color : TEXT2,
                  fontSize: 12.5, fontWeight: 600, textAlign: 'right',
                }}
              >
                <span style={{ color: GOLD, display: 'flex' }}>{t.icon}</span>
                {t.label}
              </button>
            );
          })}
        </div>
      </section>

      {tagsInUse.length > 0 && (
        <section>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '0 2px', marginBottom: 6 }}>
            <TagIcon size={11} color={MUTED} />
            <p style={{ fontSize: 11, fontWeight: 600, color: MUTED }}>תגים</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {tagsInUse.map(tag => {
              const active = activeTag === tag;
              const hex = tagHex(tag);
              return (
                <button
                  key={tag}
                  onClick={() => onTagChange(active ? null : tag)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    padding: '6px 10px', borderRadius: 10, cursor: 'pointer',
                    border: `1px solid ${active ? hex : 'transparent'}`,
                    background: active ? `${hex}18` : 'transparent',
                    color: active ? hex : TEXT2,
                    fontSize: 12, fontWeight: 600, textAlign: 'right',
                  }}
                >
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: hex, flexShrink: 0 }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tag}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
