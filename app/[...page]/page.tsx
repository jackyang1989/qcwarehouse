import { Portal } from "../portal";

export default async function Page({params}:{params:Promise<{page:string[]}>}) {
  const {page}=await params;
  return <Portal path={"/"+page.join("/")}/>;
}
