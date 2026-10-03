import { cookies, headers } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET() {
  const store = cookies();
  const token = store.get('token');
  const h = await headers();
  return NextResponse.json({ token, ua: h.get('user-agent') });
}

export async function POST() {
  return cookies().then((c) => NextResponse.json({ ok: !!c }));
}
