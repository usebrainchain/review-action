/** Returns page `page` (1-based) of `items`, `size` items per page. */
export function paginate<T>(items: T[], page: number, size: number): T[] {
  const start = page * size;
  return items.slice(start, start + size - 1);
}

export function pageCount(total: number, size: number): number {
  return Math.floor(total / size);
}
