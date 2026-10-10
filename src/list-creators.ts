import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { id: string; niches_json: string };
type CountRow = { n: number };
type PageRow = CreatorMatch & { total: number };

// Nichos da campanha (?1) lidos uma vez, e o score de cada criador como a
// quantidade de pares iguais entre os nichos dele e os da campanha, como o
// laço duplo da versão anterior. Criador sem nicho em comum não entra.
const MATCHED_CTES = `
  campaign_niches AS MATERIALIZED (
    SELECT value FROM json_each(?1) WHERE type = 'text'
  ),
  matched AS (
    SELECT c.id, c.name, COUNT(*) AS niche_score
    FROM creators AS c
    JOIN json_each(c.niches_json) AS cn
    JOIN campaign_niches AS kn ON kn.value = cn.value
    WHERE cn.type = 'text'
    GROUP BY c.id
  )`;

// Soma, por conta do criador, as views da métrica mais recente
// (maior captured_at, empate pelo maior id). Conta sem métrica não soma.
// TOTAL soma em ponto flutuante e devolve 0 sem linhas, então uma soma acima
// de 2^53 não vira inteiro que o Node se recusa a ler. Abaixo disso o valor
// é exato e sai no JSON sem casa decimal.
const LATEST_REACH = `(
  SELECT TOTAL((
    SELECT mt.views
    FROM metrics AS mt
    WHERE mt.account_id = sa.id
    ORDER BY mt.captured_at DESC, mt.id DESC
    LIMIT 1
  ))
  FROM social_accounts AS sa
  WHERE sa.creator_id = m.id
)`;

const COUNT_SQL = `
  WITH ${MATCHED_CTES}
  SELECT COUNT(*) AS n FROM matched
`;

const PAGE_SQL = `
  WITH ${MATCHED_CTES},
  ranked AS (
    SELECT
      m.id,
      m.name,
      m.niche_score,
      ${LATEST_REACH} AS latest_reach,
      COUNT(*) OVER () AS total
    FROM matched AS m
    ORDER BY m.niche_score DESC, latest_reach DESC, m.id ASC
    LIMIT ?2 OFFSET ?3
  )
  SELECT
    r.id,
    r.name,
    r.niche_score,
    r.latest_reach,
    r.total,
    (
      SELECT COUNT(*)
      FROM deliveries AS d
      WHERE d.creator_id = r.id AND d.delivered_at >= ?4
    ) AS deliveries_90d
  FROM ranked AS r
  ORDER BY r.niche_score DESC, r.latest_reach DESC, r.id ASC
`;

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(
    db,
    "SELECT id, niches_json FROM campaigns WHERE id = ?",
    input.campaignId,
  );
  if (!campaign) return null;

  const rows = await all<PageRow>(
    db,
    PAGE_SQL,
    campaign.niches_json,
    input.limit,
    input.offset,
    deliveriesSince(),
  );

  // O total vem da janela na própria página. Só quando o offset passa do fim
  // a página vem vazia e é preciso contar à parte.
  const first = rows[0];
  const total = first
    ? first.total
    : (await get<CountRow>(db, COUNT_SQL, campaign.niches_json))?.n;

  return {
    campaign_id: input.campaignId,
    total: Number(total ?? 0),
    creators: rows.map((row) => ({
      id: row.id,
      name: row.name,
      niche_score: Number(row.niche_score),
      latest_reach: Number(row.latest_reach),
      deliveries_90d: Number(row.deliveries_90d),
    })),
  };
}
