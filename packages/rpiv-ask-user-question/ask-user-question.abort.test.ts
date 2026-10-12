import { type ExtensionContext, type ExtensionUIDialogOptions, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings } from "@earendil-works/pi-tui";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it, vi } from "vitest";
import { registerAskUserQuestionTool } from "./ask-user-question.js";
import { ASK_USER_BLOCKED_EVENT } from "./events.js";
import { resolvePresentation } from "./presentation.js";
import { makeTestTui } from "./test-fixtures.js";

const params = {
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
};
const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };

function register() {
	const emit = vi.fn();
	const { pi, captured } = createMockPi({ events: { emit, on: vi.fn(() => () => {}) } });
	registerAskUserQuestionTool(pi);
	return { tool: captured.tools.get("ask_user_question")!, emit };
}

describe("ask_user_question cancellation", () => {
	it("does not prompt or emit events for an already-aborted call", async () => {
		const { tool, emit } = register();
		const controller = new AbortController();
		controller.abort();
		const custom = vi.fn();
		const ctx = createMockCtx({ hasUI: true, ui: { custom } as never });
		await expect(tool.execute("tc", params, controller.signal, undefined, ctx)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(custom).not.toHaveBeenCalled();
		expect(emit).not.toHaveBeenCalled();
	});

	it.each(["only", "covered", "hidden-covered", "before-mount"])(
		"aborts only its own overlay and cleans listeners (%s)",
		async (scenario) => {
			const { tool, emit } = register();
			const holder = resolvePresentation();
			const controller = new AbortController();
			const remove = vi.spyOn(controller.signal, "removeEventListener");
			const removeTerminal = vi.fn();
			const tui = makeTestTui();
			const other = { render: () => ["other overlay"], invalidate: vi.fn(), handleInput: vi.fn() };
			let otherHandle: ReturnType<typeof tui.showOverlay> | undefined;
			const close = vi.fn();
			// Exercise the actual native host method without starting an agent or terminal.
			const showCustom: ExtensionContext["ui"]["custom"] = Reflect.get(
				InteractiveMode.prototype,
				"showExtensionCustom",
			);
			const custom = vi.fn(
				(
					factory: Parameters<ExtensionContext["ui"]["custom"]>[0],
					options?: Parameters<ExtensionContext["ui"]["custom"]>[1],
				) => {
					if (scenario === "before-mount") otherHandle = tui.showOverlay(other);
					return showCustom.call(
						{ ui: tui, editor: { getText: () => "" } },
						(hostTui, _theme, kb, done) => {
							const component = factory(hostTui, theme as never, kb, (value) => {
								close();
								done(value);
							});
							if (scenario === "before-mount") controller.abort();
							return component;
						},
						{
							...options,
							onHandle: (own) => {
								options?.onHandle?.(own);
								if (scenario === "hidden-covered") own.setHidden(true);
								if (scenario !== "only") otherHandle = tui.showOverlay(other);
								controller.abort();
							},
						},
					);
				},
			);
			const ctx = createMockCtx({ hasUI: true, ui: { custom, onTerminalInput: () => removeTerminal } as never });
			await expect(tool.execute("tc", params, controller.signal, undefined, ctx)).rejects.toMatchObject({
				name: "AbortError",
			});
			expect(close).toHaveBeenCalledTimes(1);
			expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
			expect(removeTerminal).toHaveBeenCalledTimes(1);
			expect(emit).toHaveBeenLastCalledWith(ASK_USER_BLOCKED_EVENT, { active: false });
			// Inspect the real stack: hasOverlay() alone misses orphaned hidden entries.
			expect(Reflect.get(tui, "overlayStack")).toEqual(
				scenario === "only" ? [] : [expect.objectContaining({ component: other })],
			);
			holder.release?.();
			if (otherHandle) {
				expect(otherHandle.isFocused()).toBe(true);
				otherHandle.hide();
				expect(Reflect.get(tui, "overlayStack")).toEqual([]);
			}
		},
	);

	it.each(["inline", "yielded-overlay", "abort-before-factory", "abort-after-yield"])(
		"cancels the current mount and releases the inline slot (%s)",
		async (scenario) => {
			const { tool, emit } = register();
			const controller = new AbortController();
			const tui = makeTestTui();
			const other = { render: () => ["other"], invalidate: () => {} };
			const hasOther = scenario === "yielded-overlay" || scenario === "abort-after-yield";
			const otherHandle = hasOther ? tui.showOverlay(other) : undefined;
			const host = {
				ui: tui,
				editor: { getText: () => "", setText: vi.fn() },
				editorContainer: new Container(),
				disposeActiveSelector: vi.fn(),
				keybindings: getKeybindings(),
			};
			const showCustom: ExtensionContext["ui"]["custom"] = Reflect.get(
				InteractiveMode.prototype,
				"showExtensionCustom",
			);
			const modes: boolean[] = [];
			const custom = (
				factory: Parameters<ExtensionContext["ui"]["custom"]>[0],
				options?: Parameters<ExtensionContext["ui"]["custom"]>[1],
			) => {
				modes.push(options?.overlay ?? false);
				if (scenario === "abort-before-factory") controller.abort();
				return showCustom.call(
					host,
					(hostTui, _theme, kb, done) => {
						const component = factory(hostTui, theme as never, kb, done);
						// Let the native host mount before cancellation, except at the yield boundary.
						if (scenario === "abort-after-yield") controller.abort();
						else if (!hasOther || options?.overlay) setImmediate(() => controller.abort());
						return component;
					},
					options,
				);
			};
			const ctx = createMockCtx({ hasUI: true, ui: { custom } as never });
			await expect(tool.execute("tc", params, controller.signal, undefined, ctx)).rejects.toMatchObject({
				name: "AbortError",
			});
			expect(modes).toEqual(scenario === "yielded-overlay" ? [false, true] : [false]);
			expect(Reflect.get(tui, "overlayStack")).toEqual(
				hasOther ? [expect.objectContaining({ component: other })] : [],
			);
			expect(emit).toHaveBeenLastCalledWith(ASK_USER_BLOCKED_EVENT, { active: false });
			otherHandle?.hide();
			const next = resolvePresentation();
			expect(next.overlay).toBe(false);
			next.release?.();
		},
	);

	it("does not reopen the picker when cancellation dismisses the custom-answer input", async () => {
		const { tool } = register();
		const controller = new AbortController();
		const select = vi.fn(async () => "3. Type something.");
		const input = vi.fn(async () => {
			controller.abort();
			return undefined;
		});
		const ctx = createMockCtx({ hasUI: true, mode: "rpc", ui: { select, input } as never });
		await expect(tool.execute("tc", params, controller.signal, undefined, ctx)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(select).toHaveBeenCalledOnce();
		expect(input).toHaveBeenCalledOnce();
	});

	it.each(["rpc", "legacy"])(
		"passes cancellation to %s dialogs and holds blocked state until they settle",
		async (mode) => {
			const { tool, emit } = register();
			const controller = new AbortController();
			let options: ExtensionUIDialogOptions | undefined;
			const select = vi.fn(async (_title: string, _choices: string[], opts?: ExtensionUIDialogOptions) => {
				options = opts;
				expect(emit).toHaveBeenLastCalledWith(ASK_USER_BLOCKED_EVENT, { active: true });
				controller.abort();
				await Promise.resolve();
				expect(emit).toHaveBeenLastCalledWith(ASK_USER_BLOCKED_EVENT, { active: true });
				return undefined;
			});
			const ctx = createMockCtx({
				hasUI: true,
				mode: mode === "rpc" ? "rpc" : "interactive",
				ui: {
					custom: async () => undefined,
					select,
					input: vi.fn(),
				} as never,
			});
			await expect(tool.execute("tc", params, controller.signal, undefined, ctx)).rejects.toMatchObject({
				name: "AbortError",
			});
			expect(options?.signal).toBe(controller.signal);
			expect(emit).toHaveBeenLastCalledWith(ASK_USER_BLOCKED_EVENT, { active: false });
		},
	);

	it("settles a pending native RPC dialog when the signal aborts", async () => {
		const { tool, emit } = register();
		const controller = new AbortController();
		const select = vi.fn(
			(_title: string, _choices: string[], opts?: ExtensionUIDialogOptions) =>
				new Promise<string | undefined>((resolve) => {
					// Model Pi's native dialog contract, including signal-driven dismissal.
					opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				}),
		);
		const ctx = createMockCtx({ hasUI: true, mode: "rpc", ui: { select, input: vi.fn() } as never });
		const pending = tool.execute("tc", params, controller.signal, undefined, ctx);
		const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
		controller.abort();
		await rejected;
		expect(emit).toHaveBeenLastCalledWith(ASK_USER_BLOCKED_EVENT, { active: false });
	});

	it("does not open a custom-answer follow-up after RPC cancellation", async () => {
		const { tool } = register();
		const controller = new AbortController();
		const input = vi.fn(async () => "late answer");
		const ctx = createMockCtx({
			hasUI: true,
			mode: "rpc",
			ui: {
				input,
				select: async () => {
					controller.abort();
					return "3. Type something.";
				},
			} as never,
		});
		await expect(tool.execute("tc", params, controller.signal, undefined, ctx)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(input).not.toHaveBeenCalled();
	});
});
