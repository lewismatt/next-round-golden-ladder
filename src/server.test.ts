// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { parseJsonSchemaValue } from "@next-round/contracts";
import type {
  GameEvent,
  Member,
  RuleContext,
  Transition,
} from "@next-round/game-sdk";
import { manifest } from "./manifest.js";
import { havenFloor, rungValue, server } from "./server.js";
import type {
  GoldenLadderBank,
  GoldenLadderSettings,
  GoldenLadderState,
} from "./types.js";

const member = (id: string): Member => ({
  id,
  principalId: `principal-${id}`,
  kind: "registered",
  displayName: id,
  status: "active",
  joinOrdinal: Number(id.slice(1)),
  disabled: false,
  accessEpoch: 1,
});

/** Two questions per rung; the correct index rotates so tests cannot
 * accidentally pass by always picking the same slot. */
function makeBank(): GoldenLadderBank {
  const questions: GoldenLadderBank["questions"] = [];
  const names = ["Alpha", "Beta", "Gamma", "Delta"];
  for (let rung = 1; rung <= 15; rung++) {
    for (const variant of [0, 1]) {
      const correctChoice = (rung + variant * 2) % 4;
      questions.push({
        id: `r${rung}-${variant === 0 ? "a" : "b"}`,
        rung,
        prompt: `Fixture rung ${rung} question ${variant === 0 ? "A" : "B"}`,
        choices: names.map((n) => `${n} ${rung}${variant}`),
        correctChoice,
        explanation: `Fixture explanation ${rung}${variant}`,
      });
    }
  }
  return {
    format: "next-round.golden-ladder/1",
    title: "Fixture bank",
    attribution: "Fixture author",
    license: "CC0-1.0",
    questions,
  };
}

const bank = makeBank();
const questionOf = (state: GoldenLadderState) =>
  bank.questions.find((q) => q.id === state.currentQuestionId)!;
const correctChoice = (state: GoldenLadderState) =>
  questionOf(state).correctChoice;
const wrongChoice = (state: GoldenLadderState) =>
  [0, 1, 2, 3].find(
    (c) => c !== correctChoice(state) && !state.fiftyRemoved.includes(c),
  )!;

