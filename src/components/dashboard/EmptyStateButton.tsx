'use client';

export default function EmptyStateButton() {
  return (
    <button
      onClick={() => window.dispatchEvent(new CustomEvent('open-trade-form'))}
      className="inline-flex items-center gap-2 px-6 py-3 rounded-2xl font-semibold text-sm transition-transform active:scale-95"
      style={{
        background: 'linear-gradient(135deg, #F5C518 0%, #D4A017 100%)',
        color: '#000',
        boxShadow: '0 4px 20px rgba(245,197,24,0.5), 0 0 40px rgba(245,197,24,0.2)',
      }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
      הוסף עסקה ראשונה
    </button>
  );
}
