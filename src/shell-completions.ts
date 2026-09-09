import { CLI_COMMAND_CONTRACT, GENERATOR_PATH } from "./cli-contract.ts";

/** Stable marker that lets the installer replace only files it owns. */
export const COMPLETION_OWNERSHIP_MARKER = `# Managed by ${CLI_COMMAND_CONTRACT.binary} completion install.`;

const VALUE_FLAGS = new Set(
	CLI_COMMAND_CONTRACT.flags.filter((flag) => flag.usage.includes(" <")).map((flag) => flag.name),
);
const SHELL_PARAMETER_START = "$" + "{";
const GOAL_ID_ACTIONS = new Set([
	"show",
	"update",
	"move",
	"start",
	"set_active",
	"complete",
	"reopen",
	"archive",
	"delete",
]);

/** Quote one generated value for a single-quoted shell word. */
function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function actionFlags(action: string): string[] {
	return CLI_COMMAND_CONTRACT.flags
		.filter((flag) => flag.actions === undefined || flag.actions.includes(action))
		.map((flag) => flag.name);
}

function bashCaseEntries(): string[] {
	return CLI_COMMAND_CONTRACT.actions.map(
		(action) => `\t\t${action.name}) flags=${shellQuote(actionFlags(action.name).join(" "))} ;;`,
	);
}

/** Parse each completed word once. A consumed option value is always data. */
function completionWordParser(shell: "bash" | "zsh"): string[] {
	const bash = shell === "bash";
	return [
		`for (( index=${bash ? 3 : 4}; index<${bash ? "COMP_CWORD" : "CURRENT"}; index++ )); do`,
		bash
			? `\ttoken=$(_${CLI_COMMAND_CONTRACT.binary}_unquote "${SHELL_PARAMETER_START}COMP_WORDS[index]}")`
			: `\ttoken=${SHELL_PARAMETER_START}(Q)words[index]}`,
		"\tif [[ -n $pending ]]; then",
		"\t\tif [[ $pending == --cwd || $pending == --file ]]; then",
		'\t\t\tselectors+=("$pending" "$token")',
		"\t\tfi",
		"\t\tif [[ $pending == --cwd ]]; then directory=$token; fi",
		"\t\tpending=''",
		"\t\tcontinue",
		"\tfi",
		// The CLI treats -- as the start of description prose, not more options.
		"\tif [[ $token == -- ]]; then return; fi",
		'\tcase "$token" in',
		`\t\t${[...VALUE_FLAGS].join("|")}) pending=$token; continue ;;`,
		"\t\t--*) continue ;;",
		"\tesac",
		"\t((positionals++))",
		"\tprev=$token",
		"done",
	];
}

