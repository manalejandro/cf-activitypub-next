/**
 * Files pasted into a composer (screenshots, copied images/videos).
 * Reads `clipboardData.items` (the only source on Safari/Chrome for images)
 * and falls back to `clipboardData.files`, de-duplicating by name+size.
 */
export function clipboardFiles(event: { clipboardData?: DataTransfer | null }): File[] {
  const files: File[] = [];
  const data = event.clipboardData;
  if (!data) return files;
  for (const item of data.items ?? []) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  files.push(...Array.from(data.files ?? []));
  return files.filter(
    (file, index) => files.findIndex((f) => f.name === file.name && f.size === file.size) === index
  );
}
