import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

export const isUuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const moscowDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
});

export function createStore(connectionString = process.env.DATABASE_URL) {
  if (!connectionString)
    throw new Error('Запусти npm run dev или укажи DATABASE_URL.');
  const pool = new pg.Pool({
    connectionString,
    max: 6,
    connectionTimeoutMillis: 5000,
  });
  pool.on('error', (error) =>
    console.error('PostgreSQL:', error.code || error.name),
  );
  const query = (sql, args) => pool.query(sql, args);
  const rows = async (sql, args) => (await query(sql, args)).rows;
  const one = async (sql, args) => (await rows(sql, args))[0];
  const owned = "user_id=$1 AND id=$2 AND updated_at>now()-interval '7 days'";
  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    query,
    close: () => pool.end(),
    async init() {
      const schema = await readFile(
        new URL('./schema.sql', import.meta.url),
        'utf8',
      );
      const docs = JSON.parse(
        await readFile(
          new URL('./data/documents.json', import.meta.url),
          'utf8',
        ),
      );
      await transaction(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(271826)');
        await c.query(schema);
        for (const doc of docs)
          await c.query(
            `INSERT INTO documents(id,title,url,topic,version,body,approved)
            VALUES($1,$2,$3,$4,$5,$6,true) ON CONFLICT(id) DO NOTHING`,
            [doc.id, doc.title, doc.url, doc.topic, doc.version, doc.body],
          );
      });
    },
    async cleanup() {
      await query(`DELETE FROM login_sessions WHERE expires_at <= now();
        DELETE FROM confirmations WHERE expires_at <= now();
        DELETE FROM facts WHERE expires_at <= now();
        DELETE FROM conversations WHERE updated_at <= now()-interval '7 days';`);
    },
    register: (username, password) =>
      one(
        `INSERT INTO app_users(id,username,password)
      VALUES($1,$2,$3) ON CONFLICT(username) DO NOTHING RETURNING id,username,role`,
        [randomUUID(), username, password],
      ),
    login: (username, password) =>
      one(
        'SELECT id,username,role FROM app_users WHERE username=$1 AND password=$2',
        [username, password],
      ),
    async issueToken(userId) {
      const token = randomBytes(32).toString('hex');
      await query(
        'INSERT INTO login_sessions(token_hash,user_id) VALUES($1,$2)',
        [tokenHash(token), userId],
      );
      return token;
    },
    actor: (token) =>
      /^[a-f0-9]{64}$/.test(token || '')
        ? one(
            `SELECT u.id,u.username,u.role
      FROM login_sessions s JOIN app_users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now()`,
            [tokenHash(token)],
          )
        : undefined,
    logout: (token) =>
      query('DELETE FROM login_sessions WHERE token_hash=$1', [
        tokenHash(token || ''),
      ]),
    sessions: (userId) =>
      rows(
        `SELECT id,title,updated_at FROM conversations
      WHERE user_id=$1 AND updated_at>now()-interval '7 days' ORDER BY updated_at DESC,id LIMIT 100`,
        [userId],
      ),
    createSession: (userId) =>
      one(
        `INSERT INTO conversations(id,user_id) VALUES($1,$2)
      RETURNING id,title,updated_at`,
        [randomUUID(), userId],
      ),
    session: (userId, id) =>
      isUuid(id)
        ? one(
            'SELECT id,title,summary,summary_through FROM conversations WHERE ' +
              owned,
            [userId, id],
          )
        : undefined,
    async deleteSession(userId, id) {
      return (
        isUuid(id) &&
        (await query('DELETE FROM conversations WHERE ' + owned, [userId, id]))
          .rowCount > 0
      );
    },
    async history(userId, id) {
      if (!isUuid(id)) return [];
      const list = await rows(
        `SELECT m.id,m.role,m.content,m.detail FROM messages m
        JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=$1 AND c.id=$2
        AND c.updated_at>now()-interval '7 days' ORDER BY m.id DESC LIMIT 200`,
        [userId, id],
      );
      return list.reverse().map(({ detail, ...m }) => ({ ...m, ...detail }));
    },
    async addMessage(userId, id, { role, content, ...detail }) {
      const row = await one(
        `WITH touched AS (
        UPDATE conversations SET updated_at=now(),
        title=CASE WHEN title='Новый диалог' AND $3='user' THEN left($4,80) ELSE title END
        WHERE ` +
          owned +
          ` RETURNING id)
        INSERT INTO messages(conversation_id,role,content,detail)
        SELECT id,$3,$4,$5::jsonb FROM touched RETURNING id`,
        [userId, id, role, content, JSON.stringify(detail)],
      );
      if (!row) throw new Error('Диалог недоступен.');
      return row.id;
    },
    updateSummary: (userId, id, summary, through) =>
      query(
        'UPDATE conversations SET summary=$3,summary_through=$4 WHERE ' +
          owned +
          ' AND summary_through<$4',
        [userId, id, summary, through],
      ),
    async updateSchedule(userId, id, messageId, schedule) {
      const saved = await query(
        `UPDATE messages m SET detail=jsonb_set(detail,'{schedule}',$4::jsonb)
        FROM conversations c WHERE c.user_id=$1 AND c.id=$2 AND m.conversation_id=c.id
        AND m.id=$3 AND m.role='assistant' AND m.detail ? 'schedule'
        AND c.updated_at>now()-interval '7 days'`,
        [userId, id, messageId, JSON.stringify(schedule)],
      );
      return saved.rowCount > 0;
    },
    facts: (userId) =>
      rows(
        'SELECT key,value FROM facts WHERE user_id=$1 AND expires_at>now() ORDER BY key',
        [userId],
      ),
    async propose(userId, sessionId, { key, value }) {
      const id = randomUUID();
      await query(
        `INSERT INTO confirmations(conversation_id,user_id,id,action,value)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(conversation_id) DO UPDATE SET
          id=excluded.id,action=excluded.action,value=excluded.value,expires_at=excluded.expires_at`,
        [sessionId, userId, id, key, value],
      );
      return id;
    },
    cancel: (userId, id) =>
      query(
        'DELETE FROM confirmations WHERE user_id=$1 AND conversation_id=$2',
        [userId, id],
      ),
    async confirm(userId, sessionId, confirmationId) {
      if (!isUuid(confirmationId)) return;
      return transaction(async (c) => {
        const result = await c.query(
          `DELETE FROM confirmations
          WHERE user_id=$1 AND conversation_id=$2 AND id=$3 AND expires_at>now()
          RETURNING action,value`,
          [userId, sessionId, confirmationId],
        );
        const pending = result.rows[0];
        if (!pending) return;
        if (pending.action === 'forget') {
          await c.query('DELETE FROM conversations WHERE user_id=$1', [userId]);
          await c.query('DELETE FROM facts WHERE user_id=$1', [userId]);
        } else {
          await c.query(
            `INSERT INTO facts(user_id,key,value,expires_at)
            VALUES($1,$2,$3,now()+interval '180 days')
            ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at`,
            [userId, pending.action, pending.value],
          );
        }
        return pending;
      });
    },
    async reserveRefresh(userId, now = new Date()) {
      const result = await query(
        `INSERT INTO manual_refreshes(user_id,refreshed_on) VALUES($1,$2)
        ON CONFLICT(user_id) DO UPDATE SET refreshed_on=excluded.refreshed_on
        WHERE manual_refreshes.refreshed_on<excluded.refreshed_on`,
        [userId, moscowDay.format(now)],
      );
      return result.rowCount > 0;
    },
  };
}
