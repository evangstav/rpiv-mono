/**
 * RPC / dialog-primitive fallback for `ask_user_question`.
 *
 * The canonical TUI path (`ctx.ui.custom()`) renders a tabbed overlay that
 * needs a real terminal. RPC-mode hosts (the VSCode pendant, ACP clients such
 * as Zed or Paseo) report `hasUI: true` because pi's dialog sub-protocol
 * (`extension_ui_request`/`extension_ui_response`) works, but `ui.custom()`
 * resolves `undefined` without rendering anything (issue #78). `ui.select()`
 * and `ui.input()` ARE functional there — the host renders them natively — so
 * this module walks the questions sequentially with those primitives and
 * returns the same `QuestionnaireResult` shapes the TUI produces, feeding the
 * shared `buildQuestionnaireResponse` envelope.
 *
 * Parity trade-offs vs the TUI, inherent to the select/input API surface: no
 * side-by-side preview pane (previews are folded into the prompt title), no
 * tabbed multi-question review (one dialog per question), and multi-select is
 * a free-text numbers input instead of checkbox rows. The "Type something."
 * escape is preserved on both variants — multi-select treats any non-index
 * input as a typed custom answer — matching
 * `ROW_INTENT_META.other.autoAppendOnMultiSelect`.
 */

import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { displayLabel, t } from "./state/i18n-bridge.js";
import type { QuestionAnswer, QuestionData, QuestionnaireResult, QuestionParams } from "./tool/types.js";

/**
 * Canonical-English fallbacks; resolved through `t()` at dialog time so the
 * live locale applies (top-level `const x = t(...)` would bake load-time
 * English in — see i18n-bridge.ts). The sentinel row label comes from
 * `displayLabel("other")` — same source as the TUI row.
 */
const MULTI_SELECT_INSTRUCTIONS =
	'Enter the numbers of all that apply, comma-separated (e.g. "1,3"), or type a custom answer as plain text.';
const CUSTOM_ANSWER_TITLE = "Type your answer:";
const MULTI_SELECT_PLACEHOLDER = "1,3";

/** Longest preview slice folded into a select title before truncation. */
const MAX_PREVIEW_CHARS = 600;

/**
 * The dialog-primitive slice of `ExtensionUIContext` this walker needs.
 * Structural on purpose: the pinned pi 0.74 peer types predate `ctx.mode`,
 * and jiti transpiles without type-checking — `hasDialogUI` is the runtime
 * gate that makes the shape trustworthy.
 */
export type DialogUI = {
	select: (title: string, options: string[], opts?: ExtensionUIDialogOptions) => Promise<string | undefined>;
	input: (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) => Promise<string | undefined>;
};

/** True when the host implements the select/input dialog primitives. */
export function hasDialogUI(ui: unknown): ui is DialogUI {
	const u = ui as Partial<Record<"select" | "input", unknown>> | null | undefined;
	return typeof u?.select === "function" && typeof u?.input === "function";
}

type Option = QuestionData["options"][number];

function formatOptionLine(option: Option, index: number): string {
	return `${index + 1}. ${option.label} — ${option.description}`;
}

/**
 * Parse a user-entered (or select-returned) "N…" token to a 0-based option
 * index. `parseInt` reads the leading digits of "2. B — b" as 2; NaN and
 * out-of-range fail the bounds check and return null.
 */
function parseIndex(token: string, count: number): number | null {
	const i = Number.parseInt(token, 10) - 1;
	return i >= 0 && i < count ? i : null;
}

/** Previews folded into the select title — RPC has no side-by-side pane. */
function buildPreviewBlock(question: QuestionData): string {
	const blocks = question.options.flatMap((o, i) =>
		o.preview && o.preview.length > 0
			? [`--- ${i + 1}. ${o.label} preview ---\n${o.preview.slice(0, MAX_PREVIEW_CHARS)}`]
			: [],
	);
	return blocks.length > 0 ? `\n\n${blocks.join("\n\n")}` : "";
}

/**
 * Walk the questionnaire one native dialog at a time. Dismissing a question's
 * dialog (the primitive resolves `undefined`) cancels the whole questionnaire —
 * mirroring Esc in the TUI — and the shared envelope emits DECLINE. A
 * `QuestionAnswer` is produced per question otherwise, so the envelope is
 * identical to the TUI path's.
 */
export async function runRpcQuestionnaire(
	ui: DialogUI,
	params: QuestionParams,
	signal?: AbortSignal,
): Promise<QuestionnaireResult> {
	signal?.throwIfAborted();
	const answers: QuestionAnswer[] = [];
	for (let qi = 0; qi < params.questions.length; qi++) {
		const q = params.questions[qi];
		const header = q.header ? `[${q.header}] ` : "";
		const answer = q.multiSelect
			? await askMultiSelect(ui, q, qi, header, signal)
			: await askSingleSelect(ui, q, qi, header, signal);
		signal?.throwIfAborted();
		if (answer === undefined) return { answers, cancelled: true };
		answers.push(answer);
	}
	return { answers, cancelled: false };
}

