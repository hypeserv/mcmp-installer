export interface Logger {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
}

export const log: Logger = {
    info: (...args: unknown[]): void => console.log('[MCI]', ...args),
    warn: (...args: unknown[]): void => console.warn('[MCI][WARN]', ...args),
    error: (...args: unknown[]): void => console.error('[MCI][ERROR]', ...args)
};
