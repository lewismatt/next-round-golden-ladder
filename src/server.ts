// SPDX-License-Identifier: Apache-2.0
import {
  defineGameServer,
  type FinalResult,
  type GameServer,
  type RuleContext,
  type Transition,
  type TransitionResult,
} from "@next-round/game-sdk";
import { parseGoldenLadderImport } from "./content.js";
import {
  HAVEN_RUNGS,
  LADDER,
  TOTAL_RUNGS,
  type EndReason,
  type GoldenLadderBank,
  type GoldenLadderQuestion,
  type GoldenLadderSettings,
  type GoldenLadderState,
  type GoldenLadderView,
  type LifelineId,
} from "./types.js";

const enabled = (ctx: RuleContext) =>
  ctx.members.filter((m) => m.status === "active" && !m.disabled);
const settings = (ctx: RuleContext) =>
  ctx.settings as unknown as GoldenLadderSettings;
const bank = (ctx: RuleContext) =>
  ctx.resource?.data as GoldenLadderBank | undefined;
const failure = (
  code: string,
  message: string,
): TransitionResult<GoldenLadderState> => ({
  ok: false,
  error: { code, message },
});

/** Points for a 1-based rung; rung 0 (nothing answered yet) is worth 0. */
export const rungValue = (rung: number): number =>
  rung >= 1 ? LADDER[rung - 1] : 0;

/** The safe-haven floor for a run whose last correct rung is given. */
export function havenFloor(lastCorrectRung: number): number {
  let floor = 0;
  for (const haven of HAVEN_RUNGS)
    if (lastCorrectRung >= haven) floor = rungValue(haven);
  return floor;
}

/** Final banked points for a finished run, from the way it ended. */
export function bankedFor(state: GoldenLadderState): number | null {
  switch (state.endReason) {
    case "top":
      return rungValue(TOTAL_RUNGS);
    case "wrong":
      return havenFloor(state.lastCorrectRung);
    case "walked":
      return rungValue(state.lastCorrectRung);
    case "ended_early":
      return 0;
    default:
      return null;
  }
}

/** Deterministic PRNG seeded from server-provided ids, in the same style
 * as Cipher's code generation: the seed inputs (match id + create event
 * id) are never projected into a client view, so the draw and the
 * Fifty-Fifty removals cannot be recomputed by a player. */
