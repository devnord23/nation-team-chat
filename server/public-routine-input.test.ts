import { expect, it } from "vitest";
import { publicRoutineInput } from "./public-routine-input.ts";
it("maps the public destination without changing existing stored records", () => {
  const input = { runOn: "nation", prompt: "keep this", schedule: { type: "once", at: 1 } };
  expect(publicRoutineInput(input)).toEqual({ ...input, runOn: "maus" });
  expect(input.runOn).toBe("nation");
  for (const runOn of ["maus", "cloud", "invalid"]) expect(publicRoutineInput({ runOn })).toEqual({ runOn });
  expect(publicRoutineInput(null)).toBeNull();
});
