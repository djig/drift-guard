import Head from 'next/head';
import { useRouter } from 'next/router';
import { forwardRef } from 'react';

export const Input = forwardRef<HTMLInputElement>(function Input(_, ref) {
  return <input ref={ref} />;
});

export default function Home({ data }: { data: string }) {
  const router = useRouter();
  return (
    <>
      <Head><title>x</title></Head>
      <p onClick={() => router.push('/')}>{data}</p>
    </>
  );
}

export async function getServerSideProps() {
  return { props: { data: 'x' } };
}
