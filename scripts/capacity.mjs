import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Decimal GB/TB and a 30-day month. Rates are operator inputs, not vendor quotes.
export function estimateCapacity(input) {
  const fields = ['monthlyUsers', 'watchHoursPerUser', 'averageMbps', 'peakMultiplier',
    'deliveryUsdPerGB', 'storedTB', 'storageUsdPerTB', 'gpuHours', 'gpuUsdPerHour',
    'serversUsd', 'operationsUsd', 'contingencyPercent'];
  for (const key of fields) {
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0) {
      throw new Error(`${key} must be a finite nonnegative number`);
    }
  }
  if (input.peakMultiplier < 1) throw new Error('peakMultiplier must be at least 1');
  const watchHours = input.monthlyUsers * input.watchHoursPerUser;
  const deliveryGB = watchHours * input.averageMbps * 0.45;
  const averageConcurrentViewers = watchHours / 720;
  const costs = {
    delivery: deliveryGB * input.deliveryUsdPerGB,
    storage: input.storedTB * input.storageUsdPerTB,
    encoding: input.gpuHours * input.gpuUsdPerHour,
    servers: input.serversUsd,
    operations: input.operationsUsd,
  };
  const subtotal = Object.values(costs).reduce((sum, n) => sum + n, 0);
  const contingency = subtotal * input.contingencyPercent / 100;
  const total = subtotal + contingency;
  const output = {
    assumptions: input,
    traffic: { watchHours, deliveryGB, averageConcurrentViewers,
      peakConcurrentViewers: averageConcurrentViewers * input.peakMultiplier,
      peakGbps: averageConcurrentViewers * input.peakMultiplier * input.averageMbps / 1000 },
    monthlyUsd: { ...costs, subtotal, contingency, total },
    costPerWatchedHourUsd: watchHours ? total / watchHours : null,
    exclusions: ['Creator payouts', 'Payment fees', 'Taxes', 'Marketing', 'Hardware purchases',
      'Any staffing, live production, origin egress, or other costs not included in your inputs'],
  };
  if (!Number.isFinite(total) || Object.values(output.traffic).some((n) => !Number.isFinite(n))) {
    throw new Error('Inputs exceed supported numeric range');
  }
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv[2]) throw new Error('Usage: npm run plan:capacity -- deploy/capacity.pilot.json');
    console.log(JSON.stringify(estimateCapacity(JSON.parse(await readFile(process.argv[2], 'utf8'))), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
