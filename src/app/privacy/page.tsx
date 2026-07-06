import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'מדיניות פרטיות — Reflect',
};

export default function PrivacyPage() {
  return (
    <div className="max-w-[700px] mx-auto px-4 md:px-6 py-24">
      <h1 className="text-2xl font-bold text-white mb-4">מדיניות פרטיות</h1>
      <p className="text-tg-muted leading-relaxed">
        עמוד מדיניות הפרטיות המלא בהכנה. לשאלות בנושא ניתן לפנות אלינו במייל.
      </p>
      <Link href="/" className="inline-block mt-8 text-tg-primary font-semibold">
        חזרה לעמוד הבית
      </Link>
    </div>
  );
}