/** Render a dependency-free Bash completion for the installed executable. */
export function renderBashCompletion(): string {
	const contract = CLI_COMMAND_CONTRACT;
	const actions = contract.actions.map((action) => action.name).join(" ");
	const goalIdActions = [...GOAL_ID_ACTIONS].join("|");
	return [
		COMPLETION_OWNERSHIP_MARKER,
		`# Generated from src/cli-contract.ts by ${GENERATOR_PATH}. Do not edit manually.`,
		"",
		`_${contract.binary}_unquote() {`,
		"\tlocal input=$1 output='' quote='' char next index",
		`\tfor (( index=0; index<${SHELL_PARAMETER_START}#input}; index++ )); do`,
		`\t\tchar=${SHELL_PARAMETER_START}input:index:1}`,
		'\t\tif [[ $quote == "\'" ]]; then',
		"\t\t\tif [[ $char == \"'\" ]]; then quote=''; else output+=$char; fi",
		"\t\telif [[ $char == '\\' ]]; then",
		`\t\t\tnext=${SHELL_PARAMETER_START}input:index+1:1}`,
		"\t\t\tif [[ -z $quote || $next == '$' || $next == '`' || $next == '\"' || $next == '\\' ]]; then",
		"\t\t\t\toutput+=$next; ((index++))",
		"\t\t\telse output+=$char; fi",
		"\t\telif [[ -n $quote ]]; then",
		"\t\t\tif [[ $char == '\"' ]]; then quote=''; else output+=$char; fi",
		"\t\telif [[ $char == \"'\" || $char == '\"' ]]; then quote=$char",
		"\t\telse output+=$char",
		"\t\tfi",
		"\tdone",
		"\tprintf '%s' \"$output\"",
		"}",
		"",
		`_${contract.binary}_goal_ids() {`,
		`\tlocal executable=$(_${contract.binary}_unquote "${SHELL_PARAMETER_START}COMP_WORDS[0]}")`,
		`\t"$executable" project list "${SHELL_PARAMETER_START}selectors[@]}" 2>/dev/null | sed -n 's/^\\[[^]]*\\] \\([^:]*\\):.*/\\1/p'`,
		"}",
		"",
		`_${contract.binary}_action_flags() {`,
		"\tlocal action=$1 flags",
		'\tcase "$action" in',
		...bashCaseEntries(),
		"\t\t*) flags='' ;;",
		"\tesac",
		"\tprintf '%s\\n' \"$flags\"",
		"}",
		"",
		`_${contract.binary}_paths() {`,
		"\tlocal candidate",
		"\twhile IFS= read -r candidate; do",
		'\t\tCOMPREPLY+=("$candidate")',
		'\tdone < <(compgen "$1" -- "$2")',
		"}",
		"",
		`_${contract.binary}_branches() {`,
		"\tgit -C \"$directory\" branch --format='%(refname:short)' 2>/dev/null",
		"}",
		"",
		`_${contract.binary}() {`,
		"\tlocal cur prev='' action flags positionals=0 index token pending='' directory=$PWD",
		"\tlocal -a selectors=()",
		"\tCOMPREPLY=()",
		`\tcur=${SHELL_PARAMETER_START}COMP_WORDS[COMP_CWORD]}`,
		"",
		"\tif (( COMP_CWORD == 1 )); then",
		`\t\tCOMPREPLY=( $(compgen -W ${shellQuote(`${contract.scope} completion`)} -- "$cur") )`,
		"\t\treturn",
		"\tfi",
		`\tif [[ ${SHELL_PARAMETER_START}COMP_WORDS[1]} == completion ]]; then`,
		"\t\tif (( COMP_CWORD == 2 )); then",
		`\t\t\tCOMPREPLY=( $(compgen -W ${shellQuote("install")} -- "$cur") )`,
		"\t\tfi",
		"\t\treturn",
		"\tfi",
		"\tif (( COMP_CWORD == 2 )); then",
		`\t\tCOMPREPLY=( $(compgen -W ${shellQuote(actions)} -- "$cur") )`,
		"\t\treturn",
		"\tfi",
		"",
		...completionWordParser("bash").map((line) => `\t${line}`),
		'\tcase "$pending" in',
		`\t\t--cwd) _${contract.binary}_paths -d "$cur"; return ;;`,
		`\t\t--file) _${contract.binary}_paths -f "$cur"; return ;;`,
		`\t\t--depends-on) COMPREPLY=( $(compgen -W "$(_${contract.binary}_goal_ids)" -- "$cur") ); return ;;`,
		`\t\t--branch) COMPREPLY=( $(compgen -W "$(_${contract.binary}_branches)" -- "$cur") ); return ;;`,
		"\t\t--*) return ;;",
		"\tesac",
		`\taction=${SHELL_PARAMETER_START}COMP_WORDS[2]}`,
		`\tflags=$(_${contract.binary}_action_flags "$action")`,
		"\tif [[ $cur == --* ]]; then",
		'\t\tCOMPREPLY=( $(compgen -W "$flags" -- "$cur") )',
		"\t\treturn",
		"\tfi",
		"",
		'\tcase "$action" in',
		`\t\t${goalIdActions})`,
		"\t\t\tif (( positionals == 0 )); then",
		`\t\t\t\tCOMPREPLY=( $(compgen -W "$(_${contract.binary}_goal_ids) $flags" -- "$cur") )`,
		"\t\t\telif [[ $action == move && $positionals == 1 ]]; then",
		'\t\t\t\tCOMPREPLY=( $(compgen -W "up down before after $flags" -- "$cur") )',
		"\t\t\telif [[ $action == move && $positionals == 2 && ( $prev == before || $prev == after ) ]]; then",
		`\t\t\t\tCOMPREPLY=( $(compgen -W "$(_${contract.binary}_goal_ids) $flags" -- "$cur") )`,
		"\t\t\telse",
		'\t\t\t\tCOMPREPLY=( $(compgen -W "$flags" -- "$cur") )',
		"\t\t\tfi",
		"\t\t\t;;",
		"\t\tapply-plan)",
		`\t\t\tif (( positionals == 0 )); then _${contract.binary}_paths -f "$cur"; fi`,
		"\t\t\t;;",
		'\t\t*) COMPREPLY=( $(compgen -W "$flags" -- "$cur") ) ;;',
		"\tesac",
		"}",
		"",
		`complete -o filenames -F _${contract.binary} ${contract.binary}`,
		"",
	].join("\n");
}

