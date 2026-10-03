import React, { forwardRef, useMemo, useCallback, memo } from 'react';
import { createRoot } from 'react-dom/client';

export const Thing = forwardRef<HTMLDivElement, { xs: number[] }>(function Thing({ xs }, ref) {
  const total = useMemo(() => xs.reduce((a, b) => a + b, 0), [xs]);
  const onClick = useCallback(() => {}, []);
  return <div ref={ref} onClick={onClick}>{total}</div>;
});

export const Memoed = memo(Thing);
export const Memoed2 = React.memo(Thing);

export function Plain({ ref }: { ref: React.Ref<HTMLDivElement> }) {
  return <div ref={ref} />;
}

createRoot(document.body).render(<Thing xs={[1]} />);
