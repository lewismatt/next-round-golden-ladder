// SPDX-License-Identifier: Apache-2.0
import {
  SDK_IDENTIFIER,
  type GameManifest,
  type Schema,
} from "@next-round/contracts";

function object(properties: Record<string, Schema>): Schema {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
const text = (maxLength: number): Schema => ({
  type: "string",
  minLength: 1,
  maxLength,
});
const ids: Schema = {
  type: "array",
  items: { type: "string" },
  uniqueItems: true,
  maxItems: 8,
};
const choice: Schema = { type: "integer", minimum: 0, maximum: 3 };
const choices: Schema = {
  type: "array",
  items: text(300),
  minItems: 4,
  maxItems: 4,
  uniqueItems: true,
};
const questionCore = {
  id: text(80),
  prompt: text(1000),
  choices,
  correctChoice: choice,
  explanation: text(2000),
};
const bankQuestion = object({
  ...questionCore,
  rung: { type: "integer", minimum: 1, maximum: 15 },
});
const publicQuestion = object({
  id: text(80),
  prompt: text(1000),
  choices,
});
const reveal = object({
  rung: { type: "integer", minimum: 1, maximum: 15 },
  questionId: text(80),
  prompt: text(1000),
  choices,
  correctChoice: choice,
  explanation: text(2000),
  answererMemberId: text(80),
  choice,
  correct: { type: "boolean" },
});
const history: Schema = { type: "array", items: reveal, maxItems: 15 };
const lifelinesUsed = object({
  fiftyFifty: { type: "boolean" },
  tagIn: { type: "boolean" },
  swap: { type: "boolean" },
});
const lifelineUse = object({
  lifeline: { enum: ["fiftyFifty", "tagIn", "swap"] },
  memberId: text(80),
});
const nullableTime: Schema = { type: ["string", "null"] };
const nullableText: Schema = { type: ["string", "null"] };
const endReason: Schema = {
  anyOf: [{ enum: ["top", "wrong", "walked", "ended_early"] }, { type: "null" }],
};
const progress = object({
  memberId: text(80),
  answered: { type: "integer", minimum: 0, maximum: 15 },
  correct: { type: "integer", minimum: 0, maximum: 15 },
});
const questionIds: Schema = {
  type: "array",
  items: text(80),
  minItems: 15,
  maxItems: 15,
};
const spareIds: Schema = {
  type: "array",
  items: { anyOf: [text(80), { type: "null" }] },
  minItems: 15,
  maxItems: 15,
};

export const goldenLadderBankSchema: Schema = object({
  format: { const: "next-round.golden-ladder/1", type: "string" },
  title: text(120),
  attribution: text(500),
  license: { const: "CC0-1.0", type: "string" },
  questions: {
    type: "array",
    items: bankQuestion,
    minItems: 1,
    maxItems: 1000,
  },
});

export const manifest: GameManifest = {
  id: "golden-ladder",
  name: "Golden Ladder",
  version: "0.1.0",
  sdk: SDK_IDENTIFIER,
  platformRange: ">=0.1.0 <1.0.0",
  stateVersion: 1,
  resultVersion: 1,
  description:
    "A cooperative ladder climb: a team answers in rotation, one wrong answer ends the run.",
  modes: [
    {
      id: "solo",
      label: "Solo",
      minPlayersToStart: 1,
      maxPlayers: 1,
      lateJoin: false,
      rejoin: true,
    },
    {
      id: "group",
      label: "Group",
      minPlayersToStart: 2,
      maxPlayers: 8,
      lateJoin: false,
      rejoin: true,
    },
  ],
  capabilities: {
    chat: true,
    deadlines: true,
    solo: true,
    resources: true,
    careerStats: true,
  },
  settingsSchema: object({
    turnSeconds: {
      type: ["integer", "null"],
      minimum: 30,
      maximum: 604800,
    },
  }),
  actionSchemas: {
    answer: object({ choice }),
    fifty_fifty: object({}),
    tag_in: object({}),
    swap: object({}),
    walk_away: object({}),
  },
  stateSchema: object({
    drawIds: questionIds,
    spareIds,
    currentQuestionId: text(80),
    playerOrder: ids,
    currentMemberId: nullableText,
    currentRung: { type: "integer", minimum: 1, maximum: 15 },
    lastCorrectRung: { type: "integer", minimum: 0, maximum: 15 },
    lifelinesUsed,
    lifelineUses: { type: "array", items: lifelineUse, maxItems: 3 },
    fiftyRemoved: {
      type: "array",
      items: choice,
      maxItems: 2,
      uniqueItems: true,
    },
    history,
    endReason,
    endedByMemberId: nullableText,
    generation: { type: "integer", minimum: 0 },
    dueAt: nullableTime,
    suspended: { type: "boolean" },
    suspendedRemainingMs: {
      type: ["integer", "null"],
      minimum: 0,
      maximum: 604800000,
    },
  }),
  viewSchema: object({
    phase: { enum: ["lobby", "active", "finished"] },
    ladder: {
      type: "array",
      items: { type: "integer", minimum: 0, maximum: 1000000 },
      minItems: 15,
      maxItems: 15,
    },
    havenRungs: {
      type: "array",
      items: { type: "integer", minimum: 1, maximum: 15 },
      minItems: 2,
      maxItems: 2,
    },
    currentRung: { type: "integer", minimum: 1, maximum: 15 },
    lastCorrectRung: { type: "integer", minimum: 0, maximum: 15 },
    securedPoints: { type: "integer", minimum: 0, maximum: 1000000 },
    havenFloor: { type: "integer", minimum: 0, maximum: 1000000 },
    question: { anyOf: [publicQuestion, { type: "null" }] },
    removedChoices: {
      type: "array",
      items: choice,
      maxItems: 2,
      uniqueItems: true,
    },
    myMemberId: nullableText,
    currentMemberId: nullableText,
    canAct: { type: "boolean" },
    tagInAvailable: { type: "boolean" },
    swapAvailable: { type: "boolean" },
    lifelinesUsed,
    players: { type: "array", items: progress, maxItems: 8 },
    history,
    endReason,
    banked: { type: ["integer", "null"], minimum: 0, maximum: 1000000 },
    endedByMemberId: nullableText,
    dueAt: nullableTime,
    suspended: { type: "boolean" },
    attribution: nullableText,
  }),
  resultSchema: object({
    banked: { type: "integer", minimum: 0, maximum: 1000000 },
    endReason: { enum: ["top", "wrong", "walked", "ended_early"] },
    winners: ids,
    highestRung: { type: "integer", minimum: 0, maximum: 15 },
    endedBy: nullableText,
    attribution: text(500),
  }),
  resourceSchemas: {
    import: goldenLadderBankSchema,
    data: goldenLadderBankSchema,
    facts: object({}),
    metadata: object({
      title: text(120),
      questionCount: { type: "integer", minimum: 1, maximum: 1000 },
      rights: object({
        license: { const: "CC0-1.0", type: "string" },
        sourceUrl: { type: "null" },
        attribution: text(500),
        permissionNote: { type: "null" },
      }),
    }),
  },
  client: { entry: "./client.js", css: [] },
};
