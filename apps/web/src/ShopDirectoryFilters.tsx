import { useState, type FormEvent } from "react";

import { shopPlaceMaxLength } from "@grogoni/shared-types";

import {
  shopCategories,
  shopCategoryLabels,
  type ShopCategory,
  type ShopDirectoryFilter
} from "./shop-directory";

/** Find shops by what they sell and where they are (the shop directory). */
export function ShopDirectoryFilters({
  onSearch
}: {
  onSearch: (filter: ShopDirectoryFilter) => void;
}) {
  const [category, setCategory] = useState<ShopCategory | "">("");
  const [place, setPlace] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch({
      ...(category === "" ? {} : { category }),
      ...(place.trim() === "" ? {} : { place: place.trim() })
    });
  };
  return (
    <form
      className="shop-directory-filters"
      role="search"
      aria-label="Find shops"
      onSubmit={submit}
    >
      <label>
        <span>Sells</span>
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value as ShopCategory | "")}
        >
          <option value="">Anything</option>
          {shopCategories.map((value) => (
            <option key={value} value={value}>
              {shopCategoryLabels[value]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Near</span>
        <input
          type="search"
          value={place}
          maxLength={shopPlaceMaxLength}
          placeholder="Town or area"
          onChange={(event) => setPlace(event.target.value)}
        />
      </label>
      <button type="submit">Find shops</button>
    </form>
  );
}
