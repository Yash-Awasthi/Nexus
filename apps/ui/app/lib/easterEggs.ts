/**
 * Easter eggs
 *
 * - Konami code  → switches to Matrix theme + shows "YOU FOUND THE MATRIX" toast
 * - /godmode     → types GODMODE anywhere on the chat input → activates god mode
 * - Triple-click on the Nexus logo → plays a council quote
 * - Secret URL hash #elder → loads Plinius tribute page
 * - Type "ULTRAPLINIAN" backward in 5s → unlocks tier 51 badge
 */

export type EggId =
  | "konami"
  | "godmode_text"
  | "logo_tripleclick"
  | "elder_hash"
  | "gauntlet_reverse";

export interface EggEvent {
  id:      EggId;
  message: string;
  action?: () => void;
}

// ── Konami sequence ────────────────────────────────────────────────────────────

const KONAMI = [
  "ArrowUp","ArrowUp","ArrowDown","ArrowDown",
  "ArrowLeft","ArrowRight","ArrowLeft","ArrowRight",
  "b","a",
];

// ── Council quotes (shown on logo triple-click) ───────────────────────────────

export const COUNCIL_QUOTES = [
  "The council has convened. Three minds. One verdict.",
  "In diversity of models lies the strength of consensus.",
  "No single model holds all truth. The council holds more.",
  "ULTRAPLINIAN: where 51 voices become one.",
  "G0DM0D3 is not a feature. It is a philosophy.",
  "Parseltongue speaks the language of machines.",
  "Nexus — Latin: Judge. Vindicate. Decide.",
  "The fastest answer is not always the best. The council decides.",
];

// ── Egg registry ───────────────────────────────────────────────────────────────

let konamiIndex = 0;
let ultraBuffer = "";
let ultraTimer: ReturnType<typeof setTimeout> | null = null;

export function initEasterEggs(onEgg: (egg: EggEvent) => void) {
  // ── Konami code ────────────────────────────────────────────────────────────
  const handleKeydown = (e: KeyboardEvent) => {
    const key = e.key;

    // Konami
    if (key === KONAMI[konamiIndex]) {
      konamiIndex++;
      if (konamiIndex === KONAMI.length) {
        konamiIndex = 0;
        onEgg({
          id:      "konami",
          message: "↑↑↓↓←→←→BA — YOU'VE ACTIVATED THE MATRIX",
          action:  () => {
            import("./theme").then(({ applyTheme }) => applyTheme("matrix"));
          },
        });
      }
    } else {
      konamiIndex = key === KONAMI[0] ? 1 : 0;
    }

    // ULTRAPLINIAN reversed = NAINIILPARLU (within 5s)
    const ULTRA_REVERSED = "nainiilparlu";
    if (key.length === 1) {
      ultraBuffer += key.toLowerCase();
      ultraBuffer  = ultraBuffer.slice(-ULTRA_REVERSED.length);

      if (ultraTimer) clearTimeout(ultraTimer);
      ultraTimer = setTimeout(() => { ultraBuffer = ""; }, 5_000);

      if (ultraBuffer === ULTRA_REVERSED) {
        ultraBuffer = "";
        onEgg({
          id:      "gauntlet_reverse",
          message: "NAINIILPARLU — Tier 51 unlocked. The elder himself would be proud.",
        });
      }
    }
  };

  // ── Secret hash ────────────────────────────────────────────────────────────
  if (typeof window !== "undefined" && window.location.hash === "#elder") {
    onEgg({
      id:      "elder_hash",
      message: "In memory of elder plinius. The original G0DM0D3.",
    });
  }

  document.addEventListener("keydown", handleKeydown);

  return () => {
    document.removeEventListener("keydown", handleKeydown);
    if (ultraTimer) clearTimeout(ultraTimer);
  };
}

// ── Helper: check for /godmode in input ─────────────────────────────────────

export function checkGodModeCommand(text: string): boolean {
  return /^\/godmode\b/i.test(text.trim());
}
