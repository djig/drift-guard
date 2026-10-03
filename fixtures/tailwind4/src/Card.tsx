import { cva } from 'class-variance-authority';
export const card = cva('flex rounded-sm shadow-xs outline-hidden bg-(--brand) ring-3', { variants: { tone: { loud: 'bg-black/50 bg-linear-to-r' } } });
export const Card = () => <div className={`flex! md:shrink-0 ${card({ tone: 'loud' })}`} />;
export const Old = () => <div className={`md:!flex sm:bg-gradient-to-br text-opacity-75 ring ${card()}`} />;
