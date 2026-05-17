'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';

type Mode = 'login' | 'signup';

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

  const supabase = createClient();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');

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
        window.location.href = '/dashboard';
      }
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
        <h1 className="text-2xl font-bold text-tg-text" style={{ color: 'var(--color-tg-primary)' }}>Reflect</h1>
        <p className="text-xs text-tg-muted mt-0.5 mb-1">השוק בוחן את האסטרטגיה שלך. Reflect בוחן אותך.</p>
        <p className="text-sm text-tg-text-2 mt-1">
          {mode === 'login' ? 'ברוך הבא! התחבר לחשבונך' : 'צור חשבון חדש'}
        </p>
      </div>

      {/* Card */}
      <div className="rounded-2xl border border-tg-border p-6"
        style={{ background: 'var(--color-tg-surface)' }}>
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
      </div>

      {/* Toggle */}
      <p className="text-center text-sm text-tg-text-2 mt-4">
        {mode === 'login' ? 'אין לך חשבון?' : 'כבר יש לך חשבון?'}{' '}
        <Link
          href={mode === 'login' ? '/signup' : '/login'}
          className="text-tg-primary font-medium"
        >
          {mode === 'login' ? 'הירשם עכשיו' : 'התחבר'}
        </Link>
      </p>
    </div>
  );
}
