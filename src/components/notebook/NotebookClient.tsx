'use client';

import { useState, useRef, useCallback, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import NotebookSidebar from './NotebookSidebar';
import NotebookPageList from './NotebookPageList';
import NotebookEditor from './NotebookEditor';
import {
  PAGE_TYPES, GOLD, BORDER, SURF, MUTED, TEXT, tagHex,
  type NotebookPage, type PageType, type SaveStatus,
} from './notebook-shared';

export type { NotebookPage };

type MobilePanel = 'list' | 'editor';

export default function NotebookClient({
  initialPages,
  userId,
}: {
  initialPages: NotebookPage[];
  userId: string;
}) {
  const [pages,        setPages]        = useState<NotebookPage[]>(initialPages);
  const [selectedId,   setSelectedId]   = useState<string | null>(initialPages[0]?.id ?? null);
  const [search,       setSearch]       = useState('');
  const [saveStatus,   setSaveStatus]   = useState<SaveStatus>('saved');
  const [panel,        setPanel]        = useState<MobilePanel>('list');
  const [tagInput,     setTagInput]     = useState('');
  const [activeFolder, setActiveFolder] = useState<PageType | 'all'>('all');
  const [activeTag,    setActiveTag]    = useState<string | null>(null);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const supabase  = createClient();

  const selected = pages.find(p => p.id === selectedId) ?? null;

  const tagsInUse = useMemo(
    () => Array.from(new Set(pages.flatMap(p => p.tags))).sort((a, b) => a.localeCompare(b, 'he')),
    [pages]
  );

  const filteredPages = useMemo(() => pages.filter(p => {
    const q = search.trim().toLowerCase();
    const matchesSearch = !q || p.title.toLowerCase().includes(q) || p.content.toLowerCase().includes(q);
    const matchesFolder = activeFolder === 'all' || p.page_type === activeFolder;
    const matchesTag    = activeTag === null || p.tags.includes(activeTag);
    return matchesSearch && matchesFolder && matchesTag;
  }), [pages, search, activeFolder, activeTag]);

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
    const { data, error } = await supabase
      .from('notebook_pages')
      .insert({ user_id: userId, title: 'דף ללא כותרת', content: '', page_type: 'journal', tags: [] })
      .select().single();
    if (!error && data) {
      setPages(prev => [data as NotebookPage, ...prev]);
      setSelectedId(data.id);
      setPanel('editor');
      setSaveStatus('saved');
      setActiveFolder('all');
      setActiveTag(null);
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

  return (
    <>
      {/* Desktop: 3-column layout, right-to-left */}
      <div
        className="hidden md:grid"
        style={{ gridTemplateColumns: '200px 300px 1fr', height: '100dvh', direction: 'rtl', overflow: 'hidden' }}
      >
        <NotebookSidebar
          activeFolder={activeFolder}
          activeTag={activeTag}
          tagsInUse={tagsInUse}
          onFolderChange={setActiveFolder}
          onTagChange={setActiveTag}
          onCreate={createPage}
        />

        <NotebookPageList
          pages={filteredPages}
          search={search}
          onSearchChange={setSearch}
          selectedId={selectedId}
          onSelect={selectPage}
          onDelete={deletePage}
        />

        <div style={{ height: '100%', background: 'var(--color-tg-bg)' }}>
          <NotebookEditor
            selected={selected}
            saveStatus={saveStatus}
            tagInput={tagInput}
            onTagInputChange={setTagInput}
            onAddTag={addCustomTag}
            onToggleTag={toggleTag}
            onUpdateField={updateField}
            onCreate={createPage}
          />
        </div>
      </div>

      {/* Mobile: single panel + collapsible filter bar */}
      <div className="md:hidden flex flex-col" style={{ height: '100dvh', direction: 'rtl' }}>
        {panel === 'list' ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Filter bar */}
            <div style={{ background: SURF, borderBottom: `1px solid ${BORDER}`, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflowX: 'auto' }}>
                <button
                  onClick={() => { setActiveFolder('all'); setActiveTag(null); }}
                  style={{
                    flexShrink: 0, padding: '5px 12px', borderRadius: 999, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                    border: 'none',
                    background: activeFolder === 'all' && activeTag === null ? 'rgba(0,210,210,0.14)' : 'var(--color-tg-bg)',
                    color: activeFolder === 'all' && activeTag === null ? GOLD : TEXT,
                  }}
                >כל הדפים</button>
                {PAGE_TYPES.map(t => {
                  const active = activeFolder === t.value;
                  return (
                    <button
                      key={t.value}
                      onClick={() => setActiveFolder(t.value)}
                      style={{
                        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5,
                        padding: '5px 12px', borderRadius: 999, fontSize: 11.5, fontWeight: active ? 600 : 400, cursor: 'pointer',
                        border: `1px solid ${active ? t.color : BORDER}`,
                        background: active ? `${t.color}18` : 'transparent',
                        color: active ? t.color : MUTED,
                      }}
                    ><span style={{ color: GOLD, display: 'flex' }}>{t.icon}</span>{t.label}</button>
                  );
                })}
                {tagsInUse.length > 0 && (
                  <button
                    onClick={() => setMobileFiltersOpen(v => !v)}
                    style={{ flexShrink: 0, padding: '5px 10px', borderRadius: 999, fontSize: 11.5, cursor: 'pointer', border: `1px solid ${BORDER}`, background: 'transparent', color: MUTED }}
                  >תגים {mobileFiltersOpen ? '▲' : '▼'}</button>
                )}
              </div>
              {mobileFiltersOpen && tagsInUse.length > 0 && (
                <div style={{ display: 'flex', gap: 6, overflowX: 'auto' }}>
                  {tagsInUse.map(tag => {
                    const active = activeTag === tag;
                    const hex = tagHex(tag);
                    return (
                      <button
                        key={tag}
                        onClick={() => setActiveTag(active ? null : tag)}
                        style={{
                          flexShrink: 0, padding: '4px 10px', borderRadius: 999, fontSize: 11, fontWeight: active ? 600 : 400, cursor: 'pointer',
                          border: `1px solid ${active ? hex : BORDER}`,
                          background: active ? `${hex}18` : 'transparent',
                          color: active ? hex : MUTED,
                        }}
                      >{tag}</button>
                    );
                  })}
                </div>
              )}
            </div>

            <NotebookPageList
              pages={filteredPages}
              search={search}
              onSearchChange={setSearch}
              selectedId={selectedId}
              onSelect={selectPage}
              onDelete={deletePage}
            />
          </div>
        ) : (
          <>
            {/* Back button */}
            <button
              onClick={() => setPanel('list')}
              className="flex items-center gap-1.5 px-4 py-2 text-sm"
              style={{ background: SURF, borderBottom: `1px solid ${BORDER}`, color: TEXT, flexShrink: 0 }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
              כל הדפים
            </button>

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--color-tg-bg)' }}>
              <NotebookEditor
                selected={selected}
                saveStatus={saveStatus}
                tagInput={tagInput}
                onTagInputChange={setTagInput}
                onAddTag={addCustomTag}
                onToggleTag={toggleTag}
                onUpdateField={updateField}
                onCreate={createPage}
              />
            </div>
          </>
        )}
      </div>
    </>
  );
}
