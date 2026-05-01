// terminal.js — interactive command interface.
// Implementation lives in spec 03 (terminal).
//
// Contract:
//   export function initTerminal(root: HTMLElement, commands: CommandRegistry): { focus(), destroy() }
//
// commands.json drives the command registry. Each command can scroll to a
// section, write output to the terminal, or trigger an animation.

export function initTerminal(root, commands) {
    console.info("[terminal] init stub — implement in spec 03", { root, commands });
    return { focus() {}, destroy() {} };
}
