/** Stories render client state without uploading or importing application source. */
// oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
const unavailable = (): Promise<never> => {
  throw new Error("Source upload actions are unavailable in Storybook.");
};
export const beginBuilderSourceUpload = unavailable;
export const putBuilderSourceUploadChunk = unavailable;
export const completeBuilderSourceUpload = unavailable;
export const readBuilderSourceUploadStatus = unavailable;
