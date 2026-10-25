// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only this module's tests: .core/ holds a pinned platform checkout
    // whose own suites are the platform's business, not this repo's.
    include: ["src/**/*.test.ts"],
  },
});
