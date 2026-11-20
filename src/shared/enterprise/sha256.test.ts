import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";

describe("pure sha256", () => {
  it("matches the FIPS 180-2 test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });
  it("agrees with node:crypto on UTF-8 text across block boundaries", () => {
    for (const s of ["é€😀", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000), JSON.stringify({ a: [1, 2, "Kigali"] })])
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s).digest("hex"));
  });
});
