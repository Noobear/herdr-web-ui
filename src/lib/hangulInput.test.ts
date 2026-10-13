import { describe, expect, test } from "bun:test";
import { HangulComposer, jamoForKey } from "./hangulInput.ts";

/** Types physical keys (`r`, `R` for shifted) and answers what was sent plus what is still open. */
function type(keys: string): { sent: string; open: string } {
  const composer = new HangulComposer();
  let sent = "";
  for (const key of keys) {
    if (key === "<") {
      composer.backspace();
      continue;
    }
    const shift = key !== key.toLowerCase();
    sent += composer.input(jamoForKey(`Key${key.toUpperCase()}`, shift)!);
  }
  return { sent, open: composer.preedit };
}

describe("the 2-set layout", () => {
  test("reads a key by its position, shifted or not", () => {
    expect(jamoForKey("KeyG", false)).toBe("ㅎ");
    expect(jamoForKey("KeyK", false)).toBe("ㅏ");
    expect(jamoForKey("KeyR", true)).toBe("ㄲ");
    expect(jamoForKey("KeyO", true)).toBe("ㅒ");
    expect(jamoForKey("KeyA", true)).toBe("ㅁ");
    expect(jamoForKey("Digit1", false)).toBeNull();
  });
});

describe("composing Hangul", () => {
  test("builds syllables and sends each once it is finished", () => {
    expect(type("gksrmf")).toEqual({ sent: "한", open: "글" });
    expect(type("dkssud")).toEqual({ sent: "안", open: "녕" });
  });

  test("moves a final consonant on to the next syllable when a vowel follows", () => {
    expect(type("rkrk")).toEqual({ sent: "가", open: "가" });
    // a double final splits: 닭 + ㅏ is 달 then 가
    expect(type("ekfrk")).toEqual({ sent: "달", open: "가" });
  });

  test("makes double vowels and double finals", () => {
    expect(type("dhk")).toEqual({ sent: "", open: "와" });
    expect(type("dnl")).toEqual({ sent: "", open: "위" });
    expect(type("ekfr")).toEqual({ sent: "", open: "닭" });
    expect(type("dksg")).toEqual({ sent: "", open: "않" });
    expect(type("tkfa")).toEqual({ sent: "", open: "삶" });
  });

  test("types shifted consonants and vowels", () => {
    expect(type("Rk")).toEqual({ sent: "", open: "까" });
    expect(type("dO")).toEqual({ sent: "", open: "얘" });
  });

  test("keeps consonants and vowels typed alone", () => {
    expect(type("zz")).toEqual({ sent: "ㅋ", open: "ㅋ" });
    expect(type("k")).toEqual({ sent: "", open: "ㅏ" });
  });

  test("a consonant that cannot end a syllable starts the next one", () => {
    // ㄸ is never a final
    expect(type("rkE")).toEqual({ sent: "가", open: "ㄸ" });
  });

  test("Backspace takes back one jamo of the open syllable at a time", () => {
    expect(type("gks<")).toEqual({ sent: "", open: "하" });
    expect(type("gks<<")).toEqual({ sent: "", open: "ㅎ" });
    expect(type("gks<<<")).toEqual({ sent: "", open: "" });
    expect(type("ekfr<")).toEqual({ sent: "", open: "달" });
    // after a final moved on, Backspace works on the new syllable
    expect(type("rkrk<")).toEqual({ sent: "가", open: "ㄱ" });
  });

  test("flush ends the open syllable and has nothing left to take back", () => {
    const composer = new HangulComposer();
    for (const key of "gks") composer.input(jamoForKey(`Key${key.toUpperCase()}`, false)!);
    expect(composer.flush()).toBe("한");
    expect(composer.preedit).toBe("");
    expect(composer.backspace()).toBe(false);
  });
});
