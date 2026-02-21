export function ocrEnabled(){
  return !!process.env.OCR_SPACE_API_KEY;
}

export async function ocrSpaceImageUrl(imageUrl){
  if(!ocrEnabled()) throw new Error("ocr_not_configured");
  const key = process.env.OCR_SPACE_API_KEY;
  const body = new URLSearchParams();
  body.set("apikey", key);
  body.set("url", imageUrl);
  body.set("language", process.env.OCR_LANG || "eng");
  body.set("OCREngine", process.env.OCR_ENGINE || "2");
  body.set("scale", "true");

  const resp = await fetch("https://api.ocr.space/parse/imageurl", { method:"POST", body });
  const j = await resp.json();
  const parsed = j?.ParsedResults?.[0]?.ParsedText || "";
  const err = j?.ErrorMessage;
  if(err && String(err).length) throw new Error(String(err));
  return parsed.trim();
}
