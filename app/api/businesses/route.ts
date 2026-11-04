import { db } from "@/lib/db";
import { BusinessDraftInput } from "@/lib/businesses/input";
import { readLocalJson, RequestError } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const businesses = await db.business.findMany({
      orderBy: { updatedAt: "desc" }, take: 30,
      include: { runs: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, stage: true, status: true, mode: true, updatedAt: true } } },
    });
    return Response.json({ businesses }, { headers: { "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: "Saved businesses could not be read. Check local database setup." }, { status: 500 }); }
}

export async function POST(request: Request) {
  try {
    const parsed = BusinessDraftInput.safeParse(await readLocalJson(request));
    if (!parsed.success) return Response.json({ error: "Provide a valid business link, or a business name and locality. Check any optional details you supplied." }, { status: 400 });
    const business = await db.business.create({ data: parsed.data });
    return Response.json({ business }, { status: 201 });
  } catch (error) {
    if (error instanceof RequestError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "The draft could not be saved. Check local database setup." }, { status: 500 });
  }
}
