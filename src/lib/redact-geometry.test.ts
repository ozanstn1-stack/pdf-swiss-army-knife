import { describe, expect, it } from "vitest";
import { padArea, rectToUserSpace, userSpaceToRect } from "./redact-geometry";

const A4 = { width: 595.28, height: 841.89 };

describe("rectToUserSpace", () => {
  it("flips the vertical axis so a box drawn near the top lands near the top", () => {
    // A band across the top 10% of the page, in canvas coordinates.
    const area = rectToUserSpace({ x: 0.1, y: 0.05, w: 0.5, h: 0.05 }, A4);
    expect(area).not.toBeNull();
    // 5%..10% from the top is 90%..95% of the height measured from the bottom.
    expect(area!.top).toBeCloseTo(A4.height * 0.95, 5);
    expect(area!.bottom).toBeCloseTo(A4.height * 0.9, 5);
    expect(area!.left).toBeCloseTo(A4.width * 0.1, 5);
    expect(area!.right).toBeCloseTo(A4.width * 0.6, 5);
  });

  it("puts a box drawn at the bottom of the page near y=0 in user space", () => {
    // 90%..98% from the top is 2%..10% of the height measured from the bottom.
    const area = rectToUserSpace({ x: 0, y: 0.9, w: 1, h: 0.08 }, A4)!;
    expect(area.top).toBeCloseTo(A4.height * 0.1, 5);
    expect(area.bottom).toBeCloseTo(A4.height * 0.02, 5);
    expect(area.bottom).toBeLessThan(A4.height * 0.05);
  });

  it("maps the full page to the full page", () => {
    const area = rectToUserSpace({ x: 0, y: 0, w: 1, h: 1 }, A4)!;
    expect(area).toEqual({ left: 0, bottom: 0, right: A4.width, top: A4.height });
  });

  it("rejects a click that was not a drag", () => {
    expect(rectToUserSpace({ x: 0.5, y: 0.5, w: 0, h: 0 }, A4)).toBeNull();
    // 1pt wide is below the 2pt floor, so it would remove nothing.
    expect(rectToUserSpace({ x: 0.5, y: 0.5, w: 1 / A4.width, h: 0.2 }, A4)).toBeNull();
  });

  it("rejects a page with no geometry instead of producing NaN coordinates", () => {
    const broken = rectToUserSpace({ x: 0, y: 0, w: 1, h: 1 }, { width: 0, height: 0 });
    expect(broken).toBeNull();
    expect(rectToUserSpace({ x: 0, y: 0, w: 1, h: 1 }, { width: 595, height: Number.NaN })).toBeNull();
  });

  it("clamps a drag that runs past the edge of the page", () => {
    const area = rectToUserSpace({ x: -0.2, y: -0.1, w: 2, h: 2 }, A4)!;
    expect(area).toEqual({ left: 0, bottom: 0, right: A4.width, top: A4.height });
  });
});

describe("userSpaceToRect", () => {
  it("is the inverse of rectToUserSpace", () => {
    const original = { x: 0.2, y: 0.3, w: 0.25, h: 0.08 };
    const area = rectToUserSpace(original, A4)!;
    const back = userSpaceToRect(area, A4);
    expect(back.x).toBeCloseTo(original.x, 8);
    expect(back.y).toBeCloseTo(original.y, 8);
    expect(back.w).toBeCloseTo(original.w, 8);
    expect(back.h).toBeCloseTo(original.h, 8);
  });
});

describe("padArea", () => {
  it("grows the box on every side", () => {
    const area = { left: 100, bottom: 200, right: 300, top: 220 };
    expect(padArea(area, 2, A4)).toEqual({ left: 98, bottom: 198, right: 302, top: 222 });
  });

  it("does not grow past the page edge", () => {
    const area = { left: 0, bottom: 0, right: A4.width, top: A4.height };
    expect(padArea(area, 10, A4)).toEqual({ left: 0, bottom: 0, right: A4.width, top: A4.height });
  });
});
