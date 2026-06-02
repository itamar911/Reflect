'use client';

import { useState, useRef, useEffect } from 'react';
import Button from '@/components/ui/Button';

interface Message {
  role: 'user' | 'assistant';
  content: string;
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loading) return;

    const userMsg: Message = { role: 'user', content };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    const assistantMsg: Message = { role: 'assistant', content: '' };
    setMessages(prev => [...prev, assistantMsg]);

    try {
      const res = await fetch('/api/ai-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages }),
      });

      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        setMessages(prev => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: 'assistant', content: accumulated };
          return updated;
        });
      }
    } catch {
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: 'שגיאה בתקשורת עם ה-AI — נסה שוב' };
        return updated;
      });
    } finally {
      setLoading(false);
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
      <div className="flex-1 overflow-y-auto px-1 pb-2" style={{ minHeight: 0 }}>
        {messages.length === 0 ? (
          <div className="flex flex-col gap-4 pt-2">
            {/* Welcome */}
            <div className="rounded-2xl p-4"
              style={{ background: 'var(--color-tg-surface-2)' }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xl">🤖</span>
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
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'assistant' && (
                  <div className="w-6 h-6 rounded-full flex items-center justify-center text-sm shrink-0 mt-0.5 mr-2"
                    style={{ background: 'var(--color-tg-primary-muted)' }}>
                    🤖
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
        <p className="text-[10px] text-tg-muted text-center mt-1.5">Enter לשלוח · Shift+Enter לשורה חדשה</p>
      </div>
    </div>
  );
}
