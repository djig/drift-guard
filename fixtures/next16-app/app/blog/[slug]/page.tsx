type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string>> };

export default async function BlogPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;
  return <article>{slug} {sp.q}</article>;
}

export async function generateMetadata(props: Props) {
  const { slug } = await props.params;
  return { title: slug };
}
