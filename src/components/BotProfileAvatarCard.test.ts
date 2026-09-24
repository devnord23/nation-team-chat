import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StoreProvider, type Bot } from "@/state/store";
import { BotProfileAvatarCard } from "./BotProfileAvatarCard";

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    threadId: "thread-1",
    name: "Maus",
    title: "Maus",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "local", model: "test-model" },
    messages: [],
    ...overrides,
  };
}

function renderCard(bot: Bot) {
  return renderToStaticMarkup(
    createElement(
      StoreProvider,
      null,
      createElement(BotProfileAvatarCard, {
        bot,
        activeState: "idle",
        mascotMotion: null,
        onPatch: vi.fn(),
      }),
    ),
  );
}

describe("BotProfileAvatarCard face picker", () => {
  it("renders a Face section with the six soft-tower face options", () => {
    const markup = renderCard(makeBot());

    expect(markup).toContain(">Face<");
    for (const face of ["coordinator", "researcher", "builder", "analyst", "creator", "operator"]) {
      expect(markup).toContain(`aria-label="Use ${face} face"`);
    }
  });

  it("marks the current face pressed based on bot color (green → coordinator)", () => {
    const markup = renderCard(makeBot({ color: "green" }));

    // The button has aria-pressed="true" and aria-label="Use coordinator face" (not adjacent)
    expect(markup).toContain(`aria-pressed="true"`);
    expect(markup).toContain(`aria-label="Use coordinator face"`);
    // Researcher button is not the active one
    expect(markup).toContain(`aria-pressed="false" class`);
    expect(markup).toContain(`aria-label="Use researcher face"`);
  });

  it("reflects a blue bot as researcher face", () => {
    const markup = renderCard(makeBot({ color: "blue" }));

    expect(markup).toContain(`aria-pressed="true"`);
    expect(markup).toContain(`aria-label="Use researcher face"`);
    expect(markup).toContain(`aria-label="Use coordinator face"`);
  });

  it("hides the face picker for flat crops that have no default avatar", () => {
    const markup = renderCard(makeBot({ avatarCrop: "circle" }));

    expect(markup).not.toContain(">Face<");
    expect(markup).not.toContain(`aria-label="Use coordinator face"`);
  });

  it("hides the face picker for every flat crop, not just circle", () => {
    for (const crop of ["rounded", "square"] as const) {
      const markup = renderCard(makeBot({ avatarCrop: crop }));

      expect(markup).not.toContain(">Face<");
    }
  });
});
