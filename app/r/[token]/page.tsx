import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SharedReport } from "../../report-sharing";

export const metadata:Metadata={
  title:"Shared inspection report",
  robots:{index:false,follow:false},
  referrer:"no-referrer",
};

export default async function Page({params}:{params:Promise<{token:string}>}) {
  const {token}=await params;
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))notFound();
  return <SharedReport token={token}/>;
}
