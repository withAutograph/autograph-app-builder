/** Local capture names only; desktop variants may contain hyphens. */
export function captureFilename(name: string) {
  if (!/^[a-z]+(?:-[a-z]+)*-\d+$/.test(name))
    throw new Error("Unexpected screenshot filename");
  return `${name}.png`;
}
