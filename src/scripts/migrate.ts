import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/core';
import config from '../../mikro-orm.config';

async function migrate(): Promise<void> {
  const orm = await MikroORM.init(config);
  try {
    const migrator = orm.getMigrator();
    if (process.argv[2] === 'down') await migrator.down();
    else await migrator.up();
  } finally {
    await orm.close(true);
  }
}

void migrate().catch((error: unknown) => {
  console.error(JSON.stringify({
    level: 'error',
    message: 'Database migration failed',
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
