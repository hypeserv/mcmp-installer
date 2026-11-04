import cliProgress from 'cli-progress';
import { log } from './logger.js';

const WIDTH = 20;

/**
 * Overall progress for a list of mod downloads. On a terminal: one live bar.
 * Elsewhere (panel install console): one line per mod with a text bar,
 * e.g. `[MCI] Mods [########------------] 45/178 (25%) sodium-0.5.8.jar`.
 */
export class ModProgress {
    private done = 0;
    private failed = 0;
    private skipped = 0;
    private countedSkips = 0;
    private readonly bar?: cliProgress.SingleBar;

    private lastPrintedPct = -1;

    /**
     * stepPct: on non-terminals, print only when the percentage advanced by at
     * least this much (0 = a line per file). Large packs (FTB: 2000+ files) use 1.
     */
    constructor(
        private readonly total: number,
        private readonly label = 'Mods',
        private readonly stepPct = 0
    ) {
        if (process.stdout.isTTY && total > 0) {
            this.bar = new cliProgress.SingleBar(
                { format: `${label} [{bar}] {value}/{total} ({percentage}%) {file}`, hideCursor: true },
                cliProgress.Presets.shades_classic
            );
            this.bar.start(total, 0, { file: '' });
        }
    }

    ok(file: string): void {
        this.done++;
        this.tick(file);
    }

    fail(file: string, reason: string): void {
        this.done++;
        this.failed++;
        // Failures always get their own line, also on a terminal.
        this.bar?.stop();
        log.warn(`${this.label}: ${file} failed: ${reason}`);
        if (this.bar) this.bar.start(this.total, this.done, { file });
        else this.tick(file);
    }

    /** Client-only file. With a name it counts toward the total (manifest path). */
    skip(file?: string): void {
        this.skipped++;
        if (file) {
            this.done++;
            this.countedSkips++;
            this.tick(`${file} (skipped)`);
        }
    }

    finish(): void {
        this.bar?.stop();
        const parts = [`${this.done - this.failed - this.countedSkips}/${this.total} downloaded`];
        if (this.failed) parts.push(`${this.failed} failed`);
        if (this.skipped) parts.push(`${this.skipped} skipped (client-only / not a mod)`);
        const line = `${this.label} done: ${parts.join(', ')}.`;
        if (this.failed) log.warn(line);
        else log.info(line);
    }

    private tick(file: string): void {
        if (this.bar) {
            this.bar.update(this.done, { file });
            return;
        }
        const pct = this.total ? Math.floor((this.done / this.total) * 100) : 100;
        if (this.stepPct > 0 && this.done < this.total && pct < this.lastPrintedPct + this.stepPct) return;
        this.lastPrintedPct = pct;
        const filled = this.total ? Math.round((this.done / this.total) * WIDTH) : WIDTH;
        log.info(`${this.label} [${'#'.repeat(filled)}${'-'.repeat(WIDTH - filled)}] ${this.done}/${this.total} (${pct}%) ${file}`);
    }
}
