import { forwardRef, useMemo } from 'react';
import { cn } from '@/lib/utils';

export const Button = forwardRef<HTMLButtonElement, { items: string[] }>(function Button({ items }, ref) {
  const memo = useMemo(() => items.length, [items]);
  return (
    <button ref={ref} className={cn('!flex shadow-sm rounded-sm bg-gradient-to-r bg-opacity-50 outline-none', 'bg-[--brand] grid-cols-[1fr,2fr] md:flex-shrink-0')}>
      {items.map((it, i) => (
        <span key={i} className="text-sm shadow-xs">
          {it} {memo}
        </span>
      ))}
    </button>
  );
});

export function Good({ items }: { items: { id: string }[] }) {
  return (
    <ul className="flex shadow-sm rounded-sm bg-linear-to-r bg-black/50 outline-hidden bg-(--brand) grid-cols-[1fr_2fr]">
      {items.map((it) => (
        <li key={it.id}>{it.id}</li>
      ))}
    </ul>
  );
}
