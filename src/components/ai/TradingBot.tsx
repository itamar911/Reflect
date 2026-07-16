'use client';

import { useState, useRef, useEffect } from 'react';
import { Bot, ArrowDown } from 'lucide-react';
import UpgradeModal from '@/components/plans/UpgradeModal';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

const SCROLL_BOTTOM_THRESHOLD = 40;
const REVEAL_TICK_MS = 45;
const REVEAL_CATCHUP_WORDS = 80;
const REVEAL_FLUSH_THRESHOLD = 3;

// Splits text into tokens of (leading whitespace + word); joining tokens
// reconstructs an exact substring of the original text.
function tokenize(text: string): string[] {
  return text.match(/\s*\S+/g) || [];
}

const QUICK_QUESTIONS = [
  'איך הייתי השבוע?',
  'מה הבעיה העיקרית שלי?',
  'נתח לי את העסקה האחרונה',
  'כמה להסתכן בעסקה הבאה?',
  'הסבר לי ICT Order Blocks',
  'איך להתמודד עם Revenge Trading?',
  'האם אחוז ההצלחה שלי טוב?',
];

export default function TradingBot() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [scrollToBottomSignal, setScrollToBottomSignal] = useState(0);
  const [scrollToReplySignal, setScrollToReplySignal] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastAssistantRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const isAtBottomRef = useRef(true);
  const bufferRef = useRef('');
  const revealedCountRef = useRef(0);
  const streamDoneRef = useRef(false);
  const revealIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    isAtBottomRef.current = isAtBottom;
  }, [isAtBottom]);

  function stopReveal() {
    if (revealIntervalRef.current !== null) {
      clearInterval(revealIntervalRef.current);
      revealIntervalRef.current = null;
    }
  }

  // Keep the reveal loop cleaned up on unmount
  useEffect(() => () => stopReveal(), []);

  function updateAssistantContent(text: string) {
    setMessages(prev => {
      const updated = [...prev];
      updated[updated.length - 1] = { role: 'assistant', content: text };
      return updated;
    });
    if (isAtBottomRef.current) {
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }

  function finishReveal() {
    stopReveal();
    setLoading(false);
    setScrollToReplySignal(s => s + 1);
    inputRef.current?.focus();
  }

  function startReveal() {
    stopReveal();
    revealIntervalRef.current = setInterval(() => {
      const buffer = bufferRef.current;
      const tokens = tokenize(buffer);
      const endsWithWhitespace = /\s$/.test(buffer);
      // While still streaming, the last token may be a word still being received —
      // hold it back until it's terminated by whitespace or the stream is done.
      const safeAvailable = streamDoneRef.current || endsWithWhitespace
        ? tokens.length
        : Math.max(tokens.length - 1, 0);

      const pending = safeAvailable - revealedCountRef.current;
      if (pending > 0) {
        const next = streamDoneRef.current && pending <= REVEAL_FLUSH_THRESHOLD
          ? safeAvailable
          : Math.min(revealedCountRef.current + (pending > REVEAL_CATCHUP_WORDS ? 3 : 1), safeAvailable);
        revealedCountRef.current = next;
        updateAssistantContent(tokens.slice(0, next).join(''));
      }

      if (streamDoneRef.current && revealedCountRef.current >= tokens.length) {
        finishReveal();
      }
    }, REVEAL_TICK_MS);
  }

  // User sent a new message — jump to the bottom to show it
  useEffect(() => {
    if (scrollToBottomSignal === 0) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [scrollToBottomSignal]);

  // AI finished responding — scroll to the start of its reply, not the bottom
  useEffect(() => {
    if (scrollToReplySignal === 0) return;
    lastAssistantRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [scrollToReplySignal]);

  // Re-check bottom proximity as new content streams in (without auto-scrolling)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_BOTTOM_THRESHOLD);
  }, [messages]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_BOTTOM_THRESHOLD);
  }

  function scrollToBottom() {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loading) return;

    const userMsg: Message = { role: 'user', content };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setScrollToBottomSignal(s => s + 1);
    setInput('');
    setLoading(true);

    const assistantMsg: Message = { role: 'assistant', content: '' };
    setMessages(prev => [...prev, assistantMsg]);

    bufferRef.current = '';
    revealedCountRef.current = 0;
    streamDoneRef.current = false;
    startReveal();

    try {
      const res = await fetch('/api/ai-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages }),
      });

      if (res.status === 403) {
        const data = await res.json().catch(() => null);
        if (data?.error === 'PLAN_LIMIT') {
          stopReveal();
          setMessages((prev) => prev.slice(0, -1));
          setUpgradeModalOpen(true);
          setLoading(false);
          return;
        }
      }

      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bufferRef.current += decoder.decode(value, { stream: true });
      }
      // Buffer is fully populated — the reveal loop drains it and finalizes loading state.
      streamDoneRef.current = true;
    } catch {
      stopReveal();
      updateAssistantContent('שגיאה בתקשורת עם ה-AI — נסה שוב');
      setLoading(false);
      setScrollToReplySignal(s => s + 1);
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="relative flex-1" style={{ minHeight: 0 }}>
        {/* Bottom fade — hints that the area (intro chips / messages) scrolls
            instead of content just cutting off at the boundary */}
        <div
          className="pointer-events-none absolute bottom-0 inset-x-0 h-6 z-10"
          style={{ background: 'linear-gradient(to top, var(--color-tg-surface), transparent)' }}
          aria-hidden
        />
        <div ref={containerRef} onScroll={handleScroll} className="h-full overflow-y-auto px-1 pb-2">
          {messages.length === 0 ? (
            <div className="flex flex-col gap-4 pt-2">
              {/* Welcome */}
              <div className="rounded-2xl p-4"
                style={{ background: 'var(--color-tg-surface-2)' }}>
                <div className="flex items-center gap-2 mb-2">
                  <Bot size={18} />
                  <p className="text-sm font-bold text-tg-text">יועץ המסחר שלי</p>
                </div>
                <p className="text-xs text-tg-text-2 leading-relaxed">
                  אני מכיר את כל ההיסטוריה שלך, החוקים שלך, ואת כל אסטרטגיות המסחר לעומק.
                  שאל אותי כל שאלה על המסחר שלך.
                </p>
              </div>

              {/* Quick questions */}
              <div>
                <p className="text-xs text-tg-muted mb-2 px-1">שאלות מהירות:</p>
                <div className="flex flex-wrap gap-1.5">
                  {QUICK_QUESTIONS.map((q) => (
                    <button key={q} onClick={() => send(q)}
                      className="px-3 py-1.5 rounded-full text-xs border transition-all active:scale-95"
                      style={{
                        background: 'var(--color-tg-surface)',
                        borderColor: 'var(--color-tg-border)',
                        color: 'var(--color-tg-text-2)',
                      }}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 pt-2">
              {messages.map((msg, i) => (
                <div key={i}
                  ref={i === messages.length - 1 && msg.role === 'assistant' ? lastAssistantRef : undefined}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'assistant' && (
                    <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 mt-0.5 mr-2"
                      style={{ background: 'var(--color-tg-primary-muted)' }}>
                      <Bot size={13} />
                    </div>
                  )}
                  <div className="max-w-[85%] rounded-2xl px-3 py-2.5"
                    style={{
                      background: msg.role === 'user' ? 'var(--color-tg-primary)' : 'var(--color-tg-surface-2)',
                      color: msg.role === 'user' ? '#000' : 'var(--color-tg-text)',
                      borderRadius: msg.role === 'user' ? '18px 18px 4px 18px' : '4px 18px 18px 18px',
                    }}>
                    {msg.content ? (
                      <p className="text-xs leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                    ) : (
                      <div className="flex gap-1 py-1">
                        {[0, 1, 2].map(j => (
                          <div key={j} className="w-1.5 h-1.5 rounded-full animate-bounce"
                            style={{ background: 'var(--color-tg-muted)', animationDelay: `${j * 0.15}s` }} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {messages.length > 0 && !isAtBottom && (
          <button onClick={scrollToBottom} aria-label="גלול למטה"
            className="absolute bottom-2 left-1/2 -translate-x-1/2 w-8 h-8 rounded-full flex items-center justify-center shadow-lg transition-all active:scale-95 z-10"
            style={{ background: 'var(--color-tg-surface-2)', border: '1px solid var(--color-tg-border)' }}>
            <ArrowDown size={16} />
          </button>
        )}
      </div>

      {/* Input */}
      <div className="pt-3 border-t border-tg-border">
        {messages.length > 0 && (
          <div className="flex gap-1.5 mb-2 overflow-x-auto pb-1 scrollbar-none">
            {['איך הייתי?', 'עסקה אחרונה', 'מה לשפר?'].map((q) => (
              <button key={q} onClick={() => send(q)}
                className="shrink-0 px-2.5 py-1 rounded-full text-[10px] border transition-all"
                style={{
                  background: 'var(--color-tg-surface)',
                  borderColor: 'var(--color-tg-border)',
                  color: 'var(--color-tg-text-2)',
                }}>
                {q}
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            rows={1}
            placeholder="שאל אותי כל דבר על המסחר שלך..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
            className="flex-1 px-3 py-2.5 rounded-2xl text-sm border focus:outline-none resize-none disabled:opacity-50"
            style={{
              background: 'var(--color-tg-surface-2)',
              borderColor: 'var(--color-tg-border)',
              color: 'var(--color-tg-text)',
              maxHeight: '100px',
            }}
          />
          <button
            onClick={() => send()}
            disabled={!input.trim() || loading}
            className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-all active:scale-95 disabled:opacity-40"
            style={{ background: 'var(--color-tg-primary)' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        <p className="hidden sm:block text-[10px] text-tg-muted text-center mt-1.5">Enter לשלוח · Shift+Enter לשורה חדשה</p>
      </div>

      <UpgradeModal
        open={upgradeModalOpen}
        onClose={() => setUpgradeModalOpen(false)}
        limitType="ai_coach"
      />
    </div>
  );
}
