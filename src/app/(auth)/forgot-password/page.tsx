'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}/auth/callback?next=/reset-password`,
    });

    if (error) {
      setError(error.message);
    } else {
      setSent(true);
    }
    setLoading(false);
  }

  return (
    <div className="w-full max-w-sm animate-fade-in">
      {/* Logo */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl mb-4"
          style={{ background: 'var(--color-tg-primary)' }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
            <polyline points="16 7 22 7 22 13" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-tg-text">Reflect</h1>
        <p className="text-sm text-tg-text-2 mt-1">שחזור סיסמא</p>
      </div>

      {sent ? (
        <div className="rounded-2xl border border-tg-border p-6 text-center"
          style={{ background: 'var(--color-tg-surface)' }}>
          <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4"
            style={{ background: 'var(--color-tg-success-muted)' }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-tg-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <p className="text-sm font-semibold text-tg-text mb-1">הלינק נשלח!</p>
          <p className="text-xs text-tg-text-2 mb-4">
            בדוק את תיבת הדואר של <span className="font-medium text-tg-text">{email}</span>
            <br />ולחץ על הלינק לאיפוס הסיסמא.
          </p>
          <p className="text-xs text-tg-muted">לא קיבלת? בדוק תיקיית ספאם.</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-tg-border p-6"
          style={{ background: 'var(--color-tg-surface)' }}>
          <p className="text-xs text-tg-text-2 mb-4">
            הזן את כתובת האימייל שלך ונשלח לך לינק לאיפוס הסיסמא.
          </p>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <Input
              label="אימייל"
              type="email"
              placeholder="trader@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />

            {error && (
              <div className="text-sm text-tg-danger rounded-xl px-3 py-2"
                style={{ background: 'var(--color-tg-danger-muted)' }}>
                {error}
              </div>
            )}

            <Button type="submit" fullWidth loading={loading} size="lg" className="mt-1">
              שלח לינק לאיפוס
            </Button>
          </form>
        </div>
      )}

      <p className="text-center text-sm text-tg-text-2 mt-4">
        <Link href="/login" className="text-tg-primary font-medium">
          חזרה להתחברות
        </Link>
      </p>
    </div>
  );
}