/**
 * `undefined` means the user dismissed the option dialog (cancel the questionnaire).
 *
 * Hosts return the chosen option line, but some also let the user type a reply in
 * place of picking (T3 Code's "Type your own answer" box) and return that text
 * (#299). A reply is therefore read as: an offered line → that option; a bare
 * number → that option (hosts that return an index); a reply equal to an option
 * label → that option; any other non-empty text → the user's own answer, verbatim
 * — never a dismissal, and never "option N plus discarded text". Cancelling the
 * "Type something." follow-up returns to the options instead of cancelling the
 * whole questionnaire (#142), and that input repeats the option list so the user
 * can refer to it while typing (#194).
 */
async function askSingleSelect(
	ui: DialogUI,
	q: QuestionData,
	questionIndex: number,
	header: string,
	signal?: AbortSignal,
): Promise<QuestionAnswer | undefined> {
	const options = q.options.map(formatOptionLine);
	options.push(`${q.options.length + 1}. ${displayLabel("other")}`);
	const title = `${header}${q.question}${buildPreviewBlock(q)}`;
	for (;;) {
		signal?.throwIfAborted();
		const chosen = await ui.select(title, options, signal ? { signal } : undefined);
		signal?.throwIfAborted();
		if (chosen == null) return undefined;
		const reply = chosen.trim();
		if (reply.length === 0) return undefined;
		const idx = resolveSingleSelectReply(chosen, reply, options, q);
		if (idx === undefined) return { questionIndex, question: q.question, kind: "custom", answer: reply };
		if (idx < q.options.length) {
			const o = q.options[idx];
			return {
				questionIndex,
				question: q.question,
				kind: "option",
				answer: o.label,
				preview: o.preview && o.preview.length > 0 ? o.preview : undefined,
			};
		}
		// "Type something." sentinel → free-text follow-up; cancelling it goes back to the options.
		const typed = await ui.input(
			`${header}${q.question}\n\n${q.options.map(formatOptionLine).join("\n")}\n\n${t("rpc.custom_answer_title", CUSTOM_ANSWER_TITLE)}`,
			"",
			signal ? { signal } : undefined,
		);
		signal?.throwIfAborted();
		if (typed == null) continue;
		return { questionIndex, question: q.question, kind: "custom", answer: typed };
	}
}

/** Option index for a select reply, or `undefined` when the reply is the user's own text. */
function resolveSingleSelectReply(
	chosen: string,
	reply: string,
	lines: readonly string[],
	q: QuestionData,
): number | undefined {
	const line = lines.indexOf(chosen);
	if (line >= 0) return line;
	if (/^\d+\.?$/.test(reply)) return parseIndex(reply, lines.length) ?? undefined;
	const label = q.options.findIndex((o) => o.label === reply);
	return label >= 0 ? label : undefined;
}

/** `undefined` means the user dismissed the dialog (cancel the questionnaire). */
async function askMultiSelect(
	ui: DialogUI,
	q: QuestionData,
	questionIndex: number,
	header: string,
	signal?: AbortSignal,
): Promise<QuestionAnswer | undefined> {
	signal?.throwIfAborted();
	const list = q.options.map(formatOptionLine).join("\n");
	const value = await ui.input(
		`${header}${q.question}\n\n${list}\n\n${t("rpc.multi_instructions", MULTI_SELECT_INSTRUCTIONS)}`,
		MULTI_SELECT_PLACEHOLDER,
		signal ? { signal } : undefined,
	);
	signal?.throwIfAborted();
	if (value == null) return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		// Deliberate empty commit — same as pressing "Next" with nothing toggled.
		return { questionIndex, question: q.question, kind: "multi", answer: null, selected: [] };
	}
	const tokens = trimmed.split(/[,\s]+/).filter((tok) => tok.length > 0);
	const indices = tokens.map((tok) => (/^\d+\.?$/.test(tok) ? parseIndex(tok, q.options.length) : null));
	if (indices.every((i): i is number => i != null)) {
		const selected: string[] = [];
		for (const i of indices) {
			const label = q.options[i].label;
			if (!selected.includes(label)) selected.push(label);
		}
		return { questionIndex, question: q.question, kind: "multi", answer: null, selected };
	}
	// Any non-index token (words, or an out-of-range number like "13" for three
	// options) means the user typed an answer, not a selection. Preserve it
	// verbatim as a custom answer instead of silently dropping their input —
	// this is also the multi-select "Type something." escape.
	return { questionIndex, question: q.question, kind: "custom", answer: trimmed };
}
