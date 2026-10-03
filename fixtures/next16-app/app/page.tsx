type Props = { params: { id: string }; searchParams: { q?: string } };

export default function Page({ params, searchParams }: Props) {
  const id = params.id;
  const q = searchParams['q'];
  return <div>{id} {q}</div>;
}
