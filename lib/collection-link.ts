/**
 * Where a collection link should point: local collections have their own page,
 * remote (FEP-7aa9) ones open the remote web URL from the AP object.
 */
export function collectionHref(collection: {
  id: string;
  local?: boolean;
  url?: string | null;
}): string {
  if (collection.local === false) return collection.url ?? collection.id;
  return `/collections/${encodeURIComponent(collection.id)}`;
}

/** True when the collection lives on another instance (external link). */
export function isExternalCollection(collection: { local?: boolean }): boolean {
  return collection.local === false;
}
