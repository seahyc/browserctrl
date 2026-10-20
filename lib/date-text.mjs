// Calendars name a day in many ways: "Friday, 16 October 2026", "Oct 16, 2026",
// "16, Friday, October 2026. Available", "2026-10-16", "10/16/2026". One parser serves
// both sides: the step's date (in Node) and every day cell's label (in the page).
// Month names in the languages calendars most often use (with the genitive forms Slavic
// dates take: "16 октября"). Index + 1 is the month.
export const MONTHS = [
  'january januar janvier enero janeiro gennaio januari styczeń stycznia ocak январь января січень січня',
  'february februar février febrero fevereiro febbraio februari luty lutego şubat февраль февраля лютий лютого',
  'march märz mars marzo março maart marts maret marzec marca mart март марта березень березня',
  'april avril abril aprile kwiecień kwietnia nisan апрель апреля квітень квітня',
  'may mai mayo maio maggio mei maj maja mayıs май мая травень травня',
  'june juni juin junio junho giugno czerwiec czerwca haziran июнь июня червень червня',
  'july juli juillet julio julho luglio lipiec lipca temmuz июль июля липень липня',
  'august august août agosto augustus augusti agustus sierpień sierpnia ağustos август августа серпень серпня',
  'september septembre septiembre setembro settembre wrzesień września eylül сентябрь сентября вересень вересня',
  'october oktober octobre octubre outubro ottobre październik października ekim октябрь октября жовтень жовтня',
  'november novembre noviembre novembro listopad listopada kasım ноябрь ноября листопад листопада',
  'december dezember décembre diciembre dezembro dicembre desember grudzień grudnia aralık декабрь декабря грудень грудня',
].map(names => names.split(' '));
// The month a word names (1-12), or null: a full name, or the start of one at least three
// letters long ("okt", "sept.", "juil"). "Settings" is not the start of any of them.
export function monthNumber(word) {
  const w = String(word || '').toLowerCase().replace(/\.$/, '');
  if (!/^\p{L}{3,14}$/u.test(w)) return null;
  const i = MONTHS.findIndex(names => names.some(n => n.startsWith(w)));
  return i < 0 ? null : i + 1;
}
export const isoDate = ({ y, m, d }) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
// A whole date (year, month and day) in text, or null. A month word with a day before or
// after it and a year after ("16 October 2026", "Oct 16, 2026", "16 de octubre de 2026",
// "Friday, 16 October 2026"), year-first numbers (2026-10-16, 2026年10月16日), day-first
// with dots (16.10.2026), and unambiguous numeric month/day/year.
export function parseDateText(text) {
  const raw = String(text || '').toLowerCase();
  const ok = (y, m, d) => {
    if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
    const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return d <= days[m - 1] ? { y, m, d } : null;
  };
  let r;
  if ((r = raw.match(/(?<!\d)(\d{4})\s*[年년]\s*(\d{1,2})\s*[月월]\s*(\d{1,2})(?!\d)/))) return ok(+r[1], +r[2], +r[3]);
  if ((r = raw.match(/(?<!\d)(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?!\d)/))) return ok(+r[1], +r[2], +r[3]);
  if ((r = raw.match(/(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/))) return +r[1] > 12 ? ok(+r[3], +r[2], +r[1]) : null;
  if ((r = raw.match(/(?<!\d)(\d{1,2}) tháng (\d{1,2}),? (?:năm )?(\d{4})(?!\d)/))) return ok(+r[3], +r[2], +r[1]);
  // Ordinal endings and joining words are not part of the date: 16th, 1er, "de", "of".
  const tok = raw.replace(/(\d)(st|nd|rd|th|er|e|º|ª)(?![\p{L}])/gu, '$1').replace(/[,.]/g, ' ').split(/\s+/)
    .filter(t => t && !['de', 'del', 'di', 'du', 'van', 'of', 'the', 'г', 'года'].includes(t));
  const day = (t) => /^\d{1,2}$/.test(t || '');
  const year = (t) => /^\d{4}$/.test(t || '');
  for (let i = 0; i < tok.length; i++) {
    const m = monthNumber(tok[i]);
    if (!m) continue;
    if (day(tok[i + 1]) && year(tok[i + 2])) return ok(+tok[i + 2], m, +tok[i + 1]);
    // Day, maybe a weekday or two, then the month and year.
    if (year(tok[i + 1])) for (const j of [i - 1, i - 2, i - 3]) if (j >= 0 && day(tok[j])) return ok(+tok[i + 1], m, +tok[j]);
  }
  // Numeric month/day and day/month forms are safe only when one part cannot be a month.
  if ((r = raw.match(/(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/))) {
    if (+r[2] > 12) return ok(+r[3], +r[1], +r[2]);
    if (+r[1] > 12) return ok(+r[3], +r[2], +r[1]);
  }
  return null;
}

