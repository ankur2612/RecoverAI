import { Rng } from '../shared/rng.ts';
import { SCENARIOS, SCENARIO_WEIGHTS, scenarioByKey, type Scenario } from './scenarios.ts';
import type {
  Currency,
  Customer,
  GroundTruth,
  Merchant,
  Payment,
  SyntheticDataset,
  SyntheticRecord,
} from '../shared/types.ts';

export interface GeneratorOptions {
  seed: number;
  recordCount: number;
  /** Fraction of records held out for evaluation (PRD section 17). */
  evalSplit: number;
  /** Mean transaction value in minor units. */
  avgTransactionValue: number;
  /** Probability a payment reuses an existing customer rather than a new one. */
  customerRepeatRate: number;
  merchantCount?: number;
  /**
   * Fixed instant the dataset is generated relative to, as an ISO string.
   * Pinned by default so that a given seed produces byte-identical output on
   * every run — using the wall clock here would break reproducibility.
   */
  now?: string;
  /** Optional override of scenario sampling weights, e.g. for stress datasets. */
  weightOverrides?: Readonly<Record<string, number>>;
}

/** The reference instant for the default dataset. */
export const DEFAULT_NOW = '2026-08-22T10:30:00.000Z';

const MERCHANT_NAMES = [
  'Nimbus Retail',
  'Kettle & Co',
  'Vertex Fitness',
  'Saffron Foods',
  'Lumen Media',
  'Harbour Books',
  'Peak Analytics',
  'Indigo Travel',
] as const;

const FIRST_NAMES = [
  'Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Ananya', 'Vikram', 'Ishita',
  'Arjun', 'Nisha', 'Farhan', 'Priya', 'Dev', 'Sana', 'Yash', 'Tara',
] as const;

const LAST_NAMES = [
  'Sharma', 'Iyer', 'Khan', 'Reddy', 'Bose', 'Nair', 'Gupta', 'Menon',
  'Chopra', 'Das', 'Rao', 'Verma',
] as const;

/** Zero-padded sequential id, e.g. idFor('pay', 7) -> 'pay_00007'. */
function idFor(prefix: string, index: number, width = 5): string {
  return `${prefix}_${String(index).padStart(width, '0')}`;
}

/**
 * Round to a realistic price point. Merchants rarely charge ₹2,473.19, so we
 * snap to values ending in 00 or 99 paise — this also keeps every amount an
 * integer in minor units.
 */
function roundToPricePoint(amountMinor: number, rng: Rng): number {
  const rupees = Math.max(1, Math.round(amountMinor / 100));
  return rng.bool(0.5) ? rupees * 100 : rupees * 100 - 1;
}

function buildMerchants(rng: Rng, count: number, now: Date): Merchant[] {
  const names = rng.shuffle(MERCHANT_NAMES).slice(0, count);
  return names.map((name, index) => ({
    id: idFor('merchant', index + 1, 3),
    name,
    currency: 'INR' as Currency,
    // Merchants pre-date the payment window.
    createdAt: new Date(now.getTime() - (365 - index * 17) * 86_400_000),
  }));
}

function buildCustomer(rng: Rng, index: number, merchant: Merchant, now: Date): Customer {
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  const id = idFor('cust', index, 5);
  return {
    id,
    merchantId: merchant.id,
    name: `${first} ${last}`,
    // Synthetic addresses on example.com — never a routable mailbox.
    email: `${first.toLowerCase()}.${last.toLowerCase()}.${index}@example.com`,
    createdAt: new Date(now.getTime() - rng.int(1, 400) * 86_400_000),
  };
}

function amountForScenario(rng: Rng, scenario: Scenario, avgValue: number): number {
  const [minMul, maxMul] = scenario.amountMultiplier;
  const multiplier = rng.float(minMul, maxMul);
  // Log-normal-ish spread around the scenario's band, then snapped to a price
  // point. Clamped so no amount is non-positive or absurdly large.
  const raw = rng.normalClamped(
    avgValue * multiplier,
    avgValue * multiplier * 0.25,
    avgValue * minMul * 0.5,
    avgValue * maxMul * 1.5,
  );
  return roundToPricePoint(raw, rng);
}

function groundTruthFor(rng: Rng, scenario: Scenario): GroundTruth {
  const [minP, maxP] = scenario.recoveryProbability;
  return {
    classification: scenario.classification,
    recoverable: scenario.recoverable,
    // Rounded to 4dp: keeps JSON output stable across platforms.
    recoveryProbability: Number(rng.float(minP, maxP).toFixed(4)),
    idealAction: scenario.idealAction,
  };
}

/**
 * Generate a deterministic synthetic dataset.
 *
 * The same options always produce the same dataset, byte for byte. Callers
 * must not introduce wall-clock time or Math.random anywhere downstream of
 * this function if they depend on that guarantee.
 */
