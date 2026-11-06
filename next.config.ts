import type { NextConfig } from "next";

const config:NextConfig={
  devIndicators:false,
  logging:{incomingRequests:{ignore:[/^\/r\//,/^\/api\/v1\/public\/report-shares\//,/^\/api\/v1\/auth\/(google|microsoft)\/callback(?:\?|$)/]}},
};

export default config;
