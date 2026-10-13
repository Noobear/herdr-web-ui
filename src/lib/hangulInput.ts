/**
 * A Korean 2-set (두벌식) input method for the terminal, used where the system's own cannot be: an
 * iPad typed on with its hardware keyboard while the on-screen keyboard is hidden (Settings →
 * Terminal) will not switch its input language in that field. The keys are read by their physical
 * position (KeyboardEvent.code), so the system layout stays Latin; the syllable being built is
 * shown, not sent, and only finished syllables reach the pane.
 */

const CHO = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
const JUNG = ["ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅘ", "ㅙ", "ㅚ", "ㅛ", "ㅜ", "ㅝ", "ㅞ", "ㅟ", "ㅠ", "ㅡ", "ㅢ", "ㅣ"];
const JONG = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];

/** two vowels typed in a row that make one */
const VOWELS: Record<string, string> = { "ㅗㅏ": "ㅘ", "ㅗㅐ": "ㅙ", "ㅗㅣ": "ㅚ", "ㅜㅓ": "ㅝ", "ㅜㅔ": "ㅞ", "ㅜㅣ": "ㅟ", "ㅡㅣ": "ㅢ" };
/** two final consonants typed in a row that make one, and back */
const FINALS: Record<string, string> = { "ㄱㅅ": "ㄳ", "ㄴㅈ": "ㄵ", "ㄴㅎ": "ㄶ", "ㄹㄱ": "ㄺ", "ㄹㅁ": "ㄻ", "ㄹㅂ": "ㄼ", "ㄹㅅ": "ㄽ", "ㄹㅌ": "ㄾ", "ㄹㅍ": "ㄿ", "ㄹㅎ": "ㅀ", "ㅂㅅ": "ㅄ" };
const SPLIT: Record<string, [string, string]> = Object.fromEntries(Object.entries(FINALS).map(([pair, final]) => [final, [pair[0]!, pair[1]!] as [string, string]]));

/** the 2-set layout by physical key: [plain, shifted] */
const KEYS: Record<string, [string, string]> = {
  KeyQ: ["ㅂ", "ㅃ"], KeyW: ["ㅈ", "ㅉ"], KeyE: ["ㄷ", "ㄸ"], KeyR: ["ㄱ", "ㄲ"], KeyT: ["ㅅ", "ㅆ"],
  KeyY: ["ㅛ", "ㅛ"], KeyU: ["ㅕ", "ㅕ"], KeyI: ["ㅑ", "ㅑ"], KeyO: ["ㅐ", "ㅒ"], KeyP: ["ㅔ", "ㅖ"],
  KeyA: ["ㅁ", "ㅁ"], KeyS: ["ㄴ", "ㄴ"], KeyD: ["ㅇ", "ㅇ"], KeyF: ["ㄹ", "ㄹ"], KeyG: ["ㅎ", "ㅎ"],
  KeyH: ["ㅗ", "ㅗ"], KeyJ: ["ㅓ", "ㅓ"], KeyK: ["ㅏ", "ㅏ"], KeyL: ["ㅣ", "ㅣ"],
  KeyZ: ["ㅋ", "ㅋ"], KeyX: ["ㅌ", "ㅌ"], KeyC: ["ㅊ", "ㅊ"], KeyV: ["ㅍ", "ㅍ"], KeyB: ["ㅠ", "ㅠ"], KeyN: ["ㅜ", "ㅜ"], KeyM: ["ㅡ", "ㅡ"],
};

/** The jamo a physical key types in the 2-set layout, or null for a key that is not a letter. */
export function jamoForKey(code: string, shift: boolean): string | null {
  const pair = KEYS[code];
  return pair ? pair[shift ? 1 : 0] : null;
}

const isVowel = (jamo: string): boolean => JUNG.includes(jamo);

interface Block {
  cho: string | null;
  jung: string | null;
  jong: string | null;
}

/** A block as text: a whole syllable, or the lone jamo typed so far. */
function render({ cho, jung, jong }: Block): string {
  if (cho !== null && jung !== null) {
    return String.fromCharCode(0xac00 + (CHO.indexOf(cho) * 21 + JUNG.indexOf(jung)) * 28 + (jong === null ? 0 : JONG.indexOf(jong)));
  }
  return cho ?? jung ?? "";
}

export class HangulComposer {
  /** the block as it stood after each jamo typed into it: Backspace steps back through them */
  private steps: Block[] = [];

  private get block(): Block {
    return this.steps.at(-1) ?? { cho: null, jung: null, jong: null };
  }

  /** What is being built: shown over the cursor, not sent. */
  get preedit(): string {
    return render(this.block);
  }

  /** Types one jamo; answers what it finished, to be sent ("" while the syllable is still open). */
  input(jamo: string): string {
    const { cho, jung, jong } = this.block;
    const start = (next: Block): string => {
      const done = this.preedit;
      this.steps = [next];
      return done;
    };
    const grow = (next: Block): string => {
      this.steps.push(next);
      return "";
    };
    if (isVowel(jamo)) {
      if (jong !== null) {
        // the final moves on to start the next syllable: 각 + ㅏ is 가 then 가; 닭 + ㅏ is 달 then 가
        const split = SPLIT[jong];
        const kept = split ? split[0] : null;
        const moved = split ? split[1] : jong;
        const done = render({ cho, jung, jong: kept });
        this.steps = [{ cho: moved, jung: null, jong: null }, { cho: moved, jung: jamo, jong: null }];
        return done;
      }
      if (jung !== null) {
        const both = VOWELS[jung + jamo];
        return both ? grow({ cho, jung: both, jong: null }) : start({ cho: null, jung: jamo, jong: null });
      }
      if (cho !== null) return grow({ cho, jung: jamo, jong: null });
      return start({ cho: null, jung: jamo, jong: null });
    }
    // a consonant
    if (cho !== null && jung !== null) {
      if (jong === null) return JONG.includes(jamo) ? grow({ cho, jung, jong: jamo }) : start({ cho: jamo, jung: null, jong: null });
      const both = FINALS[jong + jamo];
      return both ? grow({ cho, jung, jong: both }) : start({ cho: jamo, jung: null, jong: null });
    }
    return start({ cho: jamo, jung: null, jong: null });
  }

  /** Takes back the last jamo typed into the open syllable; false when nothing is open. */
  backspace(): boolean {
    if (this.steps.length === 0) return false;
    this.steps.pop();
    return true;
  }

  /** Ends the open syllable as it stands; answers it, to be sent. */
  flush(): string {
    const done = this.preedit;
    this.steps = [];
    return done;
  }
}