function zshActionEntries(): string[] {
	return CLI_COMMAND_CONTRACT.actions.map((action) =>
		shellQuote(`${action.name}:${action.summary.replaceAll(":", "\\:")}`),
	);
}

function zshFlagCaseEntries(): string[] {
	return CLI_COMMAND_CONTRACT.actions.map(
		(action) => `\t\t${action.name}) flags=(${actionFlags(action.name).map(shellQuote).join(" ")}) ;;`,
	);
}

/** Render a Zsh completion for the installed executable. */
export function renderZshCompletion(): string {
	const contract = CLI_COMMAND_CONTRACT;
	const goalIdActions = [...GOAL_ID_ACTIONS].join("|");
	return [
		`#compdef ${contract.binary}`,
		COMPLETION_OWNERSHIP_MARKER,
		`# Generated from src/cli-contract.ts by ${GENERATOR_PATH}. Do not edit manually.`,
		"",
		`_${contract.binary}_goal_ids() {`,
		"\tlocal -a ids",
		`\tids=("${SHELL_PARAMETER_START}(@f)$(command "${SHELL_PARAMETER_START}(Q)words[1]}" project list "${SHELL_PARAMETER_START}selectors[@]}" 2>/dev/null | sed -n 's/^\\[[^]]*\\] \\([^:]*\\):.*/\\1/p')}")`,
		`\t(( ${SHELL_PARAMETER_START}#ids} )) && _describe 'goal' ids`,
		"}",
		"",
		`_${contract.binary}_branches() {`,
		"\tlocal -a branches",
		`\tbranches=("${SHELL_PARAMETER_START}(@f)$(command git -C "$directory" branch --format='%(refname:short)' 2>/dev/null)}")`,
		`\t(( ${SHELL_PARAMETER_START}#branches} )) && _describe 'branch' branches`,
		"}",
		"",
		`_${contract.binary}_action_flags() {`,
		"\tlocal action=$1",
		"\tlocal -a flags",
		'\tcase "$action" in',
		...zshFlagCaseEntries(),
		"\t\t*) flags=() ;;",
		"\tesac",
		"\t_describe 'flag' flags",
		"}",
		"",
		"local action token prev='' pending='' directory=$PWD",
		"local -i index positionals=0",
		"local -a actions selectors=()",
		"actions=(",
		...zshActionEntries().map((entry) => `\t${entry}`),
		")",
		"",
		"if (( CURRENT == 2 )); then",
		`\tcompadd -- ${shellQuote(contract.scope)} ${shellQuote("completion")}`,
		"\treturn",
		"fi",
		"if [[ $words[2] == completion ]]; then",
		"\tif (( CURRENT == 3 )); then",
		`\t\tcompadd -- ${shellQuote("install")}`,
		"\tfi",
		"\treturn",
		"fi",
		"if (( CURRENT == 3 )); then",
		"\t_describe 'action' actions",
		"\treturn",
		"fi",
		"",
		...completionWordParser("zsh"),
		"action=$words[3]",
		'case "$pending" in',
		"\t--cwd) _directories; return ;;",
		"\t--file) _files; return ;;",
		`\t--depends-on) _${contract.binary}_goal_ids; return ;;`,
		`\t--branch) _${contract.binary}_branches; return ;;`,
		"\t--*) return ;;",
		"esac",
		"if [[ $PREFIX == --* ]]; then",
		`\t_${contract.binary}_action_flags "$action"`,
		"\treturn",
		"fi",
		"",
		'case "$action" in',
		`\t${goalIdActions})`,
		"\t\tif (( positionals == 0 )); then",
		`\t\t\t_${contract.binary}_goal_ids`,
		"\t\telif [[ $action == move && $positionals == 1 ]]; then",
		"\t\t\tlocal -a placements=(up down before after)",
		"\t\t\t_describe 'placement' placements",
		"\t\telif [[ $action == move && $positionals == 2 && ( $prev == before || $prev == after ) ]]; then",
		`\t\t\t_${contract.binary}_goal_ids`,
		"\t\telse",
		`\t\t\t_${contract.binary}_action_flags "$action"`,
		"\t\tfi",
		"\t\t;;",
		"\tapply-plan)",
		"\t\tif (( positionals == 0 )); then _files; fi",
		"\t\t;;",
		`\t*) _${contract.binary}_action_flags "$action" ;;`,
		"esac",
		"",
	].join("\n");
}
