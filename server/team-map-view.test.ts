import { describe, expect, it } from "vitest";
import { teamMapFor, type TeamMapSources } from "./team-map-view.ts";

const sources: TeamMapSources = {
  visibleBotIds: new Set(["chief", "writer", "coder"]),
  directRooms: [
    { groupId: "dm-alice", threadId: "t-dm-alice", botIds: ["chief", "writer"], lastAt: 2 },
    { groupId: "dm-bob", threadId: "t-dm-bob", botIds: ["chief", "coder"], lastAt: 3 },
  ],
  queued: [
    { sourceThreadId: "t-alice", sourceBotId: "chief", toBotId: "writer", reason: "Draft Alice's offer letter" },
    { sourceThreadId: "t-bob", sourceBotId: "chief", toBotId: "coder", reason: "Fix Bob's payroll script" },
    { sourceThreadId: "t-room", sourceBotId: "chief", toBotId: "coder", reason: "Team standup notes", targetThreadId: "t-bob-exec" },
  ],
  running: [
    { threadId: "t-alice-exec", toBotId: "writer", sourceBotId: "chief", sourceThreadId: "t-alice" },
    { threadId: "t-bob-exec", toBotId: "coder", sourceBotId: "chief", sourceThreadId: "t-bob", groupId: "dm-bob" },
  ],
};
const aliceCanSee = (threadId: string) => ["t-alice", "t-alice-exec", "t-dm-alice", "t-room"].includes(threadId);

describe("the Team Map for one viewer", () => {
  it("shows everything to the operator and on a single-user install", () => {
    const all = teamMapFor(sources, () => true);
    expect(all.collaborations.map((item) => item.groupId)).toEqual(["dm-bob", "dm-alice"]);
    expect(all.queued.map((item) => item.reason)).toEqual(["Draft Alice's offer letter", "Fix Bob's payroll script", "Team standup notes"]);
    expect(all.running).toHaveLength(2);
  });

  it("leaves out every label, edge and room that came from a conversation the member can't open", () => {
    const alice = teamMapFor(sources, aliceCanSee);
    expect(alice.collaborations.map((item) => item.groupId)).toEqual(["dm-alice"]);
    expect(alice.queued).toEqual([{ sourceBotId: "chief", targetBotId: "writer", reason: "Draft Alice's offer letter" }]);
    expect(alice.running).toEqual([{ sourceBotId: "chief", targetBotId: "writer", threadId: "t-alice-exec" }]);
    const text = JSON.stringify(alice);
    for (const secret of ["payroll", "t-bob", "dm-bob", "standup"]) expect(text).not.toContain(secret);
  });

  it("fails closed when a viewer can see nothing", () => {
    expect(teamMapFor(sources, () => false)).toEqual({ collaborations: [], queued: [], running: [] });
  });
});
