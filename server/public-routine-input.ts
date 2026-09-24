/** Canonical web destination; stored routines and older clients keep their existing format. */
export function publicRoutineInput(input: any): any {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return input.runOn === "nation" ? { ...input, runOn: "maus" } : input;
}
