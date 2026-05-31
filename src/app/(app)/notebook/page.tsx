import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import NotebookClient, { type NotebookPage } from '@/components/notebook/NotebookClient';

export const metadata = { title: 'מחברת — Reflect' };

export default async function NotebookPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data } = await supabase
    .from('notebook_pages')
    .select('*')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false });

  return (
    <NotebookClient
      initialPages={(data ?? []) as NotebookPage[]}
      userId={user.id}
    />
  );
}
