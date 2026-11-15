// Lists GMEET NDI sources on the network and grabs one frame from each.
// Usage: node scripts/verify-ndi.js [filter=GMEET] [waitMs=3000]
const ndi = require('../build/Release/gmeet_iso_ndi.node');
const filter = process.argv[2] || 'GMEET';
const wait = Number(process.argv[3] || 3000);
console.log('NDI:', ndi.load().version);
const sources = ndi.findSources(wait).filter((s) => s.includes(filter));
console.log(`Found ${sources.length} source(s) matching "${filter}":`);
for (const s of sources) {
  const f = ndi.receiveFrame(s, 5000);
  console.log(`  ${s}  ->  ${f ? `${f.width}x${f.height} ${f.fourcc} avgLuma=${f.avgLuma?.toFixed(1)}` : 'NO FRAME'}`);
}
