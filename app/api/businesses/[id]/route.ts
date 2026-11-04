import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[a-f0-9-]{36}$/i.test(id)) return Response.json({ error: "Business not found." }, { status: 404 });
  const business = await db.business.findUnique({ where: { id } });
  if (!business) return Response.json({ error: "Business not found." }, { status: 404 });
  return Response.json({ business });
}
