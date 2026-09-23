// The approval box: what the bot wants to do, and three ways to answer.
//
// Deliberately not the lettered A/B/C list the onboarding card uses — an
// approval is a decision about one concrete action, so it shows the tool
// and the actual command/path in monospace, and the choices carry their
// own behavior instead of being matched by their label text.
import { Check, ShieldCheck, X } from "lucide-react";
import { type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t, tFromServer } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { SkillRequestPreview } from "@/components/SkillRequestPreview";

interface ToolLabels {
  [tool: string]: LocaleKey;
}

const ROUTINE_SETTLED_LABEL = {
  create: "approval.status.routineScheduled",
  update: "approval.status.routineUpdated",
  pause: "approval.status.routinePaused",
  resume: "approval.status.routineResumed",
  run_now: "approval.status.routineRunQueued",
  delete: "approval.status.routineDeleted",
} as const;

const SKILL_SETTLED_LABEL = {
  create: "approval.status.skillEnabled",
  update: "approval.status.skillUpdated",
} as const;

/** The tool's own name is noise to a human: mcp__ogb__computer_batch is
 * "computer batch", Bash is "run a command". */
export function toolLabel(tool?: string): string {
  if (!tool) return t("approval.tool.takeAction");
  const bare = tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
  const nice: ToolLabels = {
    Bash: "approval.tool.runCommand",
    Read: "approval.tool.readFile",
    Write: "approval.tool.writeFile",
    Edit: "approval.tool.editFile",
    WebFetch: "approval.tool.fetchWebPage",
    WebSearch: "approval.tool.searchWeb",
    schedule_routine: "approval.tool.scheduleRoutine",
    manage_routine: "approval.tool.changeRoutine",
    stage_skill: "approval.tool.enableSkill",
    update_skill: "approval.tool.updateSkill",
    update_profile: "approval.tool.updateProfile",
    // An ACP driver can know the protocol's toolCall kind but not the
    // tool's name, and sends the kind as the card's tool
    // (server/drivers/acp/core.ts). Kinds are not verb phrases —
    // "wants to other" reads as broken — so map every kind it can send
    // to a real phrase. "shell" is its name for execute; "tool" is its
    // fallback when an agent sends no kind at all — an unclassified call,
    // so it reads differently from "other", the agent's own generic kind.
    shell: "approval.tool.runCommand",
    edit: "approval.tool.editFile",
    read: "approval.tool.readFile",
    fetch: "approval.tool.fetchWebPage",
    delete: "approval.tool.deleteFile",
    think: "approval.tool.think",
    other: "approval.tool.takeAction",
    tool: "approval.tool.useTool",
  };
  const key = nice[tool];
  return key ? t(key) : bare;
}

export function ApprovalCard({
  bot,
  message,
}: {
  /** who is asking, for the "Name wants to …" line */
  bot?: Bot;
  message: Message;
}) {
  const card = message.card;
  if (!card) return null;
  const settled = card.answered;
  const isRoutineRequest = Boolean(card.routineRequest);
  const isSkillRequest = Boolean(card.skillRequest);
  const isProfileRequest = Boolean(card.profileRequest);
  const isTeamSetup = Boolean(card.teamSetupRequest);
  const routineAction = card.routineRequest?.operation.action;
  const skillAction = card.skillRequest?.action;
  const heldNote = tFromServer(card.heldCode, card.held);
  const routineSettledLabel = routineAction ? t(ROUTINE_SETTLED_LABEL[routineAction]) : undefined;
  const skillSettledLabel = skillAction ? t(SKILL_SETTLED_LABEL[skillAction]) : undefined;
  const displayTool = isRoutineRequest
    ? routineAction === "create" ? "schedule_routine" : "manage_routine"
    : isSkillRequest
      ? skillAction === "update" ? "update_skill" : "stage_skill"
    : isProfileRequest
      ? "update_profile"
    : card.tool;
  // A cross-bot profile card is shown in the PROPOSER's thread, so
  // "wants to update its profile" (fine for a bot editing itself) would
  // silently claim the proposer's own profile is changing. Name the actual
  // target whenever it differs from the proposer.
  const profileHeader = isProfileRequest && card.profileRequest
    ? card.profileRequest.targetBotId === card.profileRequest.botId
      ? t("approval.card.profileWantsToOwn", { name: bot?.name ?? t("approval.someone") })
      : t("approval.card.profileWantsToOther", {
          name: bot?.name ?? t("approval.someone"),
          target: card.profileRequest.targetName,
        })
    : undefined;

  return (
    <div
      data-tour={settled ? undefined : "approval"}
      data-approval={settled ? "settled" : "pending"}
      className={cn(
        "w-full max-w-[840px] rounded-lg border bg-card",
        settled
          ? "border-hairline/30 opacity-70"
          : "border-accent/50 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-accent)_8%,transparent)]",
      )}
    >
      {/* header bar */}
      <div className={cn(
        "flex items-center justify-between gap-3 border-b px-4 py-2.5",
        settled ? "border-hairline/20" : "border-accent/20 bg-accent/[0.04]",
      )}>
        <div className="text-[13.5px] font-semibold text-ink">
          {isTeamSetup ? card.title : profileHeader ?? (
            <>
              {bot
                ? t("approval.card.namedWantsTo", { name: bot.name, action: toolLabel(displayTool) })
                : t("approval.card.wantsTo", { action: toolLabel(displayTool) })}
            </>
          )}
        </div>
        {displayTool && !isTeamSetup && (
          <span className="shrink-0 rounded border border-hairline/30 bg-raised px-1.5 py-0.5 font-mono text-[10.5px] text-ink-secondary">
            {displayTool}
          </span>
        )}
      </div>

      {/* body */}
      <div className="p-3">
        {/* what, exactly */}
        <pre
          tabIndex={0}
          aria-label={
            isRoutineRequest
              ? t("approval.aria.routineDetails")
              : isSkillRequest
                ? t("approval.aria.skillDetails")
                : isProfileRequest
                  ? t("approval.aria.profileChange")
                  : t("approval.aria.details")
          }
          className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded bg-inset px-3 py-2 font-mono text-[12px] leading-relaxed text-ink"
        >
          {card.subtitle}
        </pre>

        {card.skillRequest && <SkillRequestPreview request={card.skillRequest} />}

        {heldNote && (
          <div className="mt-2 rounded border border-warning/30 bg-warning/[0.08] px-3 py-2 text-[12px] text-warning">
            {heldNote}
          </div>
        )}

        {/* status */}
        <div className="mt-2.5 flex items-center gap-1.5 text-[12px] text-ink-secondary">
          {settled === "allow" ? (
            <>
              <Check size={12} className="text-success" />
              {isTeamSetup ? (card.teamSetupRequest?.deletion ? "Bot deleted" : "Team setup applied") : skillSettledLabel ??
                routineSettledLabel ??
                (isProfileRequest
                  ? t("approval.status.profileUpdated")
                  : isRoutineRequest
                    ? t("approval.status.routineConfirmed")
                    : isSkillRequest
                      ? t("approval.status.skillConfirmed")
                      : t("approval.status.allowed"))}
            </>
          ) : settled ? (
            <>
              <X size={12} /> {isRoutineRequest || isSkillRequest || isProfileRequest || isTeamSetup
                ? t("approval.status.cancelled")
                : t("approval.status.denied")}
            </>
          ) : (
            <>
              <ShieldCheck size={12} className="text-accent" />
              {isRoutineRequest || isSkillRequest || isProfileRequest || isTeamSetup
                ? t("approval.status.waitingConfirmation")
                : t("approval.status.waitingAnswer")}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
