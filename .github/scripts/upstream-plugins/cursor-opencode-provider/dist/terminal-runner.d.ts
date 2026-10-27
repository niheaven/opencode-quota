import type { CursorShellPolicy } from "./shell-timeout.js";
/** Host-visible status of a launcher that reports a hard timeout, as timeout(1) uses. */
export declare const TIMEOUT_EXIT_CODE = 124;
export type ManagedTerminal = {
    command: string;
    directory: string;
    file: string;
    shellId: number;
};
/** A detached supervisor owns its command group and durable terminal record. */
export declare function createManagedTerminal(policy: CursorShellPolicy, root: string): ManagedTerminal;
/**
 * Denied/unstarted commands leave no reserved record; running jobs are durable.
 * A launcher claims its job before it starts anything and hands the claim back
 * when startup fails, so only a release that takes the claim removes files.
 */
export declare function releaseUnstartedTerminal(directory: string | undefined): void;
