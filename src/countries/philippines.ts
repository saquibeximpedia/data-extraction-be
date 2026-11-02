import { Country, YearFile } from './country.types';

const SITE = 'https://openstat.psa.gov.ph';
const LISTING_URL = `${SITE}/Database/Economic-and-Financial-Statistics/Trade-International-Merchandise-and-Domestic/Trade-Data-Downloads`;
const FILES = `${SITE}/Portals/0/files/IMTS`;

/**
 * Tables 1.1E (exports) and 2.1E (imports), PSCC2022, from 2024. Earlier years are in other
 * tables (1.1A–D, 2.1A–D) named differently, so they are left to the listing page.
 * The names keep PSA's double space after the table number.
 */
const TABLES = [
  { flow: 'Exports', folder: 'Export', name: 'TABLE 1.1E  VALUE AND VOLUME OF PHILIPPINE EXPORTS BY COMMODITY AND COUNTRY OF DESTINATION' },
  { flow: 'Imports', folder: 'Import', name: 'TABLE 2.1E  VALUE AND VOLUME OF PHILIPPINE IMPORTS BY COMMODITY AND COUNTRY OF ORIGIN' },
];
const FORMATS = [
  { label: 'Excel', folder: 'excel', ext: 'xlsx' },
  { label: 'CSV', folder: 'csv', ext: 'csv' },
];

// Only spaces are escaped, so the {YYYY} and {MONTH} placeholders survive. PSA's links also carry
// a ?ver= cache tag that changes per file; the files are served without it.
const fileUrl = (folder: string, format: string, name: string) => `${FILES}/${folder}/${format}/${name}`.replace(/ /g, '%20');

const files: YearFile[] = TABLES.flatMap((table) =>
  FORMATS.map((format) => ({
    label: `${table.flow} · ${format.label}`,
    yearTemplate: fileUrl(table.folder, format.folder, `${table.name} (JANUARY - DECEMBER {YYYY}).${format.ext}`),
    partialTemplate: fileUrl(table.folder, format.folder, `${table.name} (JANUARY - {MONTH} {YYYY}) PRELIMINARY.${format.ext}`),
  }))
);

const source = {
  name: 'PSA OpenSTAT: Downloadable Trade Data (IMTS)',
  url: LISTING_URL,
  endpoint: `${FILES}/{Export|Import}/{excel|csv}/TABLE {1.1E|2.1E}  VALUE AND VOLUME OF PHILIPPINE … ({months} {YYYY}).{xlsx|csv}`,
  method:
    'Direct links to PSA’s yearly files, opened in your browser; the extraction service downloads nothing (the site is behind a Cloudflare check that only browsers pass). ' +
    'The current year’s file covers January to the latest month and is renamed as months are added.',
  output: 'One file per flow and year: value and volume of Philippine exports or imports by commodity (PSCC2022) and partner country.',
};

/** PSA OpenSTAT, download-only: links to the yearly IMTS files */
export const philippines: Country = {
  code: 'PHL',
  name: 'Philippines',
  source,
  bulkDownload: {
    description:
      'PSA’s yearly trade files, straight from OpenSTAT (nothing is fetched by the extraction service): value and volume of exports and imports ' +
      'by commodity and partner country, as Excel or CSV. A year’s file holds all its months; the current year’s file is preliminary.',
    per: 'year',
    files,
    listingUrl: LISTING_URL,
    source,
  },
  // The January–September 2026 files were up by 30 October 2026 (admins can change it)
  lagMonths: 1,
  publishDay: 28,
  startPeriod: '2024-01',
  tradeTypes: ['IMPORT', 'EXPORT'],
  hsCodeHint: 'Download-only: the files cover every commodity (11-digit AHTN-based codes) and partner country.',
};
