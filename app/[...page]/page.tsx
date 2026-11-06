import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { actorForSession } from "../../packages/core/auth";
import { isDemo } from "../../packages/core/common";
import { signInMethods } from "../../packages/core/integrations";
import { customerDestination, resolvePortalRoute, withDestination } from "../../packages/core/portal-routes";
import { AccessShell, AccountRecovery, Login, Onboarding } from "../account-access";
import { Portal } from "../portal";

type Search = Record<string,string|string[]|undefined>;

export default async function Page({params,searchParams}:{params:Promise<{page:string[]}>;searchParams:Promise<Search>}) {
  const {page}=await params;
  if(page.some(segment=>segment.includes("/"))) notFound();
  const path="/"+page.join("/");
  const route=resolvePortalRoute(path);
  if(!route || route.view==="demo" && !isDemo()) notFound();

  const jar=await cookies();
  const actor=await actorForSession(jar.get("session")?.value);
  let target=path;
  if(route.area!=="public") {
    const search=new URLSearchParams();
    for(const [key,values] of Object.entries(await searchParams)) {
      if(typeof values==="string") search.append(key,values);
      else values?.forEach(value=>search.append(key,value));
    }
    if(search.size) target+="?"+search;
  }
  if(!actor && route.area!=="public") {
    if(route.area==="customer") {
      const entry=jar.has("qcw_onboarding")?"/onboarding":"/login";
      redirect(withDestination(entry,customerDestination(target)));
    }
    redirect(withDestination("/staff/login",target));
  }
  if(route.view==="account-recovery") {
    return <AccessShell staff={false}><AccountRecovery/></AccessShell>;
  }
  if(route.view==="login"||route.view==="staff-login"||route.view==="onboarding") {
    const search=await searchParams;
    const next=typeof search.next==="string"?search.next:null;
    const customerNext=customerDestination(next);
    const staff=route.view==="staff-login";
    if(!staff&&actor?.kind==="customer") redirect(customerNext??"/account");
    if(route.view==="onboarding"&&!jar.has("qcw_onboarding")) redirect(withDestination("/login",customerNext));
    return <AccessShell staff={staff}>{route.view==="onboarding"?<Onboarding next={customerNext}/>:
      <Login staff={staff} methods={signInMethods()} next={staff?next:customerNext}
        verify={search.verify==="1"} oauth={typeof search.oauth==="string"?search.oauth:undefined}/>}</AccessShell>;
  }

  return <Portal path={path} target={target} route={route} actor={actor}/>;
}
