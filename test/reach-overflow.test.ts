import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

type Page = {
  total: number;
  creators: Array<{ id: string; latest_reach: number }>;
};

// Somas de views acima de Number.MAX_SAFE_INTEGER não podem derrubar a
// listagem: o SQLite não entrega inteiro fora da faixa segura para o Node.
function overflowApp() {
  const db = openDatabase(":memory:");
  db.exec(`
    INSERT INTO campaigns VALUES ('cmp_big', 'Grande', '["beleza"]');
    INSERT INTO creators VALUES
      ('crt_soma', 'Soma grande', '["beleza"]', ''),
      ('crt_unica', 'Métrica grande', '["beleza"]', ''),
      ('crt_normal', 'Normal', '["beleza"]', '');
    INSERT INTO social_accounts VALUES
      ('acc_s1', 'crt_soma', 'instagram'),
      ('acc_s2', 'crt_soma', 'tiktok'),
      ('acc_u1', 'crt_unica', 'instagram'),
      ('acc_n1', 'crt_normal', 'instagram');
  `);
  const insertMetric = db.prepare("INSERT INTO metrics VALUES (?, ?, ?, '2026-05-30T00:00:00.000Z', '')");
  insertMetric.run("met_s1", "acc_s1", Number.MAX_SAFE_INTEGER);
  insertMetric.run("met_s2", "acc_s2", Number.MAX_SAFE_INTEGER);
  insertMetric.run("met_u1", "acc_u1", 2n ** 60n);
  insertMetric.run("met_n1", "acc_n1", 42);
  return createApp(db);
}

describe("alcance com somas acima de 2^53", () => {
  it("responde 200 e ordena pelo alcance", async () => {
    const res = await overflowApp().request("/campaigns/cmp_big/creators");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Page;
    expect(body.total).toBe(3);
    expect(body.creators.map((creator) => [creator.id, creator.latest_reach])).toEqual([
      ["crt_unica", 2 ** 60],
      ["crt_soma", Number.MAX_SAFE_INTEGER * 2],
      ["crt_normal", 42],
    ]);
  });

  it("mantém inteiros pequenos sem casa decimal no JSON", async () => {
    const res = await overflowApp().request("/campaigns/cmp_big/creators");
    expect(await res.text()).toContain('"latest_reach":42,');
  });
});
