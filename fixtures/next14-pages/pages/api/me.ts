import { cookies } from 'next/headers';
export default function handler() {
  const c = cookies();
  return c;
}
