import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: {default:"QC Warehouse",template:"%s · QC Warehouse"},
  description:"Product inspection, sample comparison, and accountable warehouse handling.",
};
export default function RootLayout({children}:{children:React.ReactNode}) {
  return <html lang="en"><body>{children}</body></html>;
}
