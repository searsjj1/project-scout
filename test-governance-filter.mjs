// Quick test: verify governance body regex blocks Police Commission etc.
const govBody = /^([\w\s.'&\u2019]+\s+)?(commission|committee|council|board|authority|task\s*force|advisory\s*(board|committee|group|panel)|work\s*(group|session)|subcommittee|caucus)(\s+(of|for|on)\s+[\w\s.'&\u2019]+)?(\s+(meeting|agenda|minutes|session|hearing|workshop|retreat|report|update))?$/i;

const hasProjectWord = (lo) => /\b(renovation|construction|expansion|addition|replacement|modernization|design|facility|building|project|bond|capital|rfq|rfp|solicitation)\b/i.test(lo);

const tests = [
  ['Police Commission', true],
  ['Police Commission Meeting', true],
  ['Planning Commission', true],
  ['City Council', true],
  ['Board of Supervisors', true],
  ['Parks and Recreation Board', true],
  ['Historic Preservation Commission', true],
  ['Zoning Board of Appeals', true],
  ['Tourism Advisory Committee', true],
  ['Police Station Renovation', false],       // has project word
  ['Police Commission Capital Project', false], // has project word
  ['Fire Commission Building Addition', false], // has project word
  ['Courthouse Renovation Project', false],     // doesn't match govBody
  ['Greater Missoula Downtown Master Plan', false], // doesn't match govBody
  ['Redevelopment of the Former Library Block', false],
  ['West Broadway River Corridor Plan', false],
];

let passed = 0, failed = 0;
for (const [title, expectBlock] of tests) {
  const lo = title.toLowerCase();
  const matchesGov = govBody.test(lo.trim());
  const hasProj = hasProjectWord(lo);
  const wouldBlock = matchesGov && !hasProj;
  const ok = wouldBlock === expectBlock;
  console.log(`  ${ok ? '✅' : '❌'} ${wouldBlock ? 'BLOCKED' : 'ALLOWED'} — "${title}"`);
  if (ok) passed++; else failed++;
}
console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed}/${passed+failed} tests passed`);
process.exit(failed > 0 ? 1 : 0);
