'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (password.length < 6) {
      setError('הסיסמא חייבת להכיל לפחות 6 תווים');
      return;
    }
    if (password !== confirm) {
      setError('הסיסמאות אינן תואמות');
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setError(error.message === 'Auth session missing!'
        ? 'הלינק פג תוקף — בקש לינק חדש'
        : error.message);
    } else {
      setSuccess(true);
      setTimeout(() => router.push('/login'), 2500);
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
        <p className="text-sm text-tg-text-2 mt-1">בחר סיסמא חדשה</p>
      </div>

      <div className="rounded-2xl border border-tg-border p-6"
        style={{ background: 'var(--color-tg-surface)' }}>

        {success ? (
          <div className="text-center py-4 animate-fade-in">
            <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4"
              style={{ background: 'var(--color-tg-success-muted)' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-tg-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <p className="text-sm font-semibold text-tg-text mb-1">הסיסמא עודכנה!</p>
            <p className="text-xs text-tg-muted">מועבר לדף ההתחברות...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <Input
              label="סיסמא חדשה"
              type="password"
              placeholder="לפחות 6 תווים"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
            />
            <Input
              label="אימות סיסמא"
              type="password"
              placeholder="הזן שוב את הסיסמא"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
            />

            {error && (
              <div className="text-sm text-tg-danger rounded-xl px-3 py-2"
                style={{ background: 'var(--color-tg-danger-muted)' }}>
                {error}
                {error.includes('פג תוקף') && (
                  <a href="/forgot-password" className="block mt-1 text-xs underline"
                    style={{ color: 'var(--color-tg-primary)' }}>
                    שלח לינק חדש
                  </a>
                )}
              </div>
            )}

            <Button type="submit" fullWidth loading={loading} size="lg" className="mt-1">
              עדכן סיסמא
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
