import { Time } from "./ui/components";
export async function logoutReceipts(db: D1Database, user: string) {
  const { results } = await db
    .prepare(
      "SELECT id,name,status,attempts,created_at FROM logout_deliveries WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 30",
    )
    .bind(user)
    .all<{ id: string; name: string; status: string; attempts: number; created_at: number }>();
  if (!results.length) return null;
  return (
    <section class="card card-body">
      <h2>App sign-out delivery</h2>
      <p>
        Acknowledged means the app accepted the sign-out message. Only the app can confirm its
        session ended.
      </p>
      <ul class="list">
        {results.map((r) => (
          <li key={r.id}>
            {r.name} · {r.status} · {r.attempts} {r.attempts === 1 ? "attempt" : "attempts"} ·{" "}
            <Time ts={r.created_at} />
          </li>
        ))}
      </ul>
    </section>
  );
}