function fixture(
  settings: GoldenLadderSettings = { turnSeconds: null },
  mode: "group" | "solo" = "group",
  memberIds: string[] = mode === "solo" ? ["m1"] : ["m1", "m2"],
  resource: RuleContext["resource"] = {
    id: "resource",
    identity: "identity",
    version: 1,
    data: bank,
  },
) {
  let ctx: RuleContext = {
    matchId: "match-golden-ladder",
    moduleVersion: "0.1.0",
    mode,
    phase: null,
    revision: 0,
    now: "2026-10-25T00:00:00.000Z",
    eventId: "event-create",
    actor: { principalId: "principal-m1", memberId: "m1" },
    members: memberIds.map(member),
    hostMemberId: "m1",
    settings: { ...settings },
    resource,
    facts: [],
  };
  let state: GoldenLadderState | null = null;
  function step(event: GameEvent): Transition<GoldenLadderState> {
    const result = server.transition(ctx, state, event);
    if (!result.ok) throw new Error(result.error.code);
    parseJsonSchemaValue(manifest.stateSchema, result.value.state);
    if (result.value.final)
      parseJsonSchemaValue(manifest.resultSchema, result.value.final.data);
    state = result.value.state;
    ctx = {
      ...ctx,
      phase: result.value.phase,
      hostMemberId: result.value.hostMemberId,
      revision: ctx.revision + 1,
    };
    return result.value;
  }
  step({ kind: "create" });
  return {
    get ctx() {
      return ctx;
    },
    get state() {
      return state!;
    },
    step,
    patch(values: Partial<RuleContext>) {
      ctx = { ...ctx, ...values };
    },
    actor(id: string) {
      ctx = { ...ctx, actor: { memberId: id, principalId: `principal-${id}` } };
    },
    status(id: string, disabled: boolean) {
      ctx = {
        ...ctx,
        members: ctx.members.map((m) => (m.id === id ? { ...m, disabled } : m)),
      };
      return step({ kind: "principal_status", memberId: id, disabled });
    },
    view(id: string) {
      const view = server.view(ctx, state!, {
        memberId: id,
        principalId: `principal-${id}`,
        access: "active",
      });
      parseJsonSchemaValue(manifest.viewSchema, view);
      return view;
    },
    act(
      id: string,
      type: string,
      payload: Record<string, number | string | boolean> = {},
    ) {
      this.actor(id);
      return step({ kind: "action", type, payload });
    },
    answerCorrect() {
      return this.act(this.state.currentMemberId!, "answer", {
        choice: correctChoice(this.state),
      });
    },
    answerWrong() {
      return this.act(this.state.currentMemberId!, "answer", {
        choice: wrongChoice(this.state),
      });
    },
    raw(event: GameEvent) {
      return server.transition(ctx, state, event);
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

/** Play correctly until `rung` is the live rung. */
function climbTo(f: Fixture, rung: number) {
  while (f.state.currentRung < rung) f.answerCorrect();
}

describe("golden ladder values", () => {
  it("pins the ladder and haven floors", () => {
    expect(rungValue(0)).toBe(0);
    expect(rungValue(1)).toBe(100);
    expect(rungValue(5)).toBe(1000);
    expect(rungValue(10)).toBe(32000);
    expect(rungValue(15)).toBe(1000000);
    expect(havenFloor(0)).toBe(0);
    expect(havenFloor(4)).toBe(0);
    expect(havenFloor(5)).toBe(1000);
    expect(havenFloor(9)).toBe(1000);
    expect(havenFloor(10)).toBe(32000);
    expect(havenFloor(15)).toBe(32000);
  });
});

describe("golden ladder match flow", () => {
  it("runs a full winning climb with strict rotation and shared scoring", () => {
    const f = fixture();
    const start = f.step({ kind: "start" });
    expect(start.needsActionFrom).toEqual(["m1"]);
    for (let rung = 1; rung <= 15; rung++) {
      expect(f.state.currentRung).toBe(rung);
      expect(f.state.currentMemberId).toBe(rung % 2 === 1 ? "m1" : "m2");
      f.answerCorrect();
    }
    const finalState = f.state;
    expect(finalState.endReason).toBe("top");
    expect(finalState.lastCorrectRung).toBe(15);
    // The final transition is observed through a host view + career.
    const view = f.view("m1");
    expect(view.phase).toBe("finished");
    expect(view.banked).toBe(1000000);
    expect(view.history).toHaveLength(15);
    expect(view.history.every((r) => r.correct)).toBe(true);

    const g = fixture();
    g.step({ kind: "start" });
    let last: Transition<GoldenLadderState> | null = null;
    for (let rung = 1; rung <= 15; rung++) last = g.answerCorrect();
    const final = last!.final!;
    expect(final.outcome).toBe("completed");
    expect(final.data).toMatchObject({
      banked: 1000000,
      endReason: "top",
      winners: ["m1", "m2"],
      highestRung: 15,
    });
    expect(final.participants).toEqual([
      expect.objectContaining({
        memberId: "m1",
        score: 1000000,
        win: true,
        careerEligible: true,
        contribution: expect.objectContaining({
          rungsAnswered: 8,
          correctAnswers: 8,
          endedRun: false,
        }),
      }),
      expect.objectContaining({
        memberId: "m2",
        score: 1000000,
        win: true,
        contribution: expect.objectContaining({
          rungsAnswered: 7,
          correctAnswers: 7,
        }),
      }),
    ]);
    expect(server.career(final)).toEqual([
      { memberId: "m1", points: 1000000, played: 1, wins: 1 },
      { memberId: "m2", points: 1000000, played: 1, wins: 1 },
    ]);
  });

  it("banks the right haven when a wrong answer ends the run", () => {
    const cases: Array<{ wrongAt: number; banked: number }> = [
      { wrongAt: 1, banked: 0 },
      { wrongAt: 3, banked: 0 },
      { wrongAt: 5, banked: 0 }, // haven not yet passed: last correct is 4
      { wrongAt: 7, banked: 1000 },
      { wrongAt: 10, banked: 1000 }, // last correct is 9
      { wrongAt: 12, banked: 32000 },
      { wrongAt: 15, banked: 32000 },
    ];
    for (const { wrongAt, banked: expected } of cases) {
      const f = fixture();
      f.step({ kind: "start" });
      climbTo(f, wrongAt);
      const final = f.answerWrong().final!;
      expect(final.outcome).toBe("completed");
      expect(final.data).toMatchObject({
        banked: expected,
        endReason: "wrong",
        winners: [],
        highestRung: wrongAt - 1,
      });
      expect(f.view("m1").banked).toBe(expected);
      // The missed question is revealed in history with its explanation.
      const miss = f.state.history[f.state.history.length - 1];
      expect(miss.rung).toBe(wrongAt);
      expect(miss.correct).toBe(false);
      expect(miss.explanation).toContain("Fixture explanation");
      // Whoever missed is marked as having ended the run; everyone shares
      // the banked score, nobody wins.
      const misser = final.participants.find(
        (p) =>
          (p.contribution as Record<string, unknown>).endedRun === true,
      );
      expect(misser).toBeDefined();
      expect(
        final.participants.every((p) => p.score === expected && !p.win),
      ).toBe(true);
    }
  });

  it("walk away banks the last correct rung value, and only the answerer may call it", () => {
    // At rung 1 nothing is secured yet.
    const early = fixture();
    early.step({ kind: "start" });
    expect(early.act("m1", "walk_away").final!.data).toMatchObject({
      banked: 0,
      endReason: "walked",
      endedBy: "m1",
    });
    // At rung 8 (7 correct) walking banks rung 7's 4,000 — not the 1,000
    // haven floor a wrong answer would give.
    const f = fixture();
    f.step({ kind: "start" });
    climbTo(f, 8);
    expect(f.state.currentMemberId).toBe("m2");
    expect(
      f.raw({
        kind: "action",
        type: "walk_away",
        payload: {},
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_YOUR_TURN" } });
    const final = f.act("m2", "walk_away").final!;
    expect(final.data).toMatchObject({
      banked: 4000,
      endReason: "walked",
      endedBy: "m2",
      highestRung: 7,
    });
    expect(final.participants.every((p) => p.score === 4000)).toBe(true);
  });

  it("fifty-fifty is deterministic, removes only wrong choices, and a removed choice cannot be answered", () => {
    const f = fixture();
    f.step({ kind: "start" });
    f.act("m1", "fifty_fifty");
    const removed = f.state.fiftyRemoved;
    expect(removed).toHaveLength(2);
    expect(removed).not.toContain(correctChoice(f.state));
    // Deterministic: a fresh match with the same seed draws and removes
    // identically.
    const g = fixture();
    g.step({ kind: "start" });
    expect(g.state.currentQuestionId).toBe(f.state.drawIds[0]);
    g.act("m1", "fifty_fifty");
    expect(g.state.fiftyRemoved).toEqual(removed);
    // Answering a removed choice is rejected without consuming the turn.
    expect(
      f.raw({
        kind: "action",
        type: "answer",
        payload: { choice: removed[0] },
      }),
    ).toMatchObject({ ok: false, error: { code: "REMOVED_CHOICE" } });
    expect(f.state.currentMemberId).toBe("m1");
    expect(f.state.history).toEqual([]);
    // The lifeline is spent for the whole team, not per player.
    expect(
      f.raw({
        kind: "action",
        type: "fifty_fifty",
        payload: {},
      }),
    ).toMatchObject({ ok: false, error: { code: "LIFELINE_SPENT" } });
    // The surviving correct choice still answers fine.
    f.answerCorrect();
    expect(f.state.currentRung).toBe(2);
    expect(f.state.fiftyRemoved).toEqual([]);
  });

  it("tag in hands the rung to the next teammate and rotation continues from them", () => {
    const f = fixture({ turnSeconds: null }, "group", ["m1", "m2", "m3"]);
    f.step({ kind: "start" });
    expect(f.state.currentMemberId).toBe("m1");
    f.act("m1", "tag_in");
    expect(f.state.currentMemberId).toBe("m2");
    expect(f.state.lifelinesUsed.tagIn).toBe(true);
    // m2 answers rung 1; rung 2 belongs to the player after m2 (m3), not
    // to the player who would have had it without the tag (m2).
    f.answerCorrect();
    expect(f.state.currentRung).toBe(2);
    expect(f.state.currentMemberId).toBe("m3");
    // Tag In is once per match, shared. (Attempted here by the current
    // answerer, m3 — anyone else is refused at the turn gate first.)
    f.actor("m3");
    expect(
      f.raw({ kind: "action", type: "tag_in", payload: {} }),
    ).toMatchObject({ ok: false, error: { code: "LIFELINE_SPENT" } });
    // Contribution records who used the lifeline.
    const final = f.act("m3", "walk_away").final!;
    expect(final.participants[0].contribution).toMatchObject({
      lifelinesUsed: 1,
    });
  });

  it("tag in is unavailable in solo", () => {
    const f = fixture({ turnSeconds: null }, "solo");
    f.step({ kind: "start" });
    expect(
      f.raw({ kind: "action", type: "tag_in", payload: {} }),
    ).toMatchObject({ ok: false, error: { code: "TAG_IN_UNAVAILABLE" } });
    expect(f.state.currentMemberId).toBe("m1");
    expect(f.state.lifelinesUsed.tagIn).toBe(false);
  });

  it("swap replaces the question at the same rung, keeps a spent fifty spent, and cannot be reused", () => {
    const f = fixture();
    f.step({ kind: "start" });
    const before = f.state.currentQuestionId;
    f.act("m1", "fifty_fifty");
    expect(f.state.fiftyRemoved).toHaveLength(2);
    f.act("m1", "swap");
    const swapped = questionOf(f.state);
    expect(f.state.currentQuestionId).not.toBe(before);
    expect(swapped.rung).toBe(1);
    // The replacement starts whole; fifty stays spent.
    expect(f.state.fiftyRemoved).toEqual([]);
    expect(f.state.lifelinesUsed).toMatchObject({
      fiftyFifty: true,
      swap: true,
    });
    expect(f.view("m1").swapAvailable).toBe(false);
    // A second swap is refused (lifeline spent; the spare is consumed too).
    expect(
      f.raw({ kind: "action", type: "swap", payload: {} }),
    ).toMatchObject({ ok: false, error: { code: "LIFELINE_SPENT" } });
    expect(f.state.spareIds[0]).toBeNull();
    // The swapped-in question answers normally.
    f.answerCorrect();
    expect(f.state.currentRung).toBe(2);
  });

  it("a missed deadline passes the rung to the next player with the same question", () => {
    const f = fixture({ turnSeconds: 60 });
    const start = f.step({ kind: "start" });
    const questionId = f.state.currentQuestionId;
    f.patch({ now: start.deadlines[0].dueAt });
    const passed = f.step({
      kind: "deadline",
      deadline: start.deadlines[0],
    });
    expect(passed.state.currentRung).toBe(1);
    expect(passed.state.currentQuestionId).toBe(questionId);
    expect(passed.state.history).toEqual([]);
    expect(passed.needsActionFrom).toEqual(["m2"]);
    expect(passed.deadlines[0].generation).toBe(2);
    // And it can pass again, wrapping back to m1 — no penalty either time.
    f.patch({ now: passed.deadlines[0].dueAt });
    const again = f.step({
      kind: "deadline",
      deadline: passed.deadlines[0],
    });
    expect(again.needsActionFrom).toEqual(["m1"]);
    expect(again.state.currentRung).toBe(1);
  });

  it("a missed deadline in solo renews the same player's deadline", () => {
    const f = fixture({ turnSeconds: 60 }, "solo");
    const start = f.step({ kind: "start" });
    f.patch({ now: start.deadlines[0].dueAt });
    const renewed = f.step({
      kind: "deadline",
      deadline: start.deadlines[0],
    });
    expect(renewed.needsActionFrom).toEqual(["m1"]);
    expect(renewed.state.currentRung).toBe(1);
    expect(renewed.deadlines[0].generation).toBe(2);
    expect(renewed.deadlines[0].dueAt).toBe("2026-10-25T00:02:00.000Z");
  });

  it("rejects invalid actions without consuming the turn", () => {
    const f = fixture({ turnSeconds: 60 });
    f.step({ kind: "start" });
    const before = JSON.stringify(f.state);
    // Wrong player.
    f.actor("m2");
    expect(
      f.raw({
        kind: "action",
        type: "answer",
        payload: { choice: correctChoice(f.state) },
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_YOUR_TURN" } });
    f.actor("m1");
    // Out-of-range and non-integer choices.
    for (const choice of [-1, 4, 1.5, "1", null]) {
      expect(
        f.raw({
          kind: "action",
          type: "answer",
          payload: { choice },
        }),
      ).toMatchObject({ ok: false, error: { code: "INVALID_CHOICE" } });
    }
    // Unknown action type.
    expect(
      f.raw({ kind: "action", type: "dance", payload: {} }),
    ).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_ACTION" } });
    // Answering after the deadline has passed.
    f.patch({ now: "2026-10-25T00:01:00.000Z" });
    expect(
      f.raw({
        kind: "action",
        type: "answer",
        payload: { choice: correctChoice(f.state) },
      }),
    ).toMatchObject({ ok: false, error: { code: "TURN_CLOSED" } });
    expect(JSON.stringify(f.state)).toBe(before);
    expect(f.view("m1").canAct).toBe(true);
  });

  it("never leaks the live question's correct answer into a view", () => {
    const f = fixture();
    f.step({ kind: "start" });
    climbTo(f, 4);
    for (const viewer of ["m1", "m2"]) {
      const view = f.view(viewer);
      expect(view.question).not.toBeNull();
      expect(view.question).toEqual({
        id: f.state.currentQuestionId,
        prompt: questionOf(f.state).prompt,
        choices: questionOf(f.state).choices,
      });
      expect(JSON.stringify(view.question)).not.toContain("correctChoice");
      expect(JSON.stringify(view)).not.toContain(
        questionOf(f.state).explanation,
      );
      // Resolved rungs are fully revealed in history — that is allowed.
      expect(view.history).toHaveLength(3);
      expect(view.history[0].correctChoice).toBeDefined();
    }
    expect(f.view("m1").canAct).toBe(false); // rung 4 belongs to m2
    expect(f.view("m2").canAct).toBe(true);
  });

  it("suspends when nobody enabled can act and resumes with time preserved", () => {
    const f = fixture({ turnSeconds: 100 });
    const start = f.step({ kind: "start" });
    f.patch({ now: "2026-10-25T00:00:40.000Z" });
    expect(f.status("m2", true).deadlines).toEqual(start.deadlines);
    const paused = f.status("m1", true);
    expect(paused.state).toMatchObject({
      suspended: true,
      suspendedRemainingMs: 60000,
    });
    expect(paused.deadlines).toEqual([]);
    f.patch({ now: "2026-10-25T00:10:00.000Z" });
    const resumed = f.status("m2", false);
    expect(resumed.state.suspended).toBe(false);
    expect(resumed.deadlines).toEqual([
      { key: "turn", generation: 2, dueAt: "2026-10-25T00:11:00.000Z" },
    ]);
    expect(resumed.needsActionFrom).toEqual(["m2"]);
  });

  it("host finish ends early with score 0 and no career credit", () => {
    const f = fixture();
    f.step({ kind: "start" });
    f.answerCorrect();
    const final = f.step({ kind: "finish", reason: "host_ended" }).final!;
    expect(final.outcome).toBe("ended_early");
    expect(final.data).toMatchObject({ banked: 0, endReason: "ended_early" });
    expect(
      final.participants.every(
        (p) => p.score === 0 && !p.careerEligible && !p.win,
      ),
    ).toBe(true);
    expect(server.career(final)).toEqual([]);
    // A non-host cannot finish.
    const g = fixture();
    g.step({ kind: "start" });
    g.actor("m2");
    expect(g.raw({ kind: "finish", reason: "host_ended" })).toMatchObject({
      ok: false,
      error: { code: "CANNOT_FINISH" },
    });
  });

  it("refuses invalid settings and insufficient banks at create", () => {
    const base = fixture().ctx;
    const noResource = server.transition(
      { ...base, phase: null, resource: null },
      null,
      { kind: "create" },
    );
    expect(noResource).toMatchObject({
      ok: false,
      error: { code: "RESOURCE_REQUIRED" },
    });
    const badTimer = server.transition(
      { ...base, phase: null, settings: { turnSeconds: 10 } },
      null,
      { kind: "create" },
    );
    expect(badTimer).toMatchObject({
      ok: false,
      error: { code: "INVALID_SETTINGS" },
    });
    const thinBank: GoldenLadderBank = {
      ...bank,
      questions: bank.questions.filter((q) => q.id !== "r7-b"),
    };
    const thin = server.transition(
      {
        ...base,
        phase: null,
        resource: { id: "r", identity: "i", version: 1, data: thinBank },
      },
      null,
      { kind: "create" },
    );
    expect(thin).toMatchObject({
      ok: false,
      error: { code: "RESOURCE_INSUFFICIENT" },
    });
  });
});
