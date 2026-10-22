import { Country, CountrySource, findCountry, isEnabled, listCountries, missingConfig } from '../countries';
import { TradeFlow } from '../types';
import { badRequest, conflict, notFound } from '../utils/errors';
import { recentPublishedPeriods } from '../utils/period';
import { hsCodesService } from './hs-codes.service';
import { CountryConfig, ledgerService } from './ledger.service';

/**
 * A country as users see it.
 * kind 'api'    - built into the code (src/countries): extracted by the backend
 * kind 'manual' - added by an admin: the source publishes files (e.g. Excel) that users
 *                 download from its website and upload here; nothing is extracted
 */
export interface CountryView {
  code: string;
  name: string;
  kind: 'api' | 'manual';
  enabled: boolean;
  missingConfig: string[];
  source: CountrySource;
  notes: string;
  lagMonths: number;
  defaultLagMonths: number;
  publishDay: number;
  tradeTypes: TradeFlow[];
  hsCodeHint: string;
  hsCodeCount: number;
  testHsCodeCount: number;
  /** The latest months the source should have out by now, oldest first */
  recentPeriods: string[];
  /** Months users marked as completed, oldest first */
  completedMonths: string[];
  latestCompleted: string | null;
  lastExtractedAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Fields an admin can edit */
export type CountryPatch = Partial<Pick<CountryConfig, 'name' | 'sourceName' | 'sourceUrl' | 'endpoint' | 'method' | 'output' | 'notes' | 'lagMonths' | 'publishDay'>>;

const MANUAL_METHOD = 'The source publishes files; download them from its website and upload them here.';
const MANUAL_OUTPUT = 'The files exactly as downloaded from the source.';

function build(
  base: Country | null,
  config: CountryConfig | null,
  completed: string[],
  lastExtractedAt: string | undefined
): CountryView {
  const code = base?.code ?? config!.code;
  const lagMonths = config?.lagMonths ?? base?.lagMonths ?? 1;
  const publishDay = config?.publishDay ?? base?.publishDay ?? 1;
  const source: CountrySource = {
    name: config?.sourceName || base?.source.name || '',
    url: config?.sourceUrl || base?.source.url || '',
    endpoint: config?.endpoint ?? base?.source.endpoint ?? '',
    method: config?.method || base?.source.method || MANUAL_METHOD,
    output: config?.output || base?.source.output || MANUAL_OUTPUT,
  };
  return {
    code,
    name: config?.name || base?.name || code,
    kind: base ? 'api' : 'manual',
    enabled: base ? isEnabled(base) : true,
    missingConfig: base ? missingConfig(base) : [],
    source,
    notes: config?.notes ?? '',
    lagMonths,
    defaultLagMonths: base?.lagMonths ?? lagMonths,
    publishDay,
    tradeTypes: base?.tradeTypes ?? [],
    hsCodeHint: base?.hsCodeHint ?? '',
    hsCodeCount: base ? hsCodesService.getSaved(code, 'complete').length : 0,
    testHsCodeCount: base && hsCodesService.hasTestFile(code) ? hsCodesService.getSaved(code, 'test').length : 0,
    recentPeriods: recentPublishedPeriods(lagMonths, publishDay, 12),
    completedMonths: completed,
    latestCompleted: completed[completed.length - 1] ?? null,
    lastExtractedAt: lastExtractedAt ?? null,
    updatedAt: config?.updatedAt ?? null,
    updatedBy: config?.updatedBy ?? null,
  };
}

export const countryService = {
  list(): CountryView[] {
    const configs = new Map(ledgerService.listCountryConfigs().map((c) => [c.code, c]));
    const completed = ledgerService.listCompletedMonths();
    const lastRuns = ledgerService.lastExtractionByCountry();
    const months = (code: string) => (completed.get(code) ?? []).map((m) => m.period);

    const builtIn = listCountries().map((c) => build(c, configs.get(c.code) ?? null, months(c.code), lastRuns.get(c.code)));
    const manual = [...configs.values()]
      .filter((c) => c.kind === 'manual' && !findCountry(c.code))
      .map((c) => build(null, c, months(c.code), undefined));
    return [...builtIn, ...manual].sort((a, b) => a.name.localeCompare(b.name));
  },

  get(code: string): CountryView {
    const view = this.list().find((c) => c.code === code.toUpperCase());
    if (!view) throw notFound(`Unknown country ${code.toUpperCase()}`);
    return view;
  },

  /** Admin: edits a country's details (a built-in source's are stored as overrides) */
  update(code: string, patch: CountryPatch, by: string): CountryView {
    const current = this.get(code);
    const existing = ledgerService.getCountryConfig(current.code);
    ledgerService.saveCountryConfig({ ...(existing ?? {}), ...patch, code: current.code, kind: current.kind }, by);
    return this.get(current.code);
  },

  /** Admin: adds a download-only country */
  createManual(input: CountryPatch & { code: string; name: string; sourceUrl: string }, by: string): CountryView {
    const code = input.code.toUpperCase();
    if (findCountry(code) || ledgerService.getCountryConfig(code)) throw conflict(`${code} already exists`);
    ledgerService.saveCountryConfig({ ...input, code, kind: 'manual' }, by);
    return this.get(code);
  },

  /** Admin: removes a download-only country (its uploaded files stay until deleted from Files) */
  removeManual(code: string): void {
    const view = this.get(code);
    if (view.kind !== 'manual') throw badRequest(`${view.code} is built in and cannot be deleted`);
    ledgerService.deleteCountryConfig(view.code);
  },
};
