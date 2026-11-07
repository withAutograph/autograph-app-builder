/** Stories render client state without uploading or importing application source. */
const unavailable = async (): Promise<never> => {
  await Promise.resolve();
  throw new Error("Source upload actions are unavailable in Storybook.");
};
export const beginBuilderSourceUpload = unavailable;
export const putBuilderSourceUploadChunk = unavailable;
export const completeBuilderSourceUpload = unavailable;
export const readBuilderSourceUploadStatus = unavailable;
