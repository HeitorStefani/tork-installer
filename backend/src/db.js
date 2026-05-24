import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.DATABASE_POOL_SIZE || 10),
});

export async function query(sql, params = []) {
  return pool.query(sql, params);
}

export async function migrate() {
  await query(`
    create table if not exists boards (
      id bigserial primary key,
      account_id integer not null,
      name text not null,
      description text not null default '',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(account_id, name)
    );

    create table if not exists stages (
      id bigserial primary key,
      board_id bigint not null references boards(id) on delete cascade,
      key text not null,
      name text not null,
      subtitle text not null default '',
      color text not null default '#5da7e8',
      position integer not null default 0,
      automation jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(board_id, key)
    );

    create table if not exists cards (
      id bigserial primary key,
      board_id bigint not null references boards(id) on delete cascade,
      stage_id bigint not null references stages(id) on delete restrict,
      account_id integer not null,
      conversation_id bigint not null,
      contact_id bigint,
      contact_name text not null default '',
      contact_phone text not null default '',
      contact_avatar_url text not null default '',
      assigned_agent_name text not null default 'IA',
      assigned_agent_avatar_url text not null default '',
      service text not null default '',
      observation text not null default '',
      tags text[] not null default '{}',
      priority text not null default 'normal',
      follow_up_attempts integer not null default 0,
      appointment_at timestamptz,
      feedback_due_at timestamptz,
      feedback_sent_at timestamptz,
      feedback_attempts integer not null default 0,
      last_message_at timestamptz,
      last_incoming_at timestamptz,
      next_follow_up_at timestamptz,
      metadata jsonb not null default '{}',
      position integer not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(account_id, conversation_id)
    );

    create index if not exists cards_board_stage_idx on cards(board_id, stage_id, position);
    create index if not exists cards_account_stage_updated_idx on cards(account_id, stage_id, updated_at desc, id desc);
    create index if not exists cards_account_conversation_idx on cards(account_id, conversation_id);
    create index if not exists cards_search_idx on cards using gin(to_tsvector('simple', coalesce(contact_name, '') || ' ' || coalesce(contact_phone, '') || ' ' || coalesce(service, '') || ' ' || coalesce(observation, '')));
    create index if not exists cards_follow_up_idx on cards(next_follow_up_at) where next_follow_up_at is not null;
    create index if not exists cards_metadata_idx on cards using gin(metadata);

    create table if not exists card_events (
      id bigserial primary key,
      card_id bigint references cards(id) on delete cascade,
      account_id integer not null,
      conversation_id bigint not null,
      event_type text not null,
      payload jsonb not null default '{}',
      created_at timestamptz not null default now()
    );

    create table if not exists kanban_settings (
      account_id integer primary key,
      follow_up_after_hours numeric not null default 24,
      lost_after_attempts integer not null default 2,
      updated_at timestamptz not null default now()
    );
  `);

  await query(`
    alter table stages
      alter column automation drop default;

    alter table stages
      alter column automation type jsonb using automation::jsonb;

    alter table stages
      alter column automation set default '{}'::jsonb;
  `);

  await query(`
    alter table cards
      add column if not exists appointment_at timestamptz,
      add column if not exists feedback_due_at timestamptz,
      add column if not exists feedback_sent_at timestamptz,
      add column if not exists feedback_attempts integer not null default 0;
  `);

  await query(`
    create index if not exists cards_feedback_due_idx on cards(feedback_due_at) where feedback_due_at is not null and feedback_sent_at is null;
  `);
}

export async function ensureBoardForAccount(
  accountId = config.defaultAccountId,
  boardName = config.defaultBoardName,
) {
  const boardResult = await query(
    `
      insert into boards (account_id, name, description)
      values ($1, $2, 'Pipeline comercial conectado ao Chatwoot')
      on conflict (account_id, name)
      do update set updated_at = now()
      returning *
    `,
    [accountId, boardName],
  );

  const board = boardResult.rows[0];
  const stages = [
    ["novo", "Novo Lead", "Primeiro contato", "#5da7e8", 10, { onIncoming: true }],
    ["qualificado", "Qualificado", "IA coletando informacoes", "#f2c84b", 20, { interest: true }],
    ["agendamento", "Agendamento", "Horario em negociacao", "#9b78e6", 30, { scheduled: true }],
    ["confirmado", "Confirmado", "Paciente confirmou presenca", "#45a96c", 40, { confirmed: true }],
    ["follow-up", "Follow-up", "Sem resposta ha 24h", "#ec725b", 50, { followUpAfterHours: 24 }],
    ["perdido", "Perdido", "Cancelou ou nao respondeu", "#a8a7a5", 60, { lostAfterAttempts: 2 }],
  ];

  for (const [key, name, subtitle, color, position, automation] of stages) {
    await query(
      `
        insert into stages (board_id, key, name, subtitle, color, position, automation)
        values ($1, $2, $3, $4, $5, $6, $7::jsonb)
        on conflict (board_id, key)
        do update set
          name = excluded.name,
          subtitle = excluded.subtitle,
          color = excluded.color,
          position = excluded.position,
          automation = excluded.automation,
          updated_at = now()
      `,
      [board.id, key, name, subtitle, color, position, JSON.stringify(automation)],
    );
  }

  return board;
}

export async function ensureDefaultBoard() {
  return ensureBoardForAccount(config.defaultAccountId, config.defaultBoardName);
}
