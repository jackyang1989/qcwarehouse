import type { Metadata } from "next";
import "./styles.css";
import "./marketing.css";
import { publicSiteOrigin } from "./public-seo";

export const metadata: Metadata = {
  metadataBase: new URL(publicSiteOrigin()),
  title: {
    default: "Product Inspection & Sample Comparison in China | QCWarehouse",
    template: "%s | QCWarehouse",
  },
  description:
    "China-based independent product inspection, supplier sample comparison, and Golden Sample matching for e-commerce brands and small-batch buyers. Inspect item by item before shipping internationally.",
  openGraph: {
    type: "website",
    siteName: "QCWarehouse",
    locale: "en_US",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Browser extensions can add attributes to the document before React loads.
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
