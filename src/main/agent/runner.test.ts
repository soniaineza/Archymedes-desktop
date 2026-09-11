import { describe, expect, it } from "vitest";
import { parseMentions } from "./runner";

describe("parseMentions", () => {
  it("finds file and directory mentions", () => {
    expect(parseMentions("fix @src/a.ts and look in @src")).toEqual(["src/a.ts", "src"]);
  });

  it("ignores email addresses", () => {
    expect(parseMentions("mail me@example.com about @README.md")).toEqual(["README.md"]);
  });

  it("strips trailing sentence punctuation", () => {
    expect(parseMentions("see @src/main.ts. Also @docs, then @notes!")).toEqual(["src/main.ts", "docs", "notes"]);
  });

  it("deduplicates repeated mentions", () => {
    expect(parseMentions("@a.ts vs @a.ts")).toEqual(["a.ts"]);
  });

  it("matches a mention at the very start", () => {
    expect(parseMentions("@package.json what deps?")).toEqual(["package.json"]);
  });
});
