'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Ban } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { ReflectLogo } from '@/components/brand/ReflectLogo';

type PageStatus = 'loading' | 'ready' | 'invalid';

export default function ResetPasswordPage() {
  const [status, setStatus] = useState<PageStatus>('loading');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();

    // PKCE recovery flow: code passed from /auth/callback
    const code = new URLSearchParams(window.location.search).get('code');
    if (code) {
      supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
        setStatus(error ? 'invalid' : 'ready');
      });
      return;
    }

    // Implicit flow: #access_token=...&refresh_token=...&type=recovery
    const hash = window.location.hash;
    if (hash) {
      const params = new URLSearchParams(hash.slice(1));
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      const type = params.get('type');

      if (accessToken && refreshToken && type === 'recovery') {
        supabase.auth
          .setSession({ access_token: accessToken, refresh_token: refreshToken })
          .then(({ error: sessionError }) => {
            setStatus(sessionError ? 'invalid' : 'ready');
          });
        return;
      }
    }

    // Fallback: session already set (e.g. next=/reset-password path without type param)
    supabase.auth.getSession().then(({ data: { session } }) => {
      setStatus(session ? 'ready' : 'invalid');
    });
  }, []);

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
    const { error: updateError } = await supabase.auth.updateUser({ password });

    if (updateError) {
      setError(
        updateError.message === 'Auth session missing!'
          ? 'הלינק פג תוקף — בקש לינק חדש'
          : updateError.message
      );
      setLoading(false);
    } else {
      setSuccess(true);
      setTimeout(() => router.push('/dashboard'), 2000);
    }
  }

  return (
    <div className="w-full max-w-sm animate-fade-in">
      {/* Logo */}
      <div className="text-center mb-8">
        <div className="flex justify-center mb-3">
          <ReflectLogo width={110} wordmark={true} />
        </div>
        <p className="text-sm text-tg-text-2 mt-1">בחר סיסמא חדשה</p>
      </div>

      <div className="rounded-2xl border border-tg-border p-6"
        style={{ background: 'var(--color-tg-surface)' }}>

        {status === 'loading' && (
          <div className="text-center py-8">
            <div className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin mx-auto mb-3"
              style={{ borderColor: 'var(--color-tg-primary)', borderTopColor: 'transparent' }} />
            <p className="text-sm text-tg-muted">מאמת את הלינק...</p>
          </div>
        )}

        {status === 'invalid' && (
          <div className="text-center py-4 animate-fade-in">
            <div className="mb-3"><Ban size={36} /></div>
            <p className="text-sm font-semibold text-tg-text mb-1">הלינק לא תקין או פג תוקף</p>
            <p className="text-xs text-tg-muted mb-4">לינקים לאיפוס סיסמא תקפים למשך שעה אחת</p>
            <a href="/forgot-password"
              className="text-sm font-medium underline"
              style={{ color: 'var(--color-tg-primary)' }}>
              שלח לינק חדש
            </a>
          </div>
        )}

        {status === 'ready' && (
          <>
            {success ? (
              <div className="text-center py-4 animate-fade-in">
                <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4"
                  style={{ background: 'var(--color-tg-success-muted)' }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-tg-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-tg-text mb-1">הסיסמא עודכנה!</p>
                <p className="text-xs text-tg-muted">מועבר לדשבורד...</p>
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
          </>
        )}
      </div>
    </div>
  );
}
