import { describe, expect, test } from "vitest";
import { preflightSegmentationWire } from "../../lib/meta/segmentation-preflight";

const box = "<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>";
const mask = "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>";
const wire = `<0f>0${box}${mask}`;

describe("SAM preflight before mask decoding", () => {
  test("accepts documented geometry, reordered fields/tokens and scientific confidence", () => {
    expect(preflightSegmentationWire(wire, 320, 334)).toBe(1);
    const reorderedBox = "<|box; h = 334; c=9.5e-1;x2=270;y2=254;x1=211;w=320;y1=228;|>";
    const reorderedMask = mask.replace("mask;x=0;y=0;data=", "mask;c=.95;y=0;x=0;data=");
    expect(preflightSegmentationWire(`<0f>0${reorderedMask}${reorderedBox}`, 320, 334)).toBe(1);
    expect(preflightSegmentationWire(`<0f>0${box}${mask},1${box}${mask}`, 320, 334)).toBe(2);
    expect(preflightSegmentationWire("", 320, 334)).toBe(0);
  });

  test("rejects hostile declared allocation sizes without decoding payloads", () => {
    for (const data of ["999999999,999999999", "27,61", "0,60", "-27,60", "1e9,60"]) {
      expect(() => preflightSegmentationWire(wire.replace("27,60", data), 320, 334)).toThrowError(expect.objectContaining({ code: "SEGMENTATION_INVALID", outcome: "unknown" }));
    }
    // Individually valid masks cannot exceed the aggregate allocation budget.
    const big = "<|box;x1=0;y1=0;x2=3999;y2=3999;w=4000;h=4000|><|mask;x=0;y=0;data=4000,4000,!dummy|>";
    expect(() => preflightSegmentationWire(`<0f>0${big}1${big}2${big}`, 4000, 4000)).toThrow();
  });

  test("rejects unsupported geometry and ambiguous fields before parser invocation", () => {
    const invalid = [
      wire.replace("w=320", "w=321"), wire.replace("x1=211", "x1=-1"), wire.replace("x2=270", "x2=320"),
      wire.replace("x1=211", "x1=271"), wire.replace("w=320", "w=320;w=320"),
      wire.replace("h=334", "h=334;c=1.1"), wire.replace("h=334", "h=334;c=NaN"),
      wire.replace("h=334", "h=334;unknown=1"), wire.replace("mask;x=0", "mask;x=1"),
      wire.replace("<0f>", "<1f>"), wire.replace("<0f>", "<0f;ignored=1>"),
      `${wire}\n${wire}`, `${wire}0${box}${mask}`, `${wire}<|other;x=1|>`, `${wire}${box}`,
      `<0f>${Array.from({ length: 17 }, (_, id) => `${id}${box}${mask}`).join(",")}`,
      "<0f>", `${wire},`, `${wire}junk`, wire.replace("data=27,60,~", "data=27,60,X"),
    ];
    for (const value of invalid) expect(() => preflightSegmentationWire(value, 320, 334)).toThrow();
  });
});
