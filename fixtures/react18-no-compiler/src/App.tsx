import { forwardRef, useMemo, useCallback } from 'react';
import ReactDOM from 'react-dom';

export const Thing = forwardRef<HTMLDivElement, { xs: number[] }>(function Thing({ xs }, ref) {
  const total = useMemo(() => xs.reduce((a, b) => a + b, 0), [xs]);
  const onClick = useCallback(() => {}, []);
  return (
    <div ref={ref} onClick={onClick} className="!flex shadow-sm bg-gradient-to-r bg-[--x]">
      {xs.map((x, i) => <span key={i}>{x}</span>)}
      {total}
    </div>
  );
});

ReactDOM.render(<Thing xs={[1]} />, document.body);
