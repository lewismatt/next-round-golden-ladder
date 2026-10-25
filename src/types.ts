// SPDX-License-Identifier: Apache-2.0
import type { Json } from "@next-round/contracts";

/** Points for rungs 1–15, in order. Two safe havens: rung 5 and rung 10. */
export const LADDER: readonly number[] = [
  100, 200, 300, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 125000,
  250000, 500000, 1000000,
];

/** 1-based rungs that are safe havens. */
export const HAVEN_RUNGS: readonly number[] = [5, 10];

export const TOTAL_RUNGS = 15;

export type LifelineId = "fiftyFifty" | "tagIn" | "swap";

export type EndReason = "top" | "wrong" | "walked" | "ended_early";

export interface GoldenLadderSettings {
  turnSeconds: number | null;
}

export interface GoldenLadderQuestion {
  id: string;
  rung: number;
  prompt: string;
  choices: string[];
  correctChoice: number;
  explanation: string;
  [key: string]: Json;
}

export interface GoldenLadderBank {
  format: "next-round.golden-ladder/1";
  title: string;
  attribution: string;
  license: "CC0-1.0";
  questions: GoldenLadderQuestion[];
  [key: string]: Json;
}

/** A resolved rung, revealed to the whole team once it is answered. */
export interface LadderReveal {
  rung: number;
  questionId: string;
  prompt: string;
  choices: string[];
  correctChoice: number;
  explanation: string;
  answererMemberId: string;
  choice: number;
  correct: boolean;
  [key: string]: Json;
}

export interface LifelineUse {
  lifeline: LifelineId;
  memberId: string;
  [key: string]: Json;
}

export interface GoldenLadderState {
  /** Drawn question id per rung (index 0 is rung 1). Server state only in
   * the sense that ids are meaningless without the bank; the correct
   * answers live in the resource and are never projected into a view
   * before a rung resolves. */
  drawIds: string[];
  /** Swap spare question id per rung, or null once the spare is used. */
  spareIds: (string | null)[];
  currentQuestionId: string;
  playerOrder: string[];
  currentMemberId: string | null;
  /** Current rung, 1-based (1–15). */
  currentRung: number;
  /** Highest rung answered correctly so far (0 before rung 1). */
  lastCorrectRung: number;
  lifelinesUsed: Record<LifelineId, boolean>;
  lifelineUses: LifelineUse[];
  /** Choice indexes removed by Fifty-Fifty on the live question. */
  fiftyRemoved: number[];
  history: LadderReveal[];
  endReason: EndReason | null;
  endedByMemberId: string | null;
  generation: number;
  dueAt: string | null;
  suspended: boolean;
  suspendedRemainingMs: number | null;
  [key: string]: Json;
}

export interface LadderPlayerProgress {
  memberId: string;
  answered: number;
  correct: number;
  [key: string]: Json;
}

export interface PublicQuestion {
  id: string;
  prompt: string;
  choices: string[];
  [key: string]: Json;
}

export interface GoldenLadderView {
  phase: "lobby" | "active" | "finished";
  ladder: number[];
  havenRungs: number[];
  currentRung: number;
  lastCorrectRung: number;
  /** Points banked if the answerer walks away now. */
  securedPoints: number;
  /** Safe-haven floor: points kept after a wrong answer right now. */
  havenFloor: number;
  question: PublicQuestion | null;
  removedChoices: number[];
  myMemberId: string | null;
  currentMemberId: string | null;
  canAct: boolean;
  tagInAvailable: boolean;
  swapAvailable: boolean;
  lifelinesUsed: Record<LifelineId, boolean>;
  players: LadderPlayerProgress[];
  history: LadderReveal[];
  endReason: EndReason | null;
  /** Final banked points once finished; null while the run is live. */
  banked: number | null;
  endedByMemberId: string | null;
  dueAt: string | null;
  suspended: boolean;
  attribution: string | null;
  [key: string]: Json;
}
