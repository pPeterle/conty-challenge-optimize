import type { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { deliveriesSince } from "../src/clock.ts";
import { getQueryCount, openDatabase, resetQueryCount } from "../src/db.ts";

type Creator = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};
type Page = { campaign_id: string; total: number; creators: Creator[] };

const CAMPAIGN = "cmp_vol";
const CREATORS = 2500;
const PAGE_SIZE = 20;

function rng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

// Base com empates de propósito: poucos valores de views, captured_at repetido
// na mesma conta, criadores sem conta, contas sem métrica, entregas no limite
// de 90 dias e 1 ms antes, e ids fora da ordem de inserção.
function seedWithTies(db: DatabaseSync): void {
  const rand = rng(2026);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const niches = ["beleza", "moda", "tech", "games"];
  const views = [0, 100, 100, 500, 1000];
  const capturedAt = ["2026-05-30T00:00:00.000Z", "2026-05-29T00:00:00.000Z", "2026-05-01T00:00:00.000Z"];
  const deliveredAt = [
    "2026-03-03T12:00:00.000Z",
    "2026-03-03T11:59:59.999Z",
    "2026-05-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  ];

  const insertCreator = db.prepare("INSERT INTO creators VALUES (?, ?, ?, '')");
  const insertAccount = db.prepare("INSERT INTO social_accounts VALUES (?, ?, 'instagram')");
  const insertMetric = db.prepare("INSERT INTO metrics VALUES (?, ?, ?, ?, '')");
  const insertDelivery = db.prepare("INSERT INTO deliveries VALUES (?, ?, ?)");

  db.exec("BEGIN");
  db.prepare("INSERT INTO campaigns VALUES (?, ?, ?)").run(CAMPAIGN, "Volume", JSON.stringify(["beleza", "moda"]));
  for (let i = 0; i < CREATORS; i += 1) {
    const id = `crt_${String(Math.floor(rand() * 1e9)).padStart(9, "0")}_${i}`;
    insertCreator.run(id, `Criador ${i}`, JSON.stringify(niches.filter(() => rand() < 0.45)));
    const accounts = Math.floor(rand() * 4);
    for (let a = 0; a < accounts; a += 1) {
      const accountId = `${id}_acc${a}`;
      insertAccount.run(accountId, id);
      const metrics = Math.floor(rand() * 4);
      for (let m = 0; m < metrics; m += 1) {
        insertMetric.run(`${accountId}_met${Math.floor(rand() * 1e6)}_${m}`, accountId, pick(views), pick(capturedAt));
      }
    }
    const deliveries = Math.floor(rand() * 4);
    for (let d = 0; d < deliveries; d += 1) insertDelivery.run(`${id}_del${d}`, id, pick(deliveredAt));
  }
  db.exec("COMMIT");
}

// Referência ingênua escrita a partir da regra do README, lendo as tabelas
// direto (fora de src/db.ts, para não entrar na contagem de queries).
function reference(db: DatabaseSync): Creator[] {
  const campaign = db.prepare("SELECT niches_json FROM campaigns WHERE id = ?").get(CAMPAIGN) as {
    niches_json: string;
  };
  const campaignNiches = JSON.parse(campaign.niches_json) as string[];
  const creators = db.prepare("SELECT id, name, niches_json FROM creators").all() as Array<{
    id: string;
    name: string;
    niches_json: string;
  }>;
  const accounts = db.prepare("SELECT id, creator_id FROM social_accounts").all() as Array<{
    id: string;
    creator_id: string;
  }>;
  const metrics = db.prepare("SELECT id, account_id, views, captured_at FROM metrics").all() as Array<{
    id: string;
    account_id: string;
    views: number;
    captured_at: string;
  }>;
  const deliveries = db.prepare("SELECT creator_id, delivered_at FROM deliveries").all() as Array<{
    creator_id: string;
    delivered_at: string;
  }>;

  const latestByAccount = new Map<string, (typeof metrics)[number]>();
  for (const metric of metrics) {
    const current = latestByAccount.get(metric.account_id);
    const newer =
      !current ||
      metric.captured_at > current.captured_at ||
      (metric.captured_at === current.captured_at && metric.id > current.id);
    if (newer) latestByAccount.set(metric.account_id, metric);
  }

  const since = deliveriesSince();
  const result: Creator[] = [];
  for (const creator of creators) {
    const creatorNiches = JSON.parse(creator.niches_json) as string[];
    let nicheScore = 0;
    for (const a of campaignNiches) for (const b of creatorNiches) if (a === b) nicheScore += 1;
    if (nicheScore === 0) continue;
    let reach = 0;
    for (const account of accounts) {
      if (account.creator_id === creator.id) reach += latestByAccount.get(account.id)?.views ?? 0;
    }
    const recent = deliveries.filter((d) => d.creator_id === creator.id && d.delivered_at >= since).length;
    result.push({
      id: creator.id,
      name: creator.name,
      niche_score: nicheScore,
      latest_reach: reach,
      deliveries_90d: recent,
    });
  }

  return result.sort((left, right) => {
    if (right.niche_score !== left.niche_score) return right.niche_score - left.niche_score;
    if (right.latest_reach !== left.latest_reach) return right.latest_reach - left.latest_reach;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

describe("listagem em volume maior que o seed, com empates", () => {
  let app: ReturnType<typeof createApp>;
  let expected: Creator[];

  beforeAll(() => {
    const db = openDatabase(":memory:");
    seedWithTies(db);
    expected = reference(db);
    app = createApp(db);
  });

  async function page(offset: number, limit = PAGE_SIZE): Promise<{ body: Page; queries: number }> {
    resetQueryCount();
    const res = await app.request(`/campaigns/${CAMPAIGN}/creators?limit=${limit}&offset=${offset}`);
    const queries = getQueryCount();
    expect(res.status).toBe(200);
    return { body: (await res.json()) as Page, queries };
  }

  it("a base tem empates de score e alcance para o desempate por id decidir", () => {
    const keys = expected.map((c) => `${c.niche_score}:${c.latest_reach}`);
    expect(new Set(keys).size).toBeLessThan(keys.length / 10);
  });

  it("todas as páginas batem com a referência e o total não muda", async () => {
    for (let offset = 0; offset < expected.length; offset += PAGE_SIZE) {
      const { body } = await page(offset);
      expect(body).toEqual({
        campaign_id: CAMPAIGN,
        total: expected.length,
        creators: expected.slice(offset, offset + PAGE_SIZE),
      });
    }
  });

  it("página que cruza o fim devolve só o que sobra", async () => {
    const offset = expected.length - 5;
    const { body } = await page(offset);
    expect(body.total).toBe(expected.length);
    expect(body.creators).toEqual(expected.slice(offset));
  });

  it("página além do fim mantém o formato e o total", async () => {
    for (const offset of [expected.length, expected.length + 1, 1_000_000]) {
      const { body, queries } = await page(offset);
      expect(body).toEqual({ campaign_id: CAMPAIGN, total: expected.length, creators: [] });
      expect(queries).toBeLessThanOrEqual(8);
    }
  });

  it("a página de 20 fica dentro do teto de queries com mais de 2000 criadores", async () => {
    const { queries } = await page(0);
    expect(queries).toBeLessThanOrEqual(8);
  });
});
