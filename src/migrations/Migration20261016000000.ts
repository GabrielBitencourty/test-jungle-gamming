import { Migration } from '@mikro-orm/migrations';

export class Migration20261016000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY,
        player_id uuid NOT NULL,
        currency char(3) NOT NULL,
        balance numeric(20, 2) NOT NULL DEFAULT 0,
        version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency),
        CONSTRAINT wallets_identity_unique UNIQUE (id, player_id, currency),
        CONSTRAINT wallets_id_currency_unique UNIQUE (id, currency),
        CONSTRAINT wallets_balance_nonnegative CHECK (balance >= 0),
        CONSTRAINT wallets_version_positive CHECK (version >= 1)
      );
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY,
        provider_id text NOT NULL,
        external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL,
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL,
        player_id uuid NOT NULL,
        round_id text NOT NULL,
        game_id text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount numeric(20, 2) NOT NULL CHECK (amount >= 0),
        currency char(3) NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id uuid,
        status text NOT NULL CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code text,
        response_balance numeric(20, 2),
        processed_at timestamptz,
        reference_attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT wager_opening_internal CHECK (kind <> 'OPENING' OR provider_id = 'internal'),
        CONSTRAINT wager_reversal_requires_external_reference
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_processed_reversal_requires_resolved_reference
          CHECK (status <> 'PROCESSED' OR kind NOT IN ('REFUND', 'ROLLBACK') OR reference_transaction_id IS NOT NULL),
        CONSTRAINT wager_idempotency_unique UNIQUE (idempotency_key),
        CONSTRAINT wager_provider_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_identity_wallet_unique UNIQUE (id, wallet_id),
        CONSTRAINT wager_reference_wallet_fk FOREIGN KEY (reference_transaction_id, wallet_id)
          REFERENCES wager_transactions(id, wallet_id),
        CONSTRAINT wager_reference_not_self CHECK (reference_transaction_id IS NULL OR reference_transaction_id <> id),
        CONSTRAINT wager_wallet_identity FOREIGN KEY (wallet_id, player_id, currency)
          REFERENCES wallets(id, player_id, currency)
      );
      CREATE INDEX wager_reference_lookup ON wager_transactions(provider_id, external_transaction_id);
      CREATE INDEX wager_pending_reference_due ON wager_transactions(next_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
      CREATE UNIQUE INDEX wager_reference_reversal_unique
        ON wager_transactions(reference_transaction_id, kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
      CREATE TABLE wallet_ledger_entries (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL,
        transaction_id uuid NOT NULL,
        direction text NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount numeric(20, 2) NOT NULL CHECK (amount > 0),
        currency char(3) NOT NULL,
        balance_before numeric(20, 2) NOT NULL,
        balance_after numeric(20, 2) NOT NULL CHECK (balance_after >= 0),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ledger_transaction_wallet_unique UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ledger_wallet_currency_fk FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets(id, currency),
        CONSTRAINT ledger_transaction_wallet_fk FOREIGN KEY (transaction_id, wallet_id)
          REFERENCES wager_transactions(id, wallet_id),
        CONSTRAINT ledger_balance_before_nonnegative CHECK (balance_before >= 0),
        CONSTRAINT ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_before + amount = balance_after) OR
          (direction = 'DEBIT' AND balance_before - amount = balance_after)
        )
      );
      CREATE INDEX wallet_ledger_cursor ON wallet_ledger_entries(wallet_id, created_at DESC, id DESC);
      CREATE TABLE inbox_messages (
        message_id text NOT NULL,
        consumer_name text NOT NULL,
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY,
        aggregate_id uuid NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        published_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX outbox_pending_due ON outbox_messages(next_attempt_at, created_at)
        WHERE published_at IS NULL;
      CREATE TABLE outbox_claims (
        message_id uuid PRIMARY KEY REFERENCES outbox_messages(id) ON DELETE CASCADE,
        locked_until timestamptz NOT NULL
      );
      CREATE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet ledger entries are immutable';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER wallet_ledger_immutable
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      DROP TRIGGER IF EXISTS wallet_ledger_immutable ON wallet_ledger_entries;
      DROP FUNCTION IF EXISTS reject_ledger_mutation();
      DROP TABLE IF EXISTS outbox_claims;
      DROP TABLE IF EXISTS outbox_messages;
      DROP TABLE IF EXISTS inbox_messages;
      DROP TABLE IF EXISTS wallet_ledger_entries;
      DROP TABLE IF EXISTS wager_transactions;
      DROP TABLE IF EXISTS wallets;
    `);
  }
}
