// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ResourceImportError } from "@next-round/game-sdk";
import { parseGoldenLadderImport } from "./content.js";
import type { GoldenLadderBank, GoldenLadderQuestion } from "./types.js";

const question = (patch: Partial<GoldenLadderQuestion> = {}): GoldenLadderQuestion => ({
  id: "q1",
  rung: 3,
  prompt: "Fixture prompt?",
  choices: ["A", "B", "C", "D"],
  correctChoice: 2,
  explanation: "Fixture explanation",
  ...patch,
});

const bank: GoldenLadderBank = {
  format: "next-round.golden-ladder/1",
  title: "Private bank",
  attribution: "Original test fixture",
  license: "CC0-1.0",
  questions: [question()],
};

describe("golden ladder import identity and privacy", () => {
  it("pins every content/rights field independent of JSON property ordering", () => {
    const original = parseGoldenLadderImport(bank);
    expect(
      parseGoldenLadderImport({
        questions: bank.questions,
        license: bank.license,
        attribution: bank.attribution,
        title: bank.title,
        format: bank.format,
      }).identity,
    ).toBe(original.identity);
    for (const change of [
      { ...bank, title: "Different title" },
      { ...bank, attribution: "Other author" },
      ...["prompt", "explanation", "id"].map((field) => ({
        ...bank,
        questions: [{ ...bank.questions[0], [field]: "Changed" }],
      })),
      { ...bank, questions: [{ ...bank.questions[0], rung: 4 }] },
      { ...bank, questions: [{ ...bank.questions[0], choices: ["D", "C", "B", "A"] }] },
      { ...bank, questions: [{ ...bank.questions[0], correctChoice: 0 }] },
    ])
      expect(parseGoldenLadderImport(change).identity).not.toBe(
        original.identity,
      );
    expect(original.metadata).toEqual({
      title: bank.title,
      questionCount: 1,
      rights: {
        license: "CC0-1.0",
        sourceUrl: null,
        attribution: bank.attribution,
        permissionNote: null,
      },
    });
  });

  it("rejects malformed banks without exposing submitted secrets", () => {
    for (const invalid of [
      null,
      { ...bank, questions: [null] },
      { ...bank, questions: [bank.questions[0], bank.questions[0]] }, // dup id
      { ...bank, questions: [question({ correctChoice: 4 })] },
      { ...bank, questions: [question({ choices: ["A", "B", "C"] })] }, // 3 choices
      { ...bank, questions: [question({ choices: ["A", "B", "C", "D", "E"] })] },
      { ...bank, questions: [question({ choices: ["A", "A", "C", "D"] })] },
      { ...bank, questions: [question({ rung: 0 })] },
      { ...bank, questions: [question({ rung: 16 })] },
      { ...bank, license: "unreviewed-secret" },
      { ...bank, hidden: "unreviewed-secret" },
    ]) {
      expect(() => parseGoldenLadderImport(invalid)).toThrow(
        ResourceImportError,
      );
      try {
        parseGoldenLadderImport(invalid);
      } catch (error) {
        expect(JSON.stringify(error)).not.toContain("unreviewed-secret");
        expect(JSON.stringify(error)).not.toContain("Fixture explanation");
      }
    }
  });
});

describe("shipped test-fixture bank", () => {
  it("imports cleanly with at least two questions at every rung", () => {
    const raw = JSON.parse(
      readFileSync(
        new URL("../content/fixture.json", import.meta.url),
        "utf8",
      ),
    ) as GoldenLadderBank;
    const result = parseGoldenLadderImport(raw);
    expect(result.metadata).toMatchObject({ questionCount: 30 });
    for (let rung = 1; rung <= 15; rung++) {
      expect(
        raw.questions.filter((q) => q.rung === rung).length,
      ).toBeGreaterThanOrEqual(2);
    }
    expect(raw.title).toContain("Test Fixture");
  });
});
