// Minimal vscode mock for unit testing pure helpers that live in files importing vscode
export default {};
export const Uri = { from: () => ({}) };
export const EventEmitter = class { event = () => {}; fire() {} };
export const workspace = {};
export const window = {};
