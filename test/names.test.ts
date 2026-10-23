import { describe, expect, it } from "vitest";
import { nameSimilarity, decide } from "../src/engines/world-model/index.ts";
import { companyKey, normalizeEntityName } from "../src/util/names.ts";
import { goodsPhrase, productName, shortName } from "../src/util/text.ts";

describe("name keys", () => {
  it("removes legal suffixes, expands abbreviations and drops country words", () => {
    expect(companyKey("Sunrise Glove Ind. Sdn. Bhd.")).toBe("sunrise glove industries");
    expect(companyKey("Sunrise Glove Industries Sdn. Bhd. (Malaysia)")).toBe("sunrise glove industries");
    expect(companyKey("Uniform Hub Australia Pty Ltd")).toBe("uniform hub");
    expect(normalizeEntityName("PACIFIC STAR TRADING COMPANY LIMITED")).toBe("pacific star trading");
  });

  it("puts the demo's portal names in the expected merge bands", () => {
    const band = (a: string, b: string) => decide(nameSimilarity(companyKey(a), companyKey(b)));
    expect(band("Cleanpro Supply Co", "CleanPro Supplies Pty Ltd")).toBe("review");
    expect(band("Nordic Clean Equipment", "NordicClean Equipment Pty Ltd")).toBe("auto-merge");
    expect(band("Yiwu Bright Textiles Co Ltd", "Yiwu Bright Textile Co., Ltd")).toBe("auto-merge");
    expect(band("GreenBag Packaging", "Pacific Star Trading")).toBe("new");
  });

  it("writes plain product and company names", () => {
    expect(productName("Nitrile examination gloves, powder-free, size L (box of 100)")).toBe("nitrile examination gloves");
    expect(productName("Microfibre cleaning cloths 40x40cm (pack of 10)")).toBe("microfibre cleaning cloths");
    expect(shortName("Yiwu Bright Textile Co., Ltd")).toBe("Yiwu Bright Textile");
    expect(shortName("Sunrise Glove Industries Sdn Bhd")).toBe("Sunrise Glove Industries");
    expect(goodsPhrase(["Rubber Gloves"])).toEqual({ text: "rubber gloves", verb: "are" });
    expect(goodsPhrase(["Polysilicon"])).toEqual({ text: "polysilicon", verb: "is" });
  });
});
