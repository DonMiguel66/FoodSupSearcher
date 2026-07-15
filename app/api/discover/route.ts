import { z } from "zod";
import { criteriaSchema, discoverSuppliers, DiscoveryError, verifyAccessCode } from "../../lib/discovery";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: unknown; criteria?: unknown; accessCode?: unknown };
    const accessCode = typeof body.accessCode === "string" ? body.accessCode : "";
    if (body.action === "verify-access") {
      verifyAccessCode(accessCode);
      return Response.json({ authorized: true });
    }
    const criteria = criteriaSchema.parse(body.criteria);
    const clientId = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    return Response.json(await discoverSuppliers({ criteria, clientId, accessCode }));
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "Параметры поиска некорректны." }, { status: 400 });
    if (error instanceof DiscoveryError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Не удалось выполнить внешний поиск." }, { status: 500 });
  }
}
