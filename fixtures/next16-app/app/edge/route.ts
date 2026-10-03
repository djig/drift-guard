import { PrismaClient } from '@prisma/client';

export const runtime = 'edge';

export async function GET() {
  const prisma = new PrismaClient();
  return Response.json(await prisma.user.count());
}
