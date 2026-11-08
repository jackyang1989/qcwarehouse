"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { useLoad } from "./ui";

const categories = [
  { name: "Apparel", photo: "/brand/apparel.webp", state: "Open Today", labels: ["Apparel"] },
  { name: "Footwear", photo: "", state: "Planned", labels: ["Footwear"] },
  { name: "Bags & Accessories", photo: "", state: "Planned", labels: ["Bags", "Bags & Accessories"] },
  { name: "Home & Lifestyle", photo: "", state: "Planned", labels: ["Home", "Home goods", "Home & Lifestyle"] },
  { name: "Electronics", photo: "", state: "Restricted", labels: ["Electronics"] },
];

type CategoryOffer = { category_id: string; category: { en: string } };

export function CategoryCoverage() {
  const { data } = useLoad("/catalog");
  return <CategoryTiles offers={data?.offers ?? []} />;
}

export function CategoryTiles({ offers }: { offers: CategoryOffer[] }) {
  const categoriesByName = new Map(offers.map((offer) => [offer.category.en, offer.category_id]));
  return (
    <div className="land-categories">
      {categories.map((category) => {
        const categoryId = category.labels.map((label) => categoriesByName.get(label)).find(Boolean);
        const href = categoryId
          ? "/categories?" + new URLSearchParams({ category: categoryId })
          : category.name === "Apparel"
          ? "/categories"
          : "/contact?topic=category";
        const style = category.photo
          ? ({ "--category-photo": `url(${category.photo})` } as CSSProperties)
          : ({ background: "#14263f" } as CSSProperties);
        return (
          <Link key={category.name} className="land-category" href={href} style={style}>
            <strong>{category.name}</strong>
            <span className={categoryId ? "available" : undefined}>
              {categoryId ? "Open for Orders" : category.state}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
