import { describe, expect, test } from "./harness.ts";
import { adjacentUrls, guardUrlBoundaries, wrapAdjacentUrls } from "../ts/urlGuard.ts";

describe("URL boundaries", () => {
  for (const suffix of ["内容", "）", "」", "。", "、", ">", ">*", "\u00a0内容", "\u3000内容"]) {
    test(`rejects ambiguous suffix ${JSON.stringify(suffix)}`, () => {
      const url = `https://example.com/path/${suffix}`;
      expect(adjacentUrls(url)).toEqual([url]);
      expect(() => guardUrlBoundaries(url)).toThrow("Put the URL on its own line");
    });
  }
  for (const text of [
    "https://example.com/path/\n内容", "https://example.com/path/\r\n内容",
    "https://example.com/path/ 内容", "https://example.com/path/\t内容",
    "<https://example.com/path/>内容", "<https://example.com/path/|説明>内容",
    "<https://example.com/日本語>", "https://example.com/%E5%B1%B1?a=1&b=2#part",
    "HTTP://example.com/path/\n内容",
  ]) {
    test(`accepts explicit boundary ${JSON.stringify(text)}`, () => {
      expect(adjacentUrls(text)).toEqual([]);
      expect(() => guardUrlBoundaries(text)).not.toThrow();
    });
  }
  test("an explicit link does not hide a later ambiguous URL", () => {
    expect(adjacentUrls("<https://example.com/|説明> https://example.com/内容"))
      .toEqual(["https://example.com/内容"]);
  });
  test("override emits a warning naming the URL", () => {
    const warnings: string[] = [];
    guardUrlBoundaries("http://example.com/内容", true, (s) => warnings.push(s));
    expect(warnings[0]).toContain("Warning: Ambiguous URL boundary");
    expect(warnings[0]).toContain("http://example.com/内容");
  });
  for (const prefix of ["《手袋を買いに》", "（给小学生的新闻网站）", "「見て」", "说明：", "見て"]) {
    test(`rejects a URL glued after ${JSON.stringify(prefix)}`, () => {
      expect(adjacentUrls(`${prefix}https://example.com/a`)).toEqual(["https://example.com/a"]);
    });
  }
  for (const text of ["(see)https://example.com/a", "見て https://example.com/a", "見て\nhttps://example.com/a", "見て<https://example.com/a>"]) {
    test(`accepts ${JSON.stringify(text)}`, () => expect(adjacentUrls(text)).toEqual([]));
  }
  test("wrapAdjacentUrls fixes both sides and leaves the rest", () => {
    expect(wrapAdjacentUrls("《手袋を買いに》https://example.com/a 次")).toBe("《手袋を買いに》<https://example.com/a> 次");
    expect(wrapAdjacentUrls("看https://example.com/a。好")).toBe("看<https://example.com/a>。好");
    expect(wrapAdjacentUrls("https://example.com/a\n<https://example.com/b|説明>（x）")).toBe("https://example.com/a\n<https://example.com/b|説明>（x）");
    expect(adjacentUrls(wrapAdjacentUrls("（站）https://example.com/a，好"))).toEqual([]);
  });

  test("scheme-less host/path glued to CJK is wrapped, plain words are not", () => {
    expect(wrapAdjacentUrls("已建 github.com/snomiao/.env.payments.enc，把文件搬过去"))
      .toBe("已建 <https://github.com/snomiao/.env.payments.enc|github.com/snomiao/.env.payments.enc>，把文件搬过去");
    expect(adjacentUrls("仓库github.com/a/b里")).toEqual(["github.com/a/b里"]);
    expect(wrapAdjacentUrls("see github.com/a/b for details, e.g. v1.2")).toBe("see github.com/a/b for details, e.g. v1.2");
    expect(wrapAdjacentUrls("<https://github.com/a/b|github.com/a/b>，好")).toBe("<https://github.com/a/b|github.com/a/b>，好");
    expect(wrapAdjacentUrls("mail me at a@b.com/x，好")).toBe("mail me at a@b.com/x，好");
  });
});
