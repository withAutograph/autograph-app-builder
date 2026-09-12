/** Local capture names only; desktop variants may contain hyphens or dimensions. */
export function captureFilename(name: string) {
  if (!/^(?:[a-z]+(?:-[a-z]+)*|desktop-custom-[1-9]\d*x[1-9]\d*)-\d+$/u.test(name))
    throw new Error("Unexpected screenshot filename");
  return `${name}.png`;
}
