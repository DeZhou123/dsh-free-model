const REQUEST_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const RACCOON_REQUEST_IMAGE_MAX_BYTES = 512 * 1024;
const DEFAULT_BODY_LIMITED_IMAGE_MAX_BYTES = 1024 * 1024;
const DEFAULT_IMAGE_PIXEL_BUDGET = 64e4;
function fitImageToPixelBudget(width, height, maxPixels) {
  if (!isPositiveFinite(width) || !isPositiveFinite(height)) return void 0;
  if (!isPositiveFinite(maxPixels)) return void 0;
  if (width * height <= maxPixels) return { width: Math.floor(width), height: Math.floor(height) };
  const scale = Math.sqrt(maxPixels / (width * height));
  const targetWidth = Math.max(1, Math.floor(width * scale));
  const targetHeight = Math.max(1, Math.floor(height * scale));
  return { width: targetWidth, height: targetHeight };
}
function requestImageTargetFor(width, height, maxPixels, maxBytes = REQUEST_IMAGE_MAX_BYTES) {
  const fitted = fitImageToPixelBudget(width, height, maxPixels ?? DEFAULT_IMAGE_PIXEL_BUDGET);
  if (fitted === void 0) return void 0;
  return { width: fitted.width, height: fitted.height, maxBytes: maxBytes ?? REQUEST_IMAGE_MAX_BYTES };
}
async function projectRequestImage(attachment, options) {
  const readImageRequest = options.readImageRequest;
  if (readImageRequest === void 0) return void 0;
  const { width, height } = attachment;
  if (typeof width !== "number" || typeof height !== "number") return void 0;
  const target = requestImageTargetFor(width, height, options.pixelBudget, options.maxBytes);
  if (target === void 0) return void 0;
  try {
    return await readImageRequest(attachment, target);
  } catch {
    return void 0;
  }
}
function isPositiveFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
export {
  DEFAULT_BODY_LIMITED_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_PIXEL_BUDGET,
  RACCOON_REQUEST_IMAGE_MAX_BYTES,
  REQUEST_IMAGE_MAX_BYTES,
  fitImageToPixelBudget,
  projectRequestImage,
  requestImageTargetFor
};
