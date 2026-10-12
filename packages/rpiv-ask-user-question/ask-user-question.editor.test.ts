import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import { ASK_USER_BLOCKED_EVENT } from "./events.js";
import * as externalEditor from "./state/external-editor.js";

it("keeps the tool blocked until editor teardown finishes even if the host closes the UI", async () => {
	const emit = vi.fn();
	const { pi, captured } = createMockPi({ events: { emit, on: vi.fn(() => () => {}) } });
	registerAskUserQuestionTool(pi);
	const controller = new AbortController();
	vi.spyOn(SettingsManager, "create").mockReturnValue({ getExternalEditorCommand: () => "editor" } as never);
	let started!: () => void;
	const editorStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	let finishEditor!: () => void;
	vi.spyOn(externalEditor, "editWithExternalEditor").mockImplementation((_tui, _cmd, _value, signal) => {
		expect(signal).toBe(controller.signal);
		return new Promise<string>((_resolve, reject) => {
			finishEditor = () => reject(controller.signal.reason);
			started();
		});
	});
	let closeUi!: () => void;
	const custom = (factory: (...args: never[]) => { handleInput(data: string): void }) =>
		new Promise((resolve) => {
			closeUi = () => resolve({ answers: [], cancelled: true });
			const tui = { requestRender() {}, terminal: { columns: 120, rows: 24 } };
			const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
			const kb = {
				matches: (data: string, name: string) =>
					name === "app.editor.external" ? data === "\x07" : getKeybindings().matches(data, name as never),
			};
			const component = factory(tui as never, theme as never, kb as never, resolve as never);
			component.handleInput("\x1b[B");
			component.handleInput("\x1b[B");
			component.handleInput("\x07");
		});
	const notify = vi.fn();
	const ctx = createMockCtx({ hasUI: true, ui: { custom, notify } as never });
	ctx.isProjectTrusted = () => true;
	let settled = false;
	const outcome = captured.tools
		.get("ask_user_question")!
		.execute(
			"tc",
			{
				questions: [
					{
						question: "Which?",
						header: "Pick",
						options: [
							{ label: "A", description: "First" },
							{ label: "B", description: "Second" },
						],
					},
				],
			},
			controller.signal,
			undefined,
			ctx,
		)
		.then(
			() => {
				settled = true;
				return undefined;
			},
			(error) => {
				settled = true;
				return error;
			},
		);
	try {
		await Promise.race([
			editorStarted,
			outcome.then((error) => {
				throw error ?? new Error("tool finished before editor opened");
			}),
		]);
		controller.abort();
		closeUi();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		expect(emit).toHaveBeenLastCalledWith(ASK_USER_BLOCKED_EVENT, { active: true });
		finishEditor();
		expect(await outcome).toMatchObject({ name: "AbortError" });
		expect(emit).toHaveBeenLastCalledWith(ASK_USER_BLOCKED_EVENT, { active: false });
		expect(notify).not.toHaveBeenCalled();
	} finally {
		controller.abort();
		closeUi?.();
		finishEditor?.();
		await outcome;
	}
});
