"use client";

import Link from "next/link";
import type { CSSProperties } from "react";
import { useLoad } from "./ui";

const categories = [
  {name:"Apparel",photo:"apparel",state:"Check availability",labels:["Apparel"]},
  {name:"Footwear",photo:"footwear",state:"Planned",labels:["Footwear"]},
  {name:"Bags & Accessories",photo:"bags",state:"Planned",labels:["Bags","Bags & Accessories"]},
  {name:"Electronics",photo:"electronics",state:"Not available",labels:["Electronics"]},
  {name:"Home & Lifestyle",photo:"home",state:"Planned",labels:["Home","Home goods","Home & Lifestyle"]},
];

type CategoryOffer = {category_id:string;category:{en:string}};

export function CategoryCoverage() {
  const {data}=useLoad("/catalog");
  return <CategoryTiles offers={data?.offers??[]}/>;
}

export function CategoryTiles({offers}:{offers:CategoryOffer[]}) {
  const categoriesByName = new Map(offers.map(offer=>[offer.category.en,offer.category_id]));
  return <div className="land-categories">
    {categories.map(category=>{
      const categoryId=category.labels.map(label=>categoriesByName.get(label)).find(Boolean);
      const href=categoryId?"/categories?"+new URLSearchParams({category:categoryId}):category.photo==="apparel"?"/catalog":"/contact";
      return <Link key={category.photo} className="land-category" href={href} style={{"--category-photo":`url(/brand/${category.photo}.webp)`} as CSSProperties}>
        <strong>{category.name}</strong><span className={categoryId?"available":undefined}>{categoryId?"Available":category.state}</span>
      </Link>;
    })}
  </div>;
}
