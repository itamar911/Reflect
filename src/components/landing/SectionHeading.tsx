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
        {/* 2.625rem, not 42px: every section heading on the page comes through
            here, so a px literal would pin all of them against the browser's
            font-size preference. 2.625rem is the same 42px at a 16px default. */}
        <h2 className="text-4xl md:text-[2.625rem] font-extrabold text-white leading-tight">{children}</h2>
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
