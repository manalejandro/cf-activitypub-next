import { describe, it, expect } from "vitest";
import { mediaDownloadName } from "@/lib/media/filename";

const CACHE = "https://cf-ap.com/api/media/cache/media/0e99cfb7a8390698012f9394b69d8043d575fe89daac9eb3d1386d069ae25529.jpg";
const UPLOAD_V1 = "https://cf-ap.com/api/media/media/manalejandro/2637e10112db499192546501eaa03298.mp3";
const UPLOAD_V2 = "https://cf-ap.com/api/media/media/manalejandro/9f8a3c1e-2b4d-4e6f-8a90-112233445566-foto%20de%20la%20playa.png";

describe("mediaDownloadName", () => {
  it("uses the description the user wrote when publishing", () => {
    expect(mediaDownloadName({ url: CACHE, description: "Un gato durmiendo" })).toBe("Un gato durmiendo.jpg");
  });

  it("keeps an extension the description already carries", () => {
    expect(mediaDownloadName({ url: CACHE, description: "vacaciones.JPG" })).toBe("vacaciones.JPG");
  });

  it("strips path-hostile characters from the description", () => {
    expect(mediaDownloadName({ url: CACHE, description: 'a/b\\c:d*e?f"g<h>i|j' })).toBe("a b c d e f g h i j.jpg");
  });

  it("falls back to the file name of the user's own upload", () => {
    expect(mediaDownloadName({ url: UPLOAD_V2 })).toBe("foto de la playa.png");
  });

  it("falls back to the bucket name when there is nothing better", () => {
    expect(mediaDownloadName({ url: UPLOAD_V1 })).toBe("2637e10112db499192546501eaa03298.mp3");
    expect(mediaDownloadName({ url: CACHE, description: "   " })).toBe("0e99cfb7a8390698012f9394b69d8043d575fe89daac9eb3d1386d069ae25529.jpg");
  });

  it("ignores query strings and handles a missing extension", () => {
    expect(mediaDownloadName({ url: `${CACHE}?v=2`, description: "gato" })).toBe("gato.jpg");
    expect(mediaDownloadName({ url: "https://cf-ap.com/api/media/cache/media/abc123", description: "gato" })).toBe("gato");
  });

  it("prefers the description over the upload name", () => {
    expect(mediaDownloadName({ url: UPLOAD_V2, description: "Playa al atardecer" })).toBe("Playa al atardecer.png");
  });
});
