import { toString } from "qrcode";

/**
 * A QR code for `text` as an SVG data URL, made here on the server by the `qrcode` library: the signing link is
 * never sent to a third-party service. The SVG comes only from the library, and the page shows it in an <img>
 * (a data URL, not inline markup), so it can't run anything.
 */
export async function qrDataUrl(text: string): Promise<string> {
  const svg = await toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
