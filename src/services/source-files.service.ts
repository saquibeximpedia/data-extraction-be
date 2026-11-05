import { findCountry, hasSourceFiles, SourceFile } from '../countries';
import { Period, TradeFlow } from '../types';
import { badRequest, notFound } from '../utils/errors';
import { withRetry } from '../utils/http';
import { periodOfDate, periodRange, toPeriod } from '../utils/period';
import { db } from './db.service';
import { settingsService } from './settings.service';

const MAX_MONTHS = 60;

/** One month and flow's files at the source; none when it isn't published yet */
export interface SourceMonth {
  period: Period;
  flow: TradeFlow;
  files: SourceFile[];
}

/**
 * Source-files countries: the month's file links, for the web app to download straight from the
 * source to the user's device. Nothing is downloaded, stored or recorded here, and no run starts.
 */
export const sourceFilesService = {
  async list(code: string, start: string, end: string, tradeType: 'ALL' | TradeFlow): Promise<SourceMonth[]> {
    const country = findCountry(code);
    if (!country) throw notFound(`This extraction service has no country ${code.toUpperCase()}.`);
    if (!hasSourceFiles(country)) throw badRequest(`${country.name} has no source files to download: extract it instead.`);
    if (tradeType !== 'ALL' && !country.tradeTypes.includes(tradeType)) throw badRequest(`${country.code} supports ${country.tradeTypes.join('/')} only`);

    let periods: Period[];
    try {
      periods = periodRange(toPeriod(start), toPeriod(end));
    } catch (err: any) {
      throw badRequest(err.message);
    }
    if (periods.length > MAX_MONTHS) throw badRequest(`Range covers ${periods.length} months; the limit is ${MAX_MONTHS}.`);
    if (periods[periods.length - 1] > periodOfDate(new Date())) throw badRequest(`${periods[periods.length - 1]} is in the future; pick months up to this one.`);
    const startPeriod = (await db.startPeriodOverride(country.code)) ?? country.startPeriod;
    if (startPeriod && periods[0] < startPeriod) throw badRequest(`${country.name} has data from ${startPeriod} onwards; pick months from then.`);

    const { retryMaxAttempts, retryDelayMs } = settingsService.get();
    const signal = AbortSignal.timeout(2 * 60_000);
    const flows = tradeType === 'ALL' ? country.tradeTypes : [tradeType];
    const out: SourceMonth[] = [];
    // One after another: the source's list is read once and then answered from memory
    for (const period of periods) {
      for (const flow of flows) {
        const files = await withRetry(() => country.sourceFiles.list(period, flow, signal), retryMaxAttempts, country.retryDelayMs ?? retryDelayMs, signal);
        out.push({ period, flow, files });
      }
    }
    return out;
  },
};
