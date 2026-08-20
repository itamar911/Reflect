import { ScrollReveal } from './ScrollReveal';

interface SectionHeadingProps {
  children: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
  /** Tighter bottom margin for sections that must fit a viewport. */
  compact?: boolean;
}

export function SectionHeading({ children, sub, className = '', compact = false }: SectionHeadingProps) {
  return (
    <div className={`flex flex-col items-center text-center ${compact ? 'mb-8' : 'mb-14'} ${className}`}>
      <ScrollReveal>
        {/* Size comes from .text-4xl (globals.css:552 — 2.625rem/3rem, ~42px at a
            16px default); the rem scale is what follows the browser's font size. */}
        <h2 className="text-4xl font-extrabold text-white">{children}</h2>
      </ScrollReveal>
      <ScrollReveal delay={100}>
        <span className={`section-underline ${compact ? 'mt-4' : 'mt-5'}`} aria-hidden />
      </ScrollReveal>
      {sub && (
        <ScrollReveal delay={160}>
          <p className="text-lg text-tg-muted max-w-2xl mx-auto mt-5 leading-relaxed">{sub}</p>
        </ScrollReveal>
      )}
    </div>
  );
}
