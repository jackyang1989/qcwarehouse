import type { Metadata } from "next";
import "./styles.css";
import "./marketing.css";

export const metadata: Metadata = {
  title: {default:"QC Warehouse",template:"%s · QC Warehouse"},
  description:"Product inspection, sample comparison, and accountable warehouse handling.",
};
export default function RootLayout({children}:{children:React.ReactNode}) {
  // Browser extensions can add attributes to the document before React loads.
  return <html lang="en" suppressHydrationWarning><body>{children}</body></html>;
}