function seedRand(seedText: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) {
    h ^= seedText.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let seed = h >>> 0;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw one question plus one Swap spare per rung, deterministically from
 * the match seed. Candidate order is pinned by question id so the draw
 * does not depend on the bank's serialization order. */
function drawQuestions(
  ctx: RuleContext,
  content: GoldenLadderBank,
): { drawIds: string[]; spareIds: string[] } {
  const rand = seedRand(`${ctx.matchId}:${ctx.eventId}`);
  const drawIds: string[] = [];
  const spareIds: string[] = [];
  for (let rung = 1; rung <= TOTAL_RUNGS; rung++) {
    const pool = content.questions
      .filter((q) => q.rung === rung)
      .map((q) => q.id)
      .sort();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    drawIds.push(pool[0]);
    spareIds.push(pool[1]);
  }
  return { drawIds, spareIds };
}

/** The two wrong choices Fifty-Fifty removes for a question,
 * deterministically from the match seed and the question id. */
export function fiftyRemovedFor(
  ctx: RuleContext,
  question: GoldenLadderQuestion,
): number[] {
  const rand = seedRand(
    `${ctx.matchId}:${ctx.eventId}:fifty:${question.id}`,
  );
  const wrong = question.choices
    .map((_, index) => index)
    .filter((index) => index !== question.correctChoice);
  for (let i = wrong.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [wrong[i], wrong[j]] = [wrong[j], wrong[i]];
  }
  return wrong.slice(0, 2).sort((a, b) => a - b);
}

const questionById = (
  content: GoldenLadderBank,
  id: string,
): GoldenLadderQuestion =>
  content.questions.find((q) => q.id === id)!;

const eligible = (ctx: RuleContext, state: GoldenLadderState, memberId: string) =>
  state.playerOrder.includes(memberId) &&
  enabled(ctx).some((m) => m.id === memberId);
const anyEligible = (ctx: RuleContext, state: GoldenLadderState) =>
  state.playerOrder.some((id) => eligible(ctx, state, id));

function obligations(ctx: RuleContext, state: GoldenLadderState): string[] {
  if (ctx.phase !== "active" || state.suspended) return [];
  return state.currentMemberId &&
    eligible(ctx, state, state.currentMemberId)
    ? [state.currentMemberId]
    : [];
}

function transition(
  ctx: RuleContext,
  state: GoldenLadderState,
  phase = ctx.phase ?? "lobby",
  final: FinalResult | null = null,
): TransitionResult<GoldenLadderState> {
  const active = enabled(ctx);
  const host = active.some((m) => m.id === ctx.hostMemberId)
    ? ctx.hostMemberId
    : (active[0]?.id ?? ctx.hostMemberId);
  const value: Transition<GoldenLadderState> = {
    state,
    phase,
    hostMemberId: host,
    deadlines:
      phase === "active" && state.dueAt !== null && !state.suspended
        ? [{ key: "turn", generation: state.generation, dueAt: state.dueAt }]
        : [],
    needsActionFrom:
      phase === "active" ? obligations({ ...ctx, phase }, state) : [],
    facts: [],
    final,
  };
  return { ok: true, value };
}

/** Give the turn to `memberId` with a fresh deadline (or none, untimed). */
function grantTurn(
  ctx: RuleContext,
  state: GoldenLadderState,
  memberId: string,
): GoldenLadderState {
  const seconds = settings(ctx).turnSeconds;
  return {
    ...state,
    currentMemberId: memberId,
    generation: state.generation + 1,
    dueAt:
      seconds === null
        ? null
        : new Date(Date.parse(ctx.now) + seconds * 1000).toISOString(),
    suspended: false,
    suspendedRemainingMs: null,
  };
}

/** The next eligible player strictly after `fromId` in turn order, wrapping.
 * May return `fromId` itself when it is the only eligible player. */
function nextEligible(
  ctx: RuleContext,
  state: GoldenLadderState,
  fromId: string | null,
): string | null {
  const order = state.playerOrder;
  if (order.length === 0) return null;
  const start = fromId ? order.indexOf(fromId) : -1;
  for (let step = 1; step <= order.length; step++) {
    const candidate = order[(start + step) % order.length];
    if (eligible(ctx, state, candidate)) return candidate;
  }
  return null;
}

function suspend(ctx: RuleContext, state: GoldenLadderState): GoldenLadderState {
  const seconds = settings(ctx).turnSeconds;
  const remaining =
    state.dueAt !== null
      ? Math.max(0, Date.parse(state.dueAt) - Date.parse(ctx.now))
      : seconds === null
        ? null
        : seconds * 1000;
  return {
    ...state,
    suspended: true,
    suspendedRemainingMs: remaining,
    dueAt: null,
  };
}

/** Reconcile the answerer pointer with the current roster after membership
 * changes: resume from suspension, pass the pointer on from an ineligible
 * holder, or suspend when nobody can act. Same shape as Cipher's. */
function membership(
  ctx: RuleContext,
  state: GoldenLadderState,
): TransitionResult<GoldenLadderState> {
  if (ctx.phase !== "active") return transition(ctx, state);
  if (state.suspended) {
    if (!anyEligible(ctx, state)) return transition(ctx, state);
    const holder =
      state.currentMemberId &&
      eligible(ctx, state, state.currentMemberId)
        ? state.currentMemberId
        : nextEligible(ctx, state, state.currentMemberId);
    if (!holder) return transition(ctx, state);
    const seconds = settings(ctx).turnSeconds;
    const remainingMs =
      state.suspendedRemainingMs ?? (seconds === null ? 0 : seconds * 1000);
    return transition(ctx, {
      ...state,
      currentMemberId: holder,
      generation: state.generation + 1,
      dueAt:
        seconds === null
          ? null
          : new Date(Date.parse(ctx.now) + remainingMs).toISOString(),
      suspended: false,
      suspendedRemainingMs: null,
    });
  }
  if (
    state.currentMemberId &&
    eligible(ctx, state, state.currentMemberId)
  ) {
    return transition(ctx, state);
  }
  const next = nextEligible(ctx, state, state.currentMemberId);
  if (next) return transition(ctx, grantTurn(ctx, state, next));
  return transition(ctx, suspend(ctx, state));
}

/** Move on to the next rung after a correct answer: the pointer advances
 * by one from the player who just answered, and the next rung's drawn
 * question becomes live. */
function advanceRung(
  ctx: RuleContext,
  state: GoldenLadderState,
  answeredBy: string,
): TransitionResult<GoldenLadderState> {
  const advanced: GoldenLadderState = {
    ...state,
    currentRung: state.currentRung + 1,
    // drawIds is 0-based by rung: the next rung's id sits at the old index.
    currentQuestionId: state.drawIds[state.currentRung],
    fiftyRemoved: [],
  };
  const next = nextEligible(ctx, advanced, answeredBy);
  if (next) return transition(ctx, grantTurn(ctx, advanced, next));
  return transition(ctx, suspend(ctx, advanced));
}

function buildFinal(
  ctx: RuleContext,
  state: GoldenLadderState,
  outcome: "completed" | "ended_early",
  endReason: EndReason,
  endedByMemberId: string | null,
): FinalResult {
  const banked = bankedFor({ ...state, endReason }) ?? 0;
  const winners =
    outcome === "completed" && endReason === "top"
      ? [...state.playerOrder]
      : [];
  return {
    outcome,
    data: {
      banked: outcome === "completed" ? banked : 0,
      endReason,
      winners,
      highestRung: state.lastCorrectRung,
      endedBy: endedByMemberId,
      attribution: bank(ctx)!.attribution,
    },
    participants: ctx.members.map((m) => {
      const answered = state.history.filter(
        (r) => r.answererMemberId === m.id,
      );
      const exclusionReasons: string[] = [];
      if (ctx.mode === "solo") exclusionReasons.push("solo_mode");
      if (m.kind === "guest") exclusionReasons.push("guest_player");
      if (m.disabled) exclusionReasons.push("disabled_principal");
      if (outcome === "ended_early") exclusionReasons.push("ended_early");
      return {
        memberId: m.id,
        score: outcome === "completed" ? banked : 0,
        contribution: {
          rungsAnswered: answered.length,
          correctAnswers: answered.filter((r) => r.correct).length,
          lifelinesUsed: state.lifelineUses.filter(
            (u) => u.memberId === m.id,
          ).length,
          endedRun:
            endReason !== "ended_early" &&
            endedByMemberId !== null &&
            endedByMemberId === m.id,
        },
        win: outcome === "completed" && winners.includes(m.id),
        careerEligible: exclusionReasons.length === 0,
        exclusionReasons,
      };
    }),
  };
}

function finishRun(
  ctx: RuleContext,
  state: GoldenLadderState,
  endReason: EndReason,
  endedByMemberId: string | null,
): TransitionResult<GoldenLadderState> {
  const finished: GoldenLadderState = {
    ...state,
    endReason,
    endedByMemberId,
    dueAt: null,
    suspended: false,
    suspendedRemainingMs: null,
  };
  const final = buildFinal(ctx, finished, "completed", endReason, endedByMemberId);
  return transition(ctx, finished, "finished", final);
}

function finishEarly(
  ctx: RuleContext,
  state: GoldenLadderState,
): TransitionResult<GoldenLadderState> {
  const finished: GoldenLadderState = {
    ...state,
    endReason: "ended_early",
    endedByMemberId: null,
    dueAt: null,
    suspended: false,
    suspendedRemainingMs: null,
  };
  const final = buildFinal(ctx, finished, "ended_early", "ended_early", null);
  return transition(ctx, finished, "finished", final);
}

/** Record a lifeline use against the shared pool and the using player. */
function useLifeline(
  state: GoldenLadderState,
  lifeline: LifelineId,
  memberId: string,
): GoldenLadderState {
  return {
    ...state,
    lifelinesUsed: { ...state.lifelinesUsed, [lifeline]: true },
    lifelineUses: [...state.lifelineUses, { lifeline, memberId }],
  };
}

export const server: GameServer<
  GoldenLadderState,
  GoldenLadderView
> = defineGameServer<GoldenLadderState, GoldenLadderView>({
  importResource: parseGoldenLadderImport,
  authority(ctx, _state, memberId) {
    const members = enabled(ctx);
    const host =
      members.some((m) => m.id === memberId) && ctx.hostMemberId === memberId;
    return {
      canStart:
        host &&
        ctx.phase === "lobby" &&
        members.length >= (ctx.mode === "solo" ? 1 : 2),
      canFinish: host && ctx.phase === "active",
      removableMemberIds: host
        ? ctx.members
            .filter(
              (m) => m.id !== memberId && m.disabled && m.status === "active",
            )
            .map((m) => m.id)
        : [],
    };
  },
  transition(ctx, state, event) {
    if (event.kind === "create") {
      const s = settings(ctx);
      const content = bank(ctx);
      if (!content || content.format !== "next-round.golden-ladder/1")
        return failure(
          "RESOURCE_REQUIRED",
          "Choose a Golden Ladder question bank.",
        );
      if (
        !s ||
        !(
          s.turnSeconds === null ||
          (Number.isInteger(s.turnSeconds) &&
            s.turnSeconds >= 30 &&
            s.turnSeconds <= 604800)
        )
      ) {
        return failure(
          "INVALID_SETTINGS",
          "Choose a turn timer from 30 seconds to 7 days, or no timer.",
        );
      }
      for (let rung = 1; rung <= TOTAL_RUNGS; rung++) {
        if (
          content.questions.filter((q) => q.rung === rung).length < 2
        ) {
          return failure(
            "RESOURCE_INSUFFICIENT",
            "The question bank needs at least two questions at every rung (one to draw, one Swap spare).",
          );
        }
      }
      const { drawIds, spareIds } = drawQuestions(ctx, content);
      return transition(
        ctx,
        {
          drawIds,
          spareIds,
          currentQuestionId: drawIds[0],
          playerOrder: [],
          currentMemberId: null,
          currentRung: 1,
          lastCorrectRung: 0,
          lifelinesUsed: { fiftyFifty: false, tagIn: false, swap: false },
          lifelineUses: [],
          fiftyRemoved: [],
          history: [],
          endReason: null,
          endedByMemberId: null,
          generation: 0,
          dueAt: null,
          suspended: false,
          suspendedRemainingMs: null,
        },
        "lobby",
      );
    }
    if (!state)
      return failure("INVALID_STATE", "The match is not initialized.");
    if (event.kind === "join") {
      return membership(ctx, state);
    }
    if (event.kind === "leave" || event.kind === "principal_status") {
      return membership(ctx, state);
    }
    if (ctx.phase === "finished")
      return failure("MATCH_FINISHED", "The match has finished.");
    if (event.kind === "start") {
      if (
        !ctx.actor ||
        !this.authority(ctx, state, ctx.actor.memberId).canStart
      )
        return failure(
          "CANNOT_START",
          "The host needs enough enabled players to start.",
        );
      const order = enabled(ctx).map((m) => m.id);
      const started: GoldenLadderState = {
        ...state,
        playerOrder: order,
        currentMemberId: null,
        currentRung: 1,
        lastCorrectRung: 0,
        generation: 0,
        dueAt: null,
        suspended: false,
        suspendedRemainingMs: null,
      };
      return transition(ctx, grantTurn(ctx, started, order[0]), "active");
    }
    if (ctx.phase !== "active")
      return failure("MATCH_NOT_ACTIVE", "Start the match first.");
    if (event.kind === "finish") {
      if (
        !ctx.actor ||
        !this.authority(ctx, state, ctx.actor.memberId).canFinish
      )
        return failure(
          "CANNOT_FINISH",
          "Only the enabled host can end the match.",
        );
      return finishEarly(ctx, state);
    }
    if (event.kind === "action") {
      const known = [
        "answer",
        "fifty_fifty",
        "tag_in",
        "swap",
        "walk_away",
      ];
      if (!known.includes(event.type))
        return failure(
          "UNSUPPORTED_ACTION",
          "Golden Ladder takes answers, lifelines, and walk-aways only.",
        );
      const actor =
        ctx.actor && enabled(ctx).find((m) => m.id === ctx.actor!.memberId);
      if (!actor || state.suspended)
        return failure(
          "NOT_ELIGIBLE",
          "The match is paused or you are not an enabled player.",
        );
      if (state.currentMemberId !== actor.id)
        return failure(
          "NOT_YOUR_TURN",
          "Only the player this rung belongs to may act on it.",
        );
      if (
        state.dueAt !== null &&
        Date.parse(ctx.now) >= Date.parse(state.dueAt)
      )
        return failure("TURN_CLOSED", "The turn deadline has passed.");
      const content = bank(ctx)!;
      const question = questionById(content, state.currentQuestionId);

      if (event.type === "answer") {
        const payload = event.payload as { choice?: unknown } | null;
        const choice = payload?.choice;
        if (
          !Number.isInteger(choice) ||
          (choice as number) < 0 ||
          (choice as number) >= question.choices.length
        ) {
          return failure(
            "INVALID_CHOICE",
            "Choose one of the available answers.",
          );
        }
        if (state.fiftyRemoved.includes(choice as number)) {
          return failure(
            "REMOVED_CHOICE",
            "Fifty-Fifty removed that answer. Choose one of the answers still showing.",
          );
        }
        const correct = choice === question.correctChoice;
        const next: GoldenLadderState = {
          ...state,
          history: [
            ...state.history,
            {
              rung: state.currentRung,
              questionId: question.id,
              prompt: question.prompt,
              choices: [...question.choices],
              correctChoice: question.correctChoice,
              explanation: question.explanation,
              answererMemberId: actor.id,
              choice: choice as number,
              correct,
            },
          ],
          fiftyRemoved: [],
          lastCorrectRung: correct
            ? state.currentRung
            : state.lastCorrectRung,
        };
        // One wrong answer from anyone ends the run for the whole team.
        if (!correct) return finishRun(ctx, next, "wrong", actor.id);
        if (state.currentRung >= TOTAL_RUNGS)
          return finishRun(ctx, next, "top", null);
        return advanceRung(ctx, next, actor.id);
      }

      if (event.type === "walk_away") {
        // The answerer's call alone: bank the last correct rung's value.
        return finishRun(ctx, state, "walked", actor.id);
      }

      if (event.type === "fifty_fifty") {
        if (state.lifelinesUsed.fiftyFifty)
          return failure(
            "LIFELINE_SPENT",
            "Fifty-Fifty has already been used in this match.",
          );
        const next = useLifeline(state, "fiftyFifty", actor.id);
        return transition(ctx, {
          ...next,
          fiftyRemoved: fiftyRemovedFor(ctx, question),
        });
      }

      if (event.type === "tag_in") {
        if (state.lifelinesUsed.tagIn)
          return failure(
            "LIFELINE_SPENT",
            "Tag In has already been used in this match.",
          );
        if (ctx.mode === "solo" || state.playerOrder.length < 2)
          return failure(
            "TAG_IN_UNAVAILABLE",
            "Tag In needs a teammate to hand the rung to.",
          );
        const next = nextEligible(ctx, state, actor.id);
        if (!next || next === actor.id)
          return failure(
            "NO_TEAMMATE",
            "No enabled teammate can take this rung.",
          );
        // The tagged teammate becomes the answerer for this rung with a
        // fresh deadline, and rotation continues from them.
        const tagged = useLifeline(state, "tagIn", actor.id);
        return transition(ctx, grantTurn(ctx, tagged, next));
      }

      // event.type === "swap"
      if (state.lifelinesUsed.swap)
        return failure(
          "LIFELINE_SPENT",
          "Swap has already been used in this match.",
        );
      const spare = state.spareIds[state.currentRung - 1];
      if (!spare)
        return failure(
          "NO_SPARE",
          "There is no spare question left at this rung to swap in.",
        );
      const spareIds = [...state.spareIds];
      spareIds[state.currentRung - 1] = null;
      const swapped = useLifeline(state, "swap", actor.id);
      return transition(ctx, {
        ...swapped,
        spareIds,
        currentQuestionId: spare,
        // A Fifty-Fifty spent on the discarded question stays spent; the
        // replacement question starts with all four choices showing.
        fiftyRemoved: [],
      });
    }
    if (event.kind === "deadline") {
      const d = event.deadline;
      if (
        state.suspended ||
        d.key !== "turn" ||
        d.generation !== state.generation ||
        state.dueAt === null ||
        Date.parse(ctx.now) < Date.parse(d.dueAt)
      ) {
        return failure(
          "INVALID_DEADLINE",
          "The deadline is not active or due.",
        );
      }
      // A missed deadline passes the rung to the next player (Matthew's
      // amendment M1): same question, fresh deadline, no penalty. In solo
      // nextEligible returns the same player, renewing their deadline.
      const next = nextEligible(ctx, state, state.currentMemberId);
      if (!next) return transition(ctx, suspend(ctx, state));
      return transition(ctx, grantTurn(ctx, state, next));
    }
    return failure("UNSUPPORTED_EVENT", "This event is not supported.");
  },
  view(ctx, state, viewer) {
    const content = bank(ctx);
    const question =
      ctx.phase === "active" && content
        ? questionById(content, state.currentQuestionId)
        : undefined;
    const roster = state.playerOrder.length
      ? state.playerOrder
      : ctx.members.map((m) => m.id);
    const finished = ctx.phase === "finished";
    return {
      phase: ctx.phase ?? "lobby",
      ladder: [...LADDER],
      havenRungs: [...HAVEN_RUNGS],
      currentRung: state.currentRung,
      lastCorrectRung: state.lastCorrectRung,
      securedPoints: rungValue(state.lastCorrectRung),
      havenFloor: havenFloor(state.lastCorrectRung),
      // The live question is public to the team, but its correct answer
      // is never projected into a view before the rung resolves.
      question: question
        ? {
            id: question.id,
            prompt: question.prompt,
            choices: [...question.choices],
          }
        : null,
      removedChoices: [...state.fiftyRemoved],
      myMemberId: viewer.memberId,
      currentMemberId: state.currentMemberId,
      canAct:
        viewer.access === "active" &&
        viewer.memberId !== null &&
        obligations(ctx, state).includes(viewer.memberId),
      tagInAvailable:
        ctx.mode !== "solo" &&
        state.playerOrder.length > 1 &&
        !state.lifelinesUsed.tagIn,
      swapAvailable:
        state.spareIds[state.currentRung - 1] !== null &&
        !state.lifelinesUsed.swap,
      lifelinesUsed: { ...state.lifelinesUsed },
      players: roster.map((id) => {
        const answered = state.history.filter(
          (r) => r.answererMemberId === id,
        );
        return {
          memberId: id,
          answered: answered.length,
          correct: answered.filter((r) => r.correct).length,
        };
      }),
      history: state.history,
      endReason: state.endReason,
      banked: finished ? bankedFor(state) : null,
      endedByMemberId: state.endedByMemberId,
      dueAt: state.dueAt,
      suspended: state.suspended,
      attribution: content?.attribution ?? null,
    };
  },
  summary(ctx, state, principalId) {
    const member = ctx.members.find((m) => m.principalId === principalId);
    return {
      label: `Golden Ladder · rung ${state.currentRung}/${TOTAL_RUNGS} · ${rungValue(state.lastCorrectRung)} pts secured`,
      needsAction: member ? obligations(ctx, state).includes(member.id) : false,
      detail: state.suspended ? "Paused: no enabled players" : null,
    };
  },
  resultView(_ctx, result) {
    return {
      outcome: result.outcome,
      data: result.data,
      participants: result.participants.map((p) => ({
        memberId: p.memberId,
        score: p.score,
        win: p.win,
        careerEligible: p.careerEligible,
        exclusionReasons: [...p.exclusionReasons],
      })),
    };
  },
  career(result) {
    return result.participants
      .filter((p) => p.careerEligible)
      .map((p) => ({
        memberId: p.memberId,
        points: p.score,
        played: 1,
        wins: p.win ? 1 : 0,
      }));
  },
});
