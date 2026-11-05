import { handle } from "@/packages/core/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = {params:Promise<{path:string[]}>};
async function route(request:Request, context:Context) {
  const {path}=await context.params;
  return handle(request,"/"+path.join("/"));
}
export {route as GET,route as POST,route as PATCH,route as PUT,route as DELETE};
