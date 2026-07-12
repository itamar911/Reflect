'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import { AuthShell, AuthCard } from '@/components/auth/AuthShell';

type Mode = 'login' | 'signup';

const CALLBACK_ERROR_MESSAGES: Record<string, string> = {
  link_expired: 'הקישור פג תוקף או שכבר נעשה בו שימוש. נסה לשלוח קישור חדש.',
  auth_callback_error: 'משהו השתבש באימות. נסה שוב או בקש קישור חדש.',
};

interface AuthScreenProps {
  mode: Mode;
}

export default function AuthScreen({ mode }: AuthScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [callbackError, setCallbackError] = useState('');

  const supabase = createClient();
  const router = useRouter();

  // Errors forwarded from /auth/callback (expired/used email links).
  // Read after mount — the page is prerendered without query params.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('error');
    if (code && CALLBACK_ERROR_MESSAGES[code]) {
      setCallbackError(CALLBACK_ERROR_MESSAGES[code]);
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');
    setCallbackError('');

    if (mode === 'signup') {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: name },
          emailRedirectTo: `${location.origin}/auth/callback`,
        },
      });
      if (error) {
        setError(error.message);
      } else {
        setSuccess('בדוק את האימייל שלך לאישור החשבון');
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError(error.message === 'Invalid login credentials'
          ? 'אימייל או סיסמה שגויים'
          : error.message);
      } else {
        router.push('/dashboard');
        router.refresh();
        return;
      }
    }

    setLoading(false);
  }

  return (
    <AuthShell
      tagline="השוק בוחן את האסטרטגיה שלך. Reflect בוחן אותך."
      subtitle={mode === 'login' ? 'ברוך הבא! התחבר לחשבונך' : 'צור חשבון חדש'}
      footer={
        <>
          {mode === 'login' ? 'אין לך חשבון?' : 'כבר יש לך חשבון?'}{' '}
          <Link
            href={mode === 'login' ? '/signup' : '/login'}
            className="text-tg-primary font-medium"
          >
            {mode === 'login' ? 'הירשם עכשיו' : 'התחבר'}
          </Link>
        </>
      }
    >
      <AuthCard>
        {callbackError && (
          <div className="text-sm text-tg-danger rounded-xl px-3 py-2 mb-3"
            style={{ background: 'var(--color-tg-danger-muted)' }}>
            {callbackError}
          </div>
        )}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {mode === 'signup' && (
            <Input
              label="שם מלא"
              type="text"
              placeholder="ישראל ישראלי"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          )}
          <Input
            label="אימייל"
            type="email"
            placeholder="trader@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
          <div className="flex flex-col gap-1.5">
            <Input
              label="סיסמה"
              type="password"
              placeholder={mode === 'signup' ? 'לפחות 6 תווים' : '••••••••'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            />
            {mode === 'login' && (
              <div className="flex justify-end">
                <Link href="/forgot-password"
                  className="text-xs text-tg-muted hover:text-tg-primary transition-colors">
                  שכחתי סיסמא
                </Link>
              </div>
            )}
          </div>

          {error && (
            <div className="text-sm text-tg-danger rounded-xl px-3 py-2"
              style={{ background: 'var(--color-tg-danger-muted)' }}>
              {error}
            </div>
          )}

          {success && (
            <div className="text-sm text-tg-success rounded-xl px-3 py-2"
              style={{ background: 'var(--color-tg-success-muted)' }}>
              {success}
            </div>
          )}

          <Button type="submit" fullWidth loading={loading} size="lg" className="mt-1">
            {mode === 'login' ? 'התחבר' : 'צור חשבון'}
          </Button>
        </form>
      </AuthCard>
    </AuthShell>
  );
}
