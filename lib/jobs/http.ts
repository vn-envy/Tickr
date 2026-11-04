import { ZodError } from "zod";
import { RequestError } from "../http";

export function validRunId(id: string): boolean { return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id); }
export function requireId(id: string) { if (!validRunId(id)) throw new RequestError("Record not found.", 404); }
export function jobError(error: unknown) {
  if (error instanceof RequestError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof ZodError) return Response.json({ error: "Check the supplied source text, URLs and request fields." }, { status: 400 });
  return Response.json({ error: "The request could not be completed. Check local database setup and try again." }, { status: 500 });
}
