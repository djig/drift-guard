'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useFormState } from 'react-dom';

export function Dashboard() {
  const [data, setData] = useState<unknown>(null);
  const router = useRouter();
  const [state, action] = useFormState(async () => null, null);
  useEffect(() => {
    fetch('/api/data').then((r) => r.json()).then(setData);
  }, []);
  return <pre onClick={() => router.push('/')}>{JSON.stringify(data)} {String(state)}</pre>;
}
