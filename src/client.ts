// SPDX-License-Identifier: Apache-2.0
import {
  defineGameClient,
  type GameBridge,
  type GameMountResult,
} from "@next-round/game-client";
import type { GoldenLadderView, LadderReveal } from "./types.js";

type Intent = {
  type: string;
  payload: Record<string, never> | { choice: number };
  stamp: string;
  label: string;
  commandId: string;
  expectedRevision: number;
  stale: boolean;
};

/** A fingerprint of everything an action could change; if it moves, the
 * action landed. */
function stamp(game: GoldenLadderView): string {
  return JSON.stringify([
    game.phase,
    game.currentRung,
    game.currentMemberId,
    game.question?.id ?? null,
    game.history.length,
    game.lifelinesUsed,
    game.removedChoices,
  ]);
}

export function mount(
  element: HTMLElement,
  bridge: GameBridge<GoldenLadderView>,
): GameMountResult {
  const root = document.createElement("section");
  root.className = "card next-round-golden-ladder-game";
  root.setAttribute("aria-label", "Golden Ladder game");
  element.append(root);
  let snapshot = bridge.getSnapshot();
  let pending: Intent | null = null;
  let acting = false;
  let mounted = true;
  let message = "";
  let isError = false;
  let clockReceived = performance.now();
  let clockServer = Date.parse(snapshot.serverNow);
  let countdown: HTMLElement | null = null;

  function add<K extends keyof HTMLElementTagNameMap>(
    parent: HTMLElement,
    tag: K,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    parent.append(node);
    return node;
  }
  function tick() {
    if (!countdown) return;
    const game = snapshot.game;
    if (game.suspended)
      countdown.textContent = "Paused — waiting for an enabled player";
    else if (!game.dueAt) countdown.textContent = "";
    else {
      const seconds = Math.max(
        0,
        Math.ceil(
          (Date.parse(game.dueAt) -
            clockServer -
            (performance.now() - clockReceived)) /
            1000,
        ),
      );
      countdown.textContent = seconds
        ? `Turn ends in ${seconds}s`
        : "Waiting for the turn to pass…";
    }
  }
  function button(
    parent: HTMLElement,
    text: string,
    action: () => void,
    disabled = false,
  ) {
    const node = add(parent, "button", text);
    node.type = "button";
    node.className = "button";
    node.disabled = disabled;
    node.addEventListener("click", action);
    return node;
  }
  function nameOf(memberId: string | null): string {
    if (!memberId) return "Another player";
    return (
      snapshot.members.find((m) => m.id === memberId)?.displayName ??
      "Former player"
    );
  }
  function historyRow(parent: HTMLElement, record: LadderReveal) {
    const item = add(parent, "li");
    const picked = record.choices[record.choice] ?? "?";
    const correctText = record.choices[record.correctChoice] ?? "?";
    add(
      item,
      "span",
      record.correct
        ? `Rung ${record.rung}: ${nameOf(record.answererMemberId)} answered "${picked}" — correct. ${record.explanation}`
        : `Rung ${record.rung}: ${nameOf(record.answererMemberId)} answered "${picked}" — wrong. The correct answer was "${correctText}". ${record.explanation}`,
    );
  }

  async function send(intent: Intent) {
    if (
      acting ||
      !mounted ||
      !snapshot.game.canAct ||
      stamp(snapshot.game) !== intent.stamp
    )
      return;
    if (intent.stale) {
      intent = {
        ...intent,
        stale: false,
        commandId: crypto.randomUUID(),
        expectedRevision: snapshot.revision,
      };
    }
    pending = intent;
    acting = true;
    message = "Submitting…";
    isError = false;
    render();
    try {
      await bridge.act({
        type: intent.type,
        payload: intent.payload,
        commandId: intent.commandId,
        expectedRevision: intent.expectedRevision,
      });
      if (!mounted) return;
      snapshot = bridge.getSnapshot();
      if (stamp(snapshot.game) !== intent.stamp) {
        message = `${intent.label} — recorded.`;
      }
      if (pending?.commandId === intent.commandId) pending = null;
    } catch (error: unknown) {
      if (!mounted) return;
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : null;
      try {
        snapshot = await bridge.refresh();
      } catch {
        /* Keep intent for explicit transport retry. */
      }
      if (!mounted) return;
      if (stamp(snapshot.game) !== intent.stamp) {
        pending = null;
        message = `${intent.label} — recorded.`;
        isError = false;
      } else if (!snapshot.game.canAct) {
        pending = null;
        message = "The turn moved on; your action was not replayed.";
        isError = false;
      } else if (code === "STALE_REVISION") {
        pending = { ...intent, stale: true };
        message =
          "The match changed. Review the question, then explicitly retry.";
        isError = true;
      } else if (
        code === "NETWORK_ERROR" ||
        code === null ||
        (typeof error === "object" &&
          error !== null &&
          "status" in error &&
          Number(error.status) >= 500)
      ) {
        pending = intent;
        message =
          "The result is unknown. Retry explicitly to check the same command; your action will not be replaced.";
        isError = true;
      } else {
        pending = null;
        message =
          error instanceof Error
            ? error.message
            : "Your action could not be submitted.";
        isError = true;
      }
    } finally {
      acting = false;
      if (mounted) render();
    }
  }

  function act(
    type: string,
    payload: Intent["payload"],
    label: string,
  ): void {
    void send({
      type,
      payload,
      label,
      stamp: stamp(snapshot.game),
      commandId: crypto.randomUUID(),
      expectedRevision: snapshot.revision,
      stale: false,
    });
  }

  function render() {
    if (!mounted) return;
    root.replaceChildren();
    const game = snapshot.game;
    add(root, "h2", "Golden Ladder");
    add(
      root,
      "p",
      game.phase === "lobby"
        ? "Waiting for the host to start"
        : game.phase === "finished"
          ? "Finished"
          : `Rung ${game.currentRung} of ${game.ladder.length} · ${game.securedPoints} pts secured`,
    );
    countdown = add(root, "p");
    countdown.className = "hint";
    tick();

    // The ladder, top rung first, havens and progress marked.
    add(root, "h3", "The ladder");
    const ladderList = add(root, "ol");
    for (let rung = game.ladder.length; rung >= 1; rung--) {
      const value = game.ladder[rung - 1];
      const haven = game.havenRungs.includes(rung) ? " · safe haven" : "";
      const climbed = rung <= game.lastCorrectRung ? " · climbed ✓" : "";
      const current =
        game.phase === "active" && rung === game.currentRung
          ? " · current rung"
          : "";
      const row = add(
        ladderList,
        "li",
        `Rung ${rung} — ${value.toLocaleString()} pts${haven}${climbed}${current}`,
      );
      if (game.phase === "active" && rung === game.currentRung)
        row.style.fontWeight = "bold";
    }
    add(
      root,
      "p",
      `Walk away now and bank ${game.securedPoints.toLocaleString()} pts · a wrong answer drops the team to the ${game.havenFloor.toLocaleString()} pt safe-haven floor.`,
    );

    if (game.phase === "active" && game.question) {
      const turnName = nameOf(game.currentMemberId);
      add(
        root,
        "p",
        game.canAct
          ? "Your rung — answer for the team."
          : `Waiting for ${turnName} to answer.`,
      );
      add(root, "h3", `Rung ${game.currentRung}`);
      add(root, "p", game.question.prompt);
      const choices = add(root, "div");
      game.question.choices.forEach((text, index) => {
        const removed = game.removedChoices.includes(index);
        const label = `${"ABCD"[index]}. ${text}${removed ? " (removed)" : ""}`;
        const node = button(
          choices,
          label,
          () => act("answer", { choice: index }, "Your answer"),
          acting || pending !== null || !game.canAct || removed,
        );
        if (removed) node.style.textDecoration = "line-through";
      });
      if (game.canAct) {
        const lifelines = add(root, "div");
        lifelines.className = "inline-actions";
        button(
          lifelines,
          "Fifty-Fifty",
          () => act("fifty_fifty", {}, "Fifty-Fifty"),
          acting ||
            pending !== null ||
            game.lifelinesUsed.fiftyFifty,
        );
        button(
          lifelines,
          "Tag In",
          () => act("tag_in", {}, "Tag In"),
          acting || pending !== null || !game.tagInAvailable,
        );
        button(
          lifelines,
          "Swap question",
          () => act("swap", {}, "Swap"),
          acting || pending !== null || !game.swapAvailable,
        );
        button(
          lifelines,
          "Walk away",
          () => act("walk_away", {}, "Walk away"),
          acting || pending !== null,
        );
        if (pending) {
          button(
            lifelines,
            "Retry",
            () => {
              if (pending) void send(pending);
            },
            acting,
          );
        }
      }
      const used = (Object.entries(game.lifelinesUsed) as [string, boolean][])
        .filter(([, spent]) => spent)
        .map(([id]) => id);
      add(
        root,
        "p",
        used.length
          ? `Lifelines spent: ${used.join(", ")}. Each lifeline is once per match for the whole team.`
          : "All three lifelines are available (once per match, shared by the team).",
      );
    }

    if (game.history.length) {
      add(root, "h3", "Run history");
      const list = add(root, "ol");
      for (const record of game.history) historyRow(list, record);
    }

    if (message) {
      const status = add(root, "p", message);
      status.className = isError ? "error-message" : "status-message";
      status.setAttribute("role", isError ? "alert" : "status");
    }

    if (game.phase === "finished") {
      add(root, "h3", "Result");
      const ending =
        game.endReason === "top"
          ? "Your team reached the top rung!"
          : game.endReason === "wrong"
            ? `A wrong answer by ${nameOf(game.endedByMemberId)} ended the run.`
            : game.endReason === "walked"
              ? `${nameOf(game.endedByMemberId)} walked away.`
              : "The host ended the match early.";
      add(root, "p", ending);
      add(
        root,
        "p",
        `Banked: ${(game.banked ?? 0).toLocaleString()} pts · highest rung climbed: ${game.lastCorrectRung}`,
      );
    }

    const controls = add(root, "div");
    controls.className = "inline-actions";
    button(controls, "Open match chat", () => bridge.openPanel("chat"));
    button(controls, "Open participants", () =>
      bridge.openPanel("participants"),
    );
  }

  const unsubscribe = bridge.subscribe((next) => {
    if (
      next.game.currentMemberId !== snapshot.game.currentMemberId ||
      next.game.currentRung !== snapshot.game.currentRung ||
      next.phase !== snapshot.phase
    ) {
      pending = null;
      message = "";
    }
    snapshot = next;
    clockServer = Date.parse(next.serverNow);
    clockReceived = performance.now();
    render();
  });
  const timer = window.setInterval(tick, 250);
  render();
  return {
    unmount() {
      mounted = false;
      unsubscribe();
      window.clearInterval(timer);
      root.remove();
    },
  };
}

export const client = defineGameClient<GoldenLadderView>({ mount });
