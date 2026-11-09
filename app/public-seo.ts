import type { Metadata } from "next";

export function publicSiteOrigin(): string {
  try {
    return new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
  } catch {
    return "http://localhost:3000";
  }
}

type RouteSeoConfig = {
  title: string;
  description: string;
  ogImage?: string;
};

const PUBLIC_ROUTE_SEO: Record<string, RouteSeoConfig> = {
  "/": {
    title: "Independent Product Inspection in China | QCWarehouse",
    description:
      "Know what arrived, what was checked, and what to do next — before paying for international shipping. Individual sample & small-batch inspection, 2–3 supplier sample comparison, and Golden Sample matching in China.",
    ogImage: "/marketing/home-inspection-studio.webp",
  },
  "/catalog": {
    title: "Inspection Services in China — Individual Sample, Small-Batch & Comparison",
    description:
      "Compare QCWarehouse services in China: individual sample & small-batch Product Inspection (1–100+ items), side-by-side Sample Comparison (2–3 items), and Golden Sample Matching with measurements, photos & documented findings.",
    ogImage: "/brand/inspection-hero.webp",
  },
  "/services/inspection": {
    title: "Product Inspection in China — Individual Sample & Small-Batch Inspection",
    description:
      "Individual physical product inspection at our China receiving center. Every item gets a unique traceable ID, flat-lay measurements with tape photos, workmanship checks, and per-item routing.",
    ogImage: "/marketing/service-item-inspection.webp",
  },
  "/services/compare": {
    title: "Supplier Sample Comparison Service in China (2–3 Samples)",
    description:
      "Compare 2 or 3 candidate supplier samples side by side under identical lighting and measurement methods in China before committing to inventory.",
    ogImage: "/marketing/service-three-samples.webp",
  },
  "/services/reference": {
    title: "Golden Sample & Reference Matching Service in China",
    description:
      "Retain your approved Golden Sample in secure reference sample storage in China and inspect new supplier samples or restock units directly against your physical benchmark.",
    ogImage: "/marketing/service-golden-matching.webp",
  },
  "/categories": {
    title: "Supported Product Categories — Apparel Inspection Live Today",
    description:
      "See what products QCWarehouse inspects today in China: approved templates for Tops & Knitwear, Leggings & Bottoms, Sports Bras & Activewear, plus planned and restricted category policies.",
    ogImage: "/brand/inspection-hero.webp",
  },
  "/how-it-works": {
    title: "How It Works — China Receiving, Item Inspection & Post-QC Routing",
    description:
      "Step-by-step chain of custody from your Chinese supplier shipment to parcel check-in, piece-by-piece inspection, reviewed inspection report, and return, storage, or freight-forwarder dispatch.",
    ogImage: "/marketing/workflow-create-order-ui.webp",
  },
  "/report-guide": {
    title: "Sample Inspection Report — Measurements, Photos & Documented Findings",
    description:
      "Explore an interactive demonstration QCWarehouse reviewed inspection report featuring metric tape photos, re-measurement logs, UI defect bounding boxes, side-by-side sample comparison, and scope boundaries.",
    ogImage: "/marketing/report-sample-a-chest-measure.webp",
  },
  "/pricing": {
    title: "Transparent Product Inspection Pricing & Fee Estimator",
    description:
      "View live per-item inspection, sample comparison, and Golden Sample matching rates in USD. Estimate your exact inspection fee and understand post-inspection domestic shipping and storage charges.",
    ogImage: "/marketing/home-inspection-studio.webp",
  },
  "/faq": {
    title: "FAQ & Buyer Help Center — China Product Inspection Questions",
    description:
      "Answers for international buyers: multi-supplier parcels, 30–50 item piece-by-piece checks, inspection vs comparison, seller returns, forwarder handoff, turnaround times, and inspection scope boundaries.",
    ogImage: "/marketing/home-inspection-studio.webp",
  },
  "/contact": {
    title: "Contact Inspection Support & Request Custom Scope",
    description:
      "Ask QCWarehouse about apparel inspection scope, custom small-batch quantities (100+ items), category availability, or pre-order feasibility in China.",
    ogImage: "/marketing/home-inspection-studio.webp",
  },
  "/legal": {
    title: "Terms, Privacy & Inspection Policies",
    description:
      "Review QCWarehouse Terms of Service, Privacy Policy, Restricted Items Policy, and Inspection Report Limitations.",
  },
  "/legal/terms": {
    title: "Terms of Service",
    description:
      "Versioned Terms of Service governing QCWarehouse physical receiving, product inspection, custody, domestic dispatch, and billing.",
  },
  "/legal/privacy": {
    title: "Privacy Policy",
    description:
      "How QCWarehouse collects, protects, and retains customer account data, supplier shipping records, and private inspection evidence.",
  },
  "/legal/restricted-items": {
    title: "Restricted & Prohibited Items Policy",
    description:
      "Items prohibited or restricted from delivery to the QCWarehouse China receiving center, including hazardous, regulated, and unapproved categories.",
  },
  "/legal/report-notice": {
    title: "Inspection Report Scope & Limitations Notice",
    description:
      "Important boundaries of QCWarehouse physical inspection reports: commissioned visual and dimensional observations vs laboratory testing, certification, and bulk factory audits.",
  },
};

export function metadataForPath(path: string, isPublicMarketing: boolean): Metadata {
  const origin = publicSiteOrigin();
  const seo = PUBLIC_ROUTE_SEO[path];

  if (!isPublicMarketing || !seo) {
    return {
      title: path === "/login" || path === "/signup" ? "Customer Sign In" : undefined,
      robots: { index: false, follow: false },
    };
  }

  const canonicalUrl = path === "/" ? origin : `${origin}${path}`;
  const ogImage = seo.ogImage ?? "/marketing/home-inspection-studio.webp";

  return {
    title: path === "/" ? { absolute: seo.title } : seo.title,
    description: seo.description,
    alternates: {
      canonical: canonicalUrl,
    },
    openGraph: {
      type: "website",
      siteName: "QCWarehouse",
      locale: "en_US",
      url: canonicalUrl,
      title: path === "/" ? seo.title : `${seo.title} | QCWarehouse`,
      description: seo.description,
      images: [
        {
          url: ogImage,
          width: 1200,
          height: 675,
          alt: seo.title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: path === "/" ? seo.title : `${seo.title} | QCWarehouse`,
      description: seo.description,
      images: [ogImage],
    },
  };
}

export function homeJsonLd() {
  const origin = publicSiteOrigin();
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${origin}/#organization`,
        name: "QCWarehouse",
        url: origin,
        description:
          "China-based independent product inspection, supplier sample comparison, and post-inspection item handling service for international commercial buyers.",
        contactPoint: {
          "@type": "ContactPoint",
          contactType: "customer support",
          url: `${origin}/contact`,
          availableLanguage: ["English", "Chinese"],
        },
      },
      {
        "@type": "Service",
        "@id": `${origin}/#service`,
        name: "Independent Product Inspection & Sample Comparison in China",
        provider: { "@id": `${origin}/#organization` },
        serviceType: [
          "Piece-by-Piece Product Inspection",
          "Supplier Sample Comparison",
          "Golden Sample Reference Matching",
        ],
        areaServed: "Worldwide",
        url: `${origin}/catalog`,
      },
    ],
  };
}
