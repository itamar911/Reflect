import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { MAIN_CONTENT_ID } from '@/components/accessibility/SkipLink';

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  // Content landmark / skip-link target — this group renders no chrome of its
  // own, so the whole page is the content region.
  return <main id={MAIN_CONTENT_ID} tabIndex={-1}>{children}</main>;
}
