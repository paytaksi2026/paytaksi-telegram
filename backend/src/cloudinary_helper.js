import crypto from "crypto";

/**
 * Signed Cloudinary upload (recommended)
 * ENV:
 *  CLOUDINARY_CLOUD_NAME
 *  CLOUDINARY_API_KEY
 *  CLOUDINARY_API_SECRET
 */
export function cloudinaryEnabled(){
  return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

export function cloudinarySignature(params){
  // Cloudinary signature: sha1 of sorted params joined with & + api_secret
  const secret = process.env.CLOUDINARY_API_SECRET || "";
  const keys = Object.keys(params).sort();
  const toSign = keys.map(k => `${k}=${params[k]}`).join("&") + secret;
  return crypto.createHash("sha1").update(toSign).digest("hex");
}

export function cloudinaryConfig(){
  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || "",
    apiKey: process.env.CLOUDINARY_API_KEY || "",
  };
}