export function generateDataset(options: GeneratorOptions): SyntheticDataset {
  const {
    seed,
    recordCount,
    evalSplit,
    avgTransactionValue,
    customerRepeatRate,
    merchantCount = 4,
    now: nowIso = DEFAULT_NOW,
    weightOverrides,
  } = options;

  if (recordCount < 1) throw new RangeError('recordCount must be at least 1');
  if (evalSplit <= 0 || evalSplit >= 1) throw new RangeError('evalSplit must be between 0 and 1');
  if (merchantCount < 1 || merchantCount > MERCHANT_NAMES.length) {
    throw new RangeError(`merchantCount must be between 1 and ${MERCHANT_NAMES.length}`);
  }

  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) throw new RangeError(`invalid "now" value: ${nowIso}`);

  const rng = new Rng(seed);
  const weights = { ...SCENARIO_WEIGHTS, ...weightOverrides };

  const merchants = buildMerchants(rng, merchantCount, now);
  const customers: Customer[] = [];
  const customersByMerchant = new Map<string, Customer[]>(merchants.map((m) => [m.id, []]));

  const records: SyntheticRecord[] = [];

  for (let i = 1; i <= recordCount; i++) {
    const merchant = rng.pick(merchants);
    const pool = customersByMerchant.get(merchant.id)!;

    // Reuse an existing customer some of the time so that customer payment
    // history is a real signal in the data rather than uniformly empty.
    let customer: Customer;
    if (pool.length > 0 && rng.bool(customerRepeatRate)) {
      customer = rng.pick(pool);
    } else {
      customer = buildCustomer(rng, customers.length + 1, merchant, now);
      customers.push(customer);
      pool.push(customer);
    }

    const scenario = scenarioByKey(rng.weighted(weights));
    const amount = amountForScenario(rng, scenario, avgTransactionValue);
    const ageHours = rng.float(scenario.ageHours[0], scenario.ageHours[1]);
    const createdAt = new Date(now.getTime() - Math.round(ageHours * 3_600_000));

    const failureReason =
      scenario.failureReasons.length > 0 ? rng.pick(scenario.failureReasons) : null;

    const payment: Payment = {
      id: idFor('pay', i),
      merchantId: merchant.id,
      customerId: customer.id,
      orderId: idFor('order', i),
      amount,
      currency: merchant.currency,
      status: scenario.status,
      failureReason,
      attemptCount: rng.int(scenario.attemptCount[0], scenario.attemptCount[1]),
      isSubscription: scenario.isSubscription,
      createdAt,
      // Failed/abandoned payments settle shortly after creation.
      updatedAt: new Date(createdAt.getTime() + rng.int(1, 900) * 1000),
    };

    records.push({
      payment,
      groundTruth: groundTruthFor(rng, scenario),
      // Placeholder; the real split is assigned below.
      split: 'dev',
    });
  }

  assignSplits(records, evalSplit, seed);

  return {
    seed,
    generatedAt: nowIso,
    merchants,
    customers,
    records,
  };
}

/**
 * Assign dev/eval splits stratified by scenario class.
 *
 * A naive random split can leave a rare scenario (e.g. high_value_failure)
 * almost absent from the eval set, which would make its metrics meaningless.
 * Stratifying guarantees each class appears in both splits in proportion.
 *
 * Uses its own Rng derived from the seed so that changing the split fraction
 * does not perturb the payment data generated above.
 */
function assignSplits(records: SyntheticRecord[], evalSplit: number, seed: number): void {
  const rng = new Rng(seed ^ 0x5f3759df);

  const byClass = new Map<string, SyntheticRecord[]>();
  for (const record of records) {
    const key = `${record.groundTruth.classification}:${record.payment.status}`;
    const bucket = byClass.get(key);
    if (bucket === undefined) byClass.set(key, [record]);
    else bucket.push(record);
  }

  // Iterate in sorted key order so bucket processing is deterministic
  // regardless of Map insertion order.
  for (const key of [...byClass.keys()].sort()) {
    const bucket = byClass.get(key)!;
    const shuffled = rng.shuffle(bucket);
    const evalCount = Math.round(shuffled.length * evalSplit);
    shuffled.forEach((record, index) => {
      record.split = index < evalCount ? 'eval' : 'dev';
    });
  }
}

export interface DatasetSummary {
  seed: number;
  totalRecords: number;
  devRecords: number;
  evalRecords: number;
  merchants: number;
  customers: number;
  /** Sum of amounts for every non-captured payment, in minor units. */
  revenueAtRiskMinor: number;
  /** Sum of amounts for payments whose ground truth says recoverable. */
  recoverableRevenueMinor: number;
  byClassification: Record<string, number>;
  byStatus: Record<string, number>;
  byIdealAction: Record<string, number>;
}

/**
 * Descriptive statistics computed from the dataset itself.
 *
 * These are counts of what was actually generated — nothing here is asserted
 * or assumed (PRD section 18: do not fabricate metrics).
 */
export function summariseDataset(dataset: SyntheticDataset): DatasetSummary {
  const byClassification: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byIdealAction: Record<string, number> = {};

  let revenueAtRiskMinor = 0;
  let recoverableRevenueMinor = 0;
  let devRecords = 0;
  let evalRecords = 0;

  for (const { payment, groundTruth, split } of dataset.records) {
    byStatus[payment.status] = (byStatus[payment.status] ?? 0) + 1;
    byIdealAction[groundTruth.idealAction] = (byIdealAction[groundTruth.idealAction] ?? 0) + 1;

    // Only failures carry a diagnosis; captured payments are not classified.
    if (payment.status !== 'captured') {
      byClassification[groundTruth.classification] =
        (byClassification[groundTruth.classification] ?? 0) + 1;
      revenueAtRiskMinor += payment.amount;
      if (groundTruth.recoverable) recoverableRevenueMinor += payment.amount;
    }

    if (split === 'eval') evalRecords++;
    else devRecords++;
  }

  return {
    seed: dataset.seed,
    totalRecords: dataset.records.length,
    devRecords,
    evalRecords,
    merchants: dataset.merchants.length,
    customers: dataset.customers.length,
    revenueAtRiskMinor,
    recoverableRevenueMinor,
    byClassification,
    byStatus,
    byIdealAction,
  };
}

export { SCENARIOS };
