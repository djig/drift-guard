export default function Legacy({ data }: { data: string }) {
  return <p>{data}</p>;
}

export async function getServerSideProps() {
  return { props: { data: 'x' } };
}
